import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { formatUnits } from 'viem';

import { repositoryRoot } from '@agent-gateway/gateway';

import type {
  DemoState,
  LoggedDrill,
  LoggedIntent,
  LoggedMandate,
  LoggedTransaction,
} from './demo/context';

// Copies the latest demo run from the gateway's data directory into docs/sepolia-run and writes the
// README that lists its transactions. The copied files are kept exactly as the run wrote them.
//
//   pnpm demo:record                 from apps/gateway/data
//   pnpm demo:record --from <dir>    from another data directory
//   pnpm demo:record --note "..."    add a line of context under the introduction

type RunLog = {
  chainId: number;
  vault: string;
  startedAt: string;
  finishedAt: string;
  steps: string[];
  agent: string | null;
  agentId: string | null;
  mandateId: string | null;
  activeMandateId: string | null;
  mandateValidDays: number;
  names: Record<string, string>;
  addresses: Record<string, string>;
  /** Absent in run logs written before mandates were recorded. */
  mandates?: LoggedMandate[];
  transactions: LoggedTransaction[];
  intents: LoggedIntent[];
  drills: LoggedDrill[];
};

const { values } = parseArgs({
  options: {
    from: { type: 'string', default: join(repositoryRoot, 'apps/gateway/data') },
    to: { type: 'string', default: join(repositoryRoot, 'docs/sepolia-run') },
    /** A sentence or two of context for the reader, placed under the introduction. */
    note: { type: 'string' },
  },
});
const from = values.from;
const to = values.to;

