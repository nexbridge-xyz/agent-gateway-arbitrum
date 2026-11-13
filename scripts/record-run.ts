import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import * as prettier from 'prettier';
import { formatUnits } from 'viem';

import { repositoryRoot } from '@agent-gateway/gateway';

import type {
  ApprovalOutcome,
  DemoState,
  LoggedDrill,
  LoggedIntent,
  LoggedMandate,
  LoggedTransaction,
  MandateKind,
  PlantedNoteOutcome,
  TransactionTag,
} from './demo/context';

// Copies the latest demo run from the gateway's data directory into docs/sepolia-run, writes the
// README that lists its transactions, and rewrites the demo table in the repository's README, so that
// both say exactly what happened in that run. The copied files are kept as the run wrote them.
//
//   pnpm demo:record                 from apps/gateway/data
//   pnpm demo:record --from <dir>    from another data directory
//   pnpm demo:record --note "..."    add a line of context under the introduction

type Caps = { perPaymentCap: string; dailyCap: string; hardCeiling: string };

type RunLog = {
  chainId: number;
  vault: string;
  startedAt: string;
  finishedAt: string;
  steps: string[];
  completed: boolean;
  stoppedBecause?: string;
  agent: string | null;
  agentId: string | null;
  demoMandates: Record<MandateKind, string | null>;
  mandatesAtEnd: Record<MandateKind, string | null>;
  mandateValidDays: number;
  mandateCaps: Record<MandateKind, Caps>;
  names: Record<string, string>;
  addresses: Record<string, string>;
  mandates: LoggedMandate[];
  transactions: LoggedTransaction[];
  intents: LoggedIntent[];
  drills: LoggedDrill[];
  plantedNote: PlantedNoteOutcome | null;
  /** Absent in run logs written before the console existed: the approver's key signed in the terminal. */
  approval?: ApprovalOutcome | null;
};

const { values } = parseArgs({
  options: {
    from: { type: 'string', default: join(repositoryRoot, 'apps/gateway/data') },
    to: { type: 'string', default: join(repositoryRoot, 'docs/sepolia-run') },
    /** The README whose demo table is rewritten. Pass an empty value to leave it alone. */
    readme: { type: 'string', default: join(repositoryRoot, 'README.md') },
    /** A sentence or two of context for the reader, placed under the introduction. */
    note: { type: 'string' },
  },
});
const from = values.from;
const to = values.to;