const EXPLORER = 'https://sepolia.arbiscan.io';
const short = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-8)}`;
const tx = (hash: string) => `[\`${short(hash)}\`](${EXPLORER}/tx/${hash})`;
const address = (value: string) => `[\`${value}\`](${EXPLORER}/address/${value})`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Text from the run, made safe for a Markdown table cell. */
const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
const usdc = (amount: string) => {
  const [whole, fraction = ''] = formatUnits(BigInt(amount), 6).split('.');
  return `${whole}.${fraction.padEnd(2, '0')} USDC`;
};

const run = JSON.parse(await readFile(join(from, 'demo-run.json'), 'utf8')) as RunLog;
if (run.chainId !== 421_614) {
  throw new Error(`The run in ${from} is on chain ${run.chainId}, not Arbitrum Sepolia`);
}
const state = JSON.parse(await readFile(join(from, 'demo-state.json'), 'utf8')) as DemoState;
for (const intent of run.intents) {
  if (!existsSync(join(from, 'evidence', `${intent.intentId}.json`))) {
    throw new Error(`The evidence file for intent ${intent.intentId} is missing in ${from}`);
  }
}

// --- Copy the run's files, unchanged ----------------------------------------------------------------

await rm(to, { recursive: true, force: true });
await mkdir(join(to, 'evidence'), { recursive: true });
for (const file of ['demo-run.json', 'ledger.jsonl', 'payees.json']) {
  await cp(join(from, file), join(to, file));
}
for (const intent of run.intents) {
  await cp(
    join(from, 'evidence', `${intent.intentId}.json`),
    join(to, 'evidence', `${intent.intentId}.json`),
  );
}
const mandateFiles = (await readdir(join(from, 'mandates'))).filter((name) =>
  name.endsWith('.txt'),
);
await mkdir(join(to, 'mandates'), { recursive: true });
for (const file of mandateFiles) await cp(join(from, 'mandates', file), join(to, 'mandates', file));

// --- Write the README -------------------------------------------------------------------------------

const drillByTransaction = new Map(run.drills.map((drill) => [drill.transactionHash, drill]));
const errorName = (refusal: string) => /refused: ([A-Za-z]+)/.exec(refusal)?.[1] ?? refusal;

const transactionRows = run.transactions.map((transaction) => {
  const drill = drillByTransaction.get(transaction.transactionHash);
  const what =
    drill === undefined
      ? capital(transaction.label)
      : `${capital(transaction.label)} with \`${errorName(drill.refusal)}\``;
  const result = transaction.status === 'success' ? 'Success' : 'Reverted, as intended';
  return `| ${transaction.step} | ${cell(what)} | ${result} | ${tx(transaction.transactionHash)} |`;
});

const decisionRows = run.intents.map((intent) => {
  const payee = intent.payeeName ?? `an address in no registry (\`${short(intent.payee)}\`)`;
  const why =
    intent.decision === 'auto'
      ? ''
      : `<br>${intent.reasons.map((reason) => cell(reason)).join('<br>')}`;
  return (
    `| ${intent.step} | ${usdc(intent.amount)} to ${cell(payee)} | \`${intent.decision}\`${why} | ${intent.status.replace('_', ' ')} | ` +
    `[\`${short(intent.intentId)}\`](evidence/${intent.intentId}.json) | ${intent.evidenceChecks} |`
  );
});

const drillRows = run.drills.map(
  (drill) =>
    `| ${drill.name} | ${cell(capital(drill.attempt))} | \`${cell(drill.refusal.replace('the vault refused: ', ''))}\` | ${tx(drill.transactionHash)} |`,
);

const roles: [string, string][] = [
  [
    'PRINCIPAL',
    `${run.names.principal ?? 'Principal'}: owns the vault, creates and revokes mandates`,
  ],
  ['EXECUTOR', "The gateway's executor: can only pay inside a mandate"],
  ['APPROVER', 'Approver: signs for payments outside the mandate'],
  ['AGENT', `${run.names.agent ?? 'Agent'}: signs requests, holds no funds`],
  ['SPEND_WALLET', `${run.names.spendWallet ?? 'Spend wallet'}: pays per-call API charges`],
  ['MERCHANT', `${run.names.merchant ?? 'Merchant'}: sells market data per call (MPP)`],
  ['VENDOR_A', `${run.names.vendorA ?? 'Vendor A'}: a vendor on the mandate's allowlist`],
  ['VENDOR_B', `${run.names.vendorB ?? 'Vendor B'}: a vendor on the mandate's allowlist`],
];
const roleRows = roles
  .filter(([role]) => run.addresses[role] !== undefined)
  .map(([role, what]) => `| ${cell(what)} | ${address(run.addresses[role] as string)} |`);

const date = run.startedAt.slice(0, 10);
const reverted = run.transactions.filter((transaction) => transaction.status === 'reverted').length;
const firstPaid = run.intents.find((intent) => intent.status === 'paid');
const termsHash =
  run.mandates?.find((mandate) => mandate.mandateId === run.mandateId)?.termsHash ??
  (state.mandateId === run.mandateId ? state.termsHash : null);
const reissued =
  run.activeMandateId !== null && run.activeMandateId !== run.mandateId
    ? ` After the demo the principal issued mandate ${run.activeMandateId}, valid for ${run.mandateValidDays} days, so the vault has an active mandate.`
    : '';

const readme = `# A recorded run on Arbitrum Sepolia

The demo path, run with \`pnpm demo\` on ${date} (UTC) against the deployed
[\`MandateVault\`](${EXPLORER}/address/${run.vault}#code). Steps: ${run.steps.join(', ')}.
The agent was the **${run.agent ?? 'none'}**. The files in this folder are kept exactly as the run wrote them.
All company and vendor names are fictional. This is a testnet demo.
${values.note === undefined ? '' : `\n${values.note}\n`}
${run.transactions.length} transactions: ${run.transactions.length - reverted} succeeded and ${reverted} reverted. The reverts are the point of step 6.

| Step | What happened | Result | Transaction |
| ---- | ------------- | ------ | ----------- |
${transactionRows.join('\n')}

The agent is ERC-8004 agent ${run.agentId} in the Identity Registry on Arbitrum Sepolia. The demo ran under
mandate ${run.mandateId} in the vault: 2 USDC per payment, 8 USDC per UTC day, hard ceiling 20 USDC.${reissued}

## What the gateway decided

Every request the agent signed, and what became of it. Each has an evidence file whose hash is in the
vault's event when a payment was made.

| Step | Request | Decision | Result | Evidence | Checks passed |
| ---- | ------- | -------- | ------ | -------- | ------------- |
${decisionRows.join('\n')}

A market-data purchase shows up as two transactions: the vault pays the gateway's spend wallet exactly
the price, inside the mandate, and the merchant then settles the spend wallet's signed payment.
${
  drillRows.length === 0
    ? ''
    : `
## "Gateway compromised" drills

The executor key is the key the gateway holds. Here it is used directly, without the gateway. Each
attempt was sent as a real transaction, so the vault's refusal is on the public record.

| Drill | Attempt | The vault's answer | Transaction |
| ----- | ------- | ------------------ | ----------- |
${drillRows.join('\n')}
`
}
## Who is who

| Role | Address |
| ---- | ------- |
${roleRows.join('\n')}

## Check it yourself

No keys are needed. This reads an evidence file, recomputes its hash, checks the signatures and
compares the record with the vault's event onchain:

\`\`\`bash
pnpm verify-evidence docs/sepolia-run/evidence/${(firstPaid ?? run.intents[0])?.intentId ?? '<intent id>'}.json
\`\`\`

It should end with \`VERIFIED\`. Add \`--offline\` to skip the chain. The same works for every file in
\`evidence/\`.
${
  termsHash === null
    ? ''
    : `
To check the mandate text against the chain, hash the file and compare it with the mandate's \`termsHash\`:

\`\`\`bash
cast keccak "0x$(xxd -p -c 100000 docs/sepolia-run/mandates/${termsHash}.txt)"
cast call ${run.vault} "getMandate(uint256)((uint256,address,uint64,bool,address,uint256,uint256,uint256,uint256,bytes32,address[]))" ${run.mandateId} \\
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc
\`\`\`
`
}
## Files

| File | What it is |
| ---- | ---------- |
| \`demo-run.json\` | The transactions, decisions and drills above, as the demo recorded them. |
| \`evidence/\` | One evidence file per request: who asked, what for, every check, the decision and the result. |
| \`ledger.jsonl\` | The gateway's hash-chained ledger for this run. |
| \`mandates/\` | The plain-text mandate the principal approved. Its keccak256 hash is the mandate's \`termsHash\`. |
| \`payees.json\` | The principal's vendor registry the gateway used. |
`;

await writeFile(join(to, 'README.md'), readme, 'utf8');
console.log(
  `Recorded ${run.transactions.length} transactions, ${run.intents.length} decisions and ${run.drills.length} drills in ${to}`,
);