const EXPLORER = 'https://sepolia.arbiscan.io';
const KINDS: MandateKind[] = ['vendors', 'spend wallet'];
const short = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-8)}`;
const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
const tx = (hash: string) => `[\`${short(hash)}\`](${txUrl(hash)})`;
const address = (value: string) => `[\`${value}\`](${EXPLORER}/address/${value})`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Text from the run, made safe for a Markdown table cell. */
const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
const usdc = (amount: string) => {
  const [whole, fraction = ''] = formatUnits(BigInt(amount), 6).split('.');
  return `${whole}.${fraction.padEnd(2, '0')} USDC`;
};
/** A cap as written in the mandate, with two decimals: "0.5" becomes "0.50". */
const cap = (value: string) =>
  value.includes('.') ? value.padEnd(value.indexOf('.') + 3, '0') : value;
const errorName = (refusal: string) => /refused: ([A-Za-z]+)/.exec(refusal)?.[1] ?? refusal;

const run = JSON.parse(await readFile(join(from, 'demo-run.json'), 'utf8')) as RunLog;
if (run.chainId !== 421_614) {
  throw new Error(`The run in ${from} is on chain ${run.chainId}, not Arbitrum Sepolia`);
}
if (!run.completed) {
  throw new Error(
    `The run in ${from} stopped early (${run.stoppedBecause ?? 'no reason recorded'}). Only a complete run is recorded.`,
  );
}
if (run.approval?.result === 'declined') {
  throw new Error(
    `In the run in ${from} the approver declined the payment of step 4. Record a run in which the approval was signed.`,
  );
}
for (const intent of run.intents) {
  if (!existsSync(join(from, 'evidence', `${intent.intentId}.json`))) {
    throw new Error(`The evidence file for intent ${intent.intentId} is missing in ${from}`);
  }
}
for (const mandate of run.mandates) {
  if (!existsSync(join(from, 'mandates', `${mandate.termsHash}.txt`))) {
    throw new Error(`The text of mandate ${mandate.mandateId} is missing in ${from}`);
  }
}

// --- Copy the run's files, unchanged ----------------------------------------------------------------

await rm(to, { recursive: true, force: true });
await mkdir(join(to, 'evidence'), { recursive: true });
await mkdir(join(to, 'mandates'), { recursive: true });
for (const file of ['demo-run.json', 'ledger.jsonl', 'payees.json']) {
  await cp(join(from, file), join(to, file));
}
for (const intent of run.intents) {
  const file = join('evidence', `${intent.intentId}.json`);
  await cp(join(from, file), join(to, file));
}
for (const mandate of run.mandates) {
  const file = join('mandates', `${mandate.termsHash}.txt`);
  await cp(join(from, file), join(to, file));
}

// --- What happened, in words ------------------------------------------------------------------------

const agent = run.agent ?? 'no agent';
const date = run.startedAt.slice(0, 10);
const reverted = run.transactions.filter((transaction) => transaction.status === 'reverted').length;
const succeeded = run.transactions.length - reverted;
const tagged = (step: string, tag: TransactionTag) =>
  run.transactions.filter((transaction) => transaction.step === step && transaction.tag === tag);
const demoMandate = (kind: MandateKind) =>
  run.mandates.find(
    (mandate) => mandate.kind === kind && mandate.mandateId === run.demoMandates[kind],
  );
const capsInWords = (kind: MandateKind) => {
  const caps = run.mandateCaps[kind];
  return `${cap(caps.perPaymentCap)} USDC per payment, ${cap(caps.dailyCap)} per UTC day, hard ceiling ${cap(caps.hardCeiling)}`;
};

// Step 1, said exactly. The vault may already hold the demo's funds, and an agent is registered once:
// a later run finds it in the registry and registers nothing. The labels are the runner's own.
const stepOne = run.transactions.filter((transaction) => transaction.step === '1');
const fundedInRun = stepOne.some((transaction) =>
  transaction.label.startsWith('principal deposits'),
);
const registeredInRun = stepOne.find((transaction) =>
  transaction.label.startsWith('principal registers the agent'),
);

/** The transaction of an earlier run that registered this agent, if the runner's state file has it. */
async function earlierRegistration(): Promise<string | null> {
  try {
    const state = JSON.parse(
      await readFile(join(from, 'demo-state.json'), 'utf8'),
    ) as Partial<DemoState>;
    const hash = state.agentId === run.agentId ? state.registrationTx : null;
    return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}
const registeredBefore = registeredInRun === undefined ? await earlierRegistration() : null;
const registrationSentence =
  registeredInRun !== undefined
    ? `It was registered in step 1 of this run (${tx(registeredInRun.transactionHash)}).`
    : registeredBefore === null
      ? 'It was registered before this run.'
      : `It was registered before this run (${tx(registeredBefore)}).`;

/** Step 5, said exactly: who sent the request that the gateway refused. */
const noteSentence = (note: PlantedNoteOutcome) =>
  note.agentActedOnNote
    ? `The agent (${note.agent}) acted on the note and asked the gateway for the payment itself. The gateway refused it.`
    : `The agent (${note.agent}) ignored the note and made no payment request. The runner then sent the request the note asks for, signed with the agent's key, as if the agent had been fooled. The gateway refused it.`;

// --- docs/sepolia-run/README.md ---------------------------------------------------------------------

const drillByTransaction = new Map(run.drills.map((drill) => [drill.transactionHash, drill]));

const transactionRows = run.transactions.map((transaction) => {
  const drill = drillByTransaction.get(transaction.transactionHash);
  const what =
    drill === undefined
      ? capital(transaction.label)
      : `${capital(transaction.label)} with \`${errorName(drill.refusal)}\``;
  const result = transaction.status === 'success' ? 'Success' : 'Reverted, as intended';
  return `| ${transaction.step} | ${cell(what)} | ${result} | ${tx(transaction.transactionHash)} |`;
});

const mandateRows = KINDS.map((kind) => {
  const mandate = demoMandate(kind);
  const id = run.demoMandates[kind] ?? 'none';
  const what =
    kind === 'vendors'
      ? `Vendor invoices: ${run.names.vendorA ?? 'vendor A'} and ${run.names.vendorB ?? 'vendor B'}`
      : `Funding the gateway's spend wallet, for per-call purchases`;
  const terms =
    mandate === undefined
      ? 'created in an earlier run'
      : `[\`${short(mandate.termsHash)}\`](mandates/${mandate.termsHash}.txt)`;
  return `| ${id} | ${what} | ${capsInWords(kind)} | ${terms} |`;
});

const decisionRows = run.intents.map((intent) => {
  const payee = intent.payeeName ?? `an address in no registry (\`${short(intent.payee)}\`)`;
  const why =
    intent.decision === 'auto'
      ? ''
      : `<br>${intent.reasons.map((reason) => cell(reason)).join('<br>')}`;
  const sender = intent.sentBy === 'agent' ? 'the agent' : 'the runner, as a fooled agent would';
  return (
    `| ${intent.step} | ${usdc(intent.amount)} to ${cell(payee)} | ${sender} | ${intent.mandateId ?? 'none'} | \`${intent.decision}\`${why} | ${intent.status.replace('_', ' ')} | ` +
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
  ['APPROVER', 'Approver: signs for payments outside a mandate'],
  ['AGENT', `${run.names.agent ?? 'Agent'}: signs requests, holds no funds`],
  ['SPEND_WALLET', `${run.names.spendWallet ?? 'Spend wallet'}: pays per-call API charges`],
  ['MERCHANT', `${run.names.merchant ?? 'Merchant'}: sells market data per call (MPP)`],
  ['VENDOR_A', `${run.names.vendorA ?? 'Vendor A'}: a vendor on the vendor mandate's allowlist`],
  ['VENDOR_B', `${run.names.vendorB ?? 'Vendor B'}: a vendor on the vendor mandate's allowlist`],
];
const roleRows = roles
  .filter(([role]) => run.addresses[role] !== undefined)
  .map(([role, what]) => `| ${cell(what)} | ${address(run.addresses[role] as string)} |`);

const firstPaid = run.intents.find((intent) => intent.status === 'paid');
const reissued = KINDS.filter(
  (kind) => run.mandatesAtEnd[kind] !== null && run.mandatesAtEnd[kind] !== run.demoMandates[kind],
);
const reissuedSentence =
  reissued.length === 0
    ? ''
    : `\n\nAfter the demo the principal issued new mandates, valid for ${run.mandateValidDays} days, so the agent has active ones: ${reissued
        .map((kind) => `mandate ${run.mandatesAtEnd[kind]} (${kind})`)
        .join(' and ')}.`;

const mandateChecks = KINDS.map((kind) => demoMandate(kind))
  .filter((mandate): mandate is LoggedMandate => mandate !== undefined)
  .map(
    // The mandate's name stands in the text, not as a comment in the block: an interactive zsh does
    // not know comments, and would take one for a command.
    (mandate) => `Mandate ${mandate.mandateId} (${mandate.kind}):

\`\`\`bash
cast keccak "0x$(xxd -p -c 100000 docs/sepolia-run/mandates/${mandate.termsHash}.txt)"
cast call ${run.vault} "getMandate(uint256)((uint256,address,uint64,bool,address,uint256,uint256,uint256,uint256,bytes32,address[]))" ${mandate.mandateId} \\
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc
\`\`\``,
  );

const runReadme = `# A recorded run on Arbitrum Sepolia

The demo path, run with \`pnpm demo\` on ${date} (UTC) against the deployed
[\`MandateVault\`](${EXPLORER}/address/${run.vault}#code). Steps: ${run.steps.join(', ')}.
The agent was the **${agent}**. The files in this folder are kept exactly as the run wrote them.
All company and vendor names are fictional. This is a testnet demo.
${values.note === undefined ? '' : `\n${values.note}\n`}
${run.transactions.length} transactions: ${succeeded} succeeded and ${reverted} reverted. The reverts are the point of step 6.

| Step | What happened | Result | Transaction |
| ---- | ------------- | ------ | ----------- |
${transactionRows.join('\n')}

## The agent and its two mandates

The agent is ERC-8004 agent ${run.agentId} in the Identity Registry on Arbitrum Sepolia.
${registrationSentence} It holds two mandates in the vault. The spend wallet has a small one of its own and
is not on the vendor mandate's list, so the vault itself limits what can reach it.

| Mandate | For | Limits | Text the principal approved |
| ------- | --- | ------ | --------------------------- |
${mandateRows.join('\n')}${reissuedSentence}

## What the gateway decided

Every request, and what became of it. Each has an evidence file. When the vault paid, the vault's event
carries the hash of that file's record.

| Step | Request | Sent by | Mandate | Decision | Result | Evidence | Evidence checks passed |
| ---- | ------- | ------- | ------- | -------- | ------ | -------- | ---------------------- |
${decisionRows.join('\n')}

The last column counts the checks of \`pnpm verify-evidence\` on the evidence file, as the demo made them
when the run was recorded: the file against itself, the chain and the ledger. A later version of the
verifier may make more. They are not the gateway's checks on the request, which are in each file under
\`record.why.checks\`.

A market-data purchase is two transactions. First the vault pays the gateway's spend wallet exactly the
price, inside the spend wallet's mandate: that payment carries the evidence hash onchain. Then the merchant
settles the spend wallet's signed payment: that is a plain USDC transfer and does not carry the hash. The
evidence file names the settlement, and \`pnpm verify-evidence\` checks it.
${
  run.plantedNote === null
    ? ''
    : `
### Step 5, exactly

A vendor note planted in a market-data response asked for 4 USDC to \`${run.plantedNote.address}\`, an address
nobody had approved. ${noteSentence(run.plantedNote)} Nothing was paid.
`
}${
  drillRows.length === 0
    ? ''
    : `
## "Gateway compromised" drills

The executor key is the key the gateway pays with. Here it is used directly, without the gateway. Each
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
  mandateChecks.length === 0
    ? ''
    : `
To check a mandate's text against the chain, hash the file and compare it with the mandate's \`termsHash\`.

${mandateChecks.join('\n\n')}
`
}
## Files

| File | What it is |
| ---- | ---------- |
| \`demo-run.json\` | The transactions, decisions and drills above, as the demo recorded them. |
| \`evidence/\` | One evidence file per request: who asked, what for, every check, the decision and the result. |
| \`ledger.jsonl\` | The gateway's hash-chained ledger for this run. |
| \`mandates/\` | The plain-text mandates the principal approved. The keccak256 hash of each is its mandate's \`termsHash\`. |
| \`payees.json\` | The principal's vendor registry the gateway used. |
`;

await writeFile(join(to, 'README.md'), runReadme, 'utf8');
console.log(
  `Recorded ${run.transactions.length} transactions, ${run.intents.length} decisions and ${run.drills.length} drills in ${to}`,
);

// --- The demo table in the repository's README ------------------------------------------------------

const START = '<!-- demo-run:start -->';
const END = '<!-- demo-run:end -->';
const link = (text: string, transaction: LoggedTransaction | undefined) =>
  transaction === undefined ? null : `[${text}](${txUrl(transaction.transactionHash)})`;
const links = (items: (string | null)[]) => items.filter((item) => item !== null).join(', ');
/** "a", "a and b", "a, b and c". */
const inWords = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** The seven steps as one table. Null if the run did not go through all of them. */
function demoTable(): string | null {
  const wanted = ['1', '2', '3', '4', '5', '6', '7'];
  if (!wanted.every((step) => run.steps.includes(step)) || run.plantedNote === null) return null;
  const note = run.plantedNote;
  const refusal = run.intents.find((intent) => intent.intentId === note.intentId);
  const created = (kind: MandateKind) => {
    const mandate = demoMandate(kind);
    return mandate === undefined
      ? null
      : `[${kind === 'vendors' ? 'vendor mandate' : 'spend wallet mandate'}](${txUrl(mandate.transactionHash)})`;
  };
  const revoked = tagged('7', 'mandate-revoked').map((transaction) =>
    link(
      transaction.label.includes('spend wallet')
        ? 'spend wallet mandate revoked'
        : 'vendor mandate revoked',
      transaction,
    ),
  );
  const drillLinks = run.drills.map(
    (drill) => `[\`${errorName(drill.refusal)}\`](${txUrl(drill.transactionHash)})`,
  );

  const setUp = [
    ...(fundedInRun ? ['funds the vault'] : []),
    ...(registeredInRun === undefined
      ? []
      : ['registers the agent in the ERC-8004 Identity Registry']),
    `creates ${registeredInRun === undefined ? "the agent's" : 'its'} two mandates: one for vendor invoices (${capsInWords('vendors')}) and a small one that only funds the gateway's spend wallet (${capsInWords('spend wallet')})`,
  ];
  const rows: [string, string, string][] = [
    [
      '1',
      `The principal ${inWords(setUp)}.${registeredInRun === undefined ? ' The agent was registered in the ERC-8004 Identity Registry before this run.' : ''}`,
      links([
        link('agent registered', registeredInRun),
        registeredBefore === null
          ? null
          : `[agent registered, earlier](${txUrl(registeredBefore)})`,
        created('vendors'),
        created('spend wallet'),
      ]),
    ],
    [
      '2',
      'The agent buys market data over MPP for 0.10 USDC. The gateway decides `auto`: the vault funds the spend wallet with exactly the price, and the spend wallet pays the merchant.',
      links([
        link('funded from the vault', tagged('2', 'purchase-funded')[0]),
        link('settled by the merchant', tagged('2', 'purchase-settled')[0]),
      ]),
    ],
    [
      '3',
      'The agent asks to pay a known vendor 1.50 USDC. The gateway decides `auto` and pays through the vault.',
      links([link('paid', tagged('3', 'paid')[0])]),
    ],
    [
      '4',
      `The agent asks to pay a 6 USDC invoice, above the per-payment cap. The gateway decides \`needs_approval\`. ${
        run.approval?.by === 'console'
          ? 'The approver signs in the console with a wallet (EIP-712)'
          : "The approver's key signs in the terminal (EIP-712)"
      }, and the vault checks that signature before paying.`,
      links([link('paid with approval', tagged('4', 'paid-with-approval')[0])]),
    ],
    [
      '5',
      `A vendor note planted in a market-data response asks for 4 USDC to an unknown address. ${noteSentence(note)}`,
      refusal === undefined
        ? 'no transaction'
        : `no transaction; [evidence](docs/sepolia-run/evidence/${refusal.intentId}.json)`,
    ],
    [
      '6',
      '"Gateway compromised" drills. The executor key is used directly, without the gateway: to an unlisted address, to a listed vendor above the cap, and with an approval it signed itself.',
      `reverted by the vault: ${drillLinks.join(', ')}`,
    ],
    [
      '7',
      "The principal revokes the agent's mandates. The agent's next request is refused.",
      links(revoked),
    ],
  ];

  const approved = run.intents.find((intent) => intent.step === '4' && intent.status === 'paid');
  return `This is the run recorded in [\`docs/sepolia-run\`](docs/sepolia-run/README.md), made on ${date} (UTC) with the
**${agent}**: ${run.transactions.length} transactions, of which ${succeeded} succeeded and ${reverted} reverted. The reverts are the
point of step 6.

| Step | What happened | Onchain |
| ---- | ------------- | ------- |
${rows.map(([step, what, onchain]) => `| ${step} | ${cell(what)} | ${onchain} |`).join('\n')}

Anyone can check the evidence against the chain, without keys.${
    approved === undefined
      ? ''
      : ` For example, the approved payment of
step 4:

\`\`\`bash
pnpm verify-evidence docs/sepolia-run/evidence/${approved.intentId}.json
\`\`\``
  }`;
}

const GAS_START = '<!-- demo-gas:start -->';
const GAS_END = '<!-- demo-gas:end -->';

/** Gas and fees of the run, for the README. Null for a run log without them, or without the two payments. */
function gasParagraph(): string | null {
  const payment = tagged('3', 'paid')[0];
  const settlement = tagged('2', 'purchase-settled')[0];
  if (payment?.gasUsed === undefined || settlement?.gasUsed === undefined) return null;
  let fees = 0n;
  for (const transaction of run.transactions) {
    if (transaction.feeWei === undefined) return null;
    fees += BigInt(transaction.feeWei);
  }
  const thousands = (gas: string) =>
    (Math.round(Number(gas) / 1000) * 1000).toLocaleString('en-US');
  // Six decimals of ETH are enough for testnet fees and keep the figure readable.
  const eth = Number(formatUnits(fees, 18)).toFixed(6);
  return `In the recorded run a payment through the vault used about ${thousands(payment.gasUsed)} gas, and the merchant's
settlement of a per-call purchase about ${thousands(settlement.gasUsed)}. All ${run.transactions.length} transactions together paid ${eth} ETH in
fees on Arbitrum Sepolia. Testnet fees are not mainnet fees. The execution gas is the same; on Arbitrum
One a transaction's gas also includes a share for posting its data to Ethereum, which was zero in this run.`;
}

/** Replaces what stands between two markers. Returns null if the markers are not there. */
function between(text: string, start: string, end: string, content: string): string | null {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) return null;
  return `${text.slice(0, from + start.length)}\n\n${content}\n\n${text.slice(to)}`;
}

if (values.readme !== '') {
  const table = demoTable();
  let readme = await readFile(values.readme, 'utf8');
  if (table === null) {
    console.log('The run did not go through steps 1 to 7, so the README was left as it is.');
  } else {
    const withTable = between(readme, START, END, table);
    if (withTable === null) {
      console.log(`No ${START} … ${END} block in ${values.readme}, so it was left as it is.`);
    } else {
      readme = withTable;
      console.log(`Rewrote the demo table in ${values.readme}`);

      const gas = gasParagraph();
      const withGas = gas === null ? null : between(readme, GAS_START, GAS_END, gas);
      if (withGas === null) {
        console.log('The gas figures in the README were left as they are.');
      } else {
        readme = withGas;
        console.log(`Rewrote the gas figures in ${values.readme}`);
      }

      const options = await prettier.resolveConfig(values.readme);
      await writeFile(
        values.readme,
        await prettier.format(readme, { ...options, filepath: values.readme }),
        'utf8',
      );
    }
  }
}
