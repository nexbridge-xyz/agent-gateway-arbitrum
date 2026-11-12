import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { BaseError } from 'viem';

import { repositoryRoot } from '@agent-gateway/gateway';

import { type Context, createContext } from './demo/context';
import {
  MANDATES,
  approval,
  buyData,
  drill,
  gas,
  payVendor,
  plantedNote,
  recycle,
  reissue,
  revoke,
  setup,
} from './demo/steps';

const USAGE = `Runs the Agent Gateway demo on Arbitrum Sepolia and prints an Arbiscan link for every transaction.

  pnpm demo                       the whole path: gas, then steps 1 to 7
  pnpm demo --steps 1,3           chosen steps
  pnpm demo --fresh               revoke the agent's current mandates first and create new ones
  pnpm demo --valid-days 90       how long new mandates are valid (default 30)
  pnpm demo --reissue             after step 7, issue new mandates, so the agent has active ones
  pnpm demo --steps recycle       send the payees' test USDC back to the principal

Steps:
  gas      share testnet ETH from the deployer with the roles that send transactions
  1        fund the vault, register the agent (ERC-8004), create its two mandates:
           one for vendor invoices, a small one that only funds the gateway's spend wallet
  2        the agent buys market data over MPP                    -> paid inside the spend wallet mandate
  3        the agent pays a known vendor                          -> paid inside the vendor mandate
  4        an invoice above the cap                               -> approver signs -> paid
  5        a planted vendor note asks for money                   -> refused
  6        "gateway compromised" drills with the executor key     -> the vault reverts, three times
  7        the principal revokes the mandates                     -> the next request is refused

With ANTHROPIC_API_KEY in .env the agent is Claude. Without it, the scripted agent runs.`;

const STEPS: Record<string, (context: Context) => Promise<void>> = {
  gas,
  '1': setup,
  '2': buyData,
  '3': payVendor,
  '4': approval,
  '5': plantedNote,
  '6': drill,
  '7': revoke,
  reissue,
  recycle,
};

const { values } = parseArgs({
  options: {
    steps: { type: 'string', default: 'gas,1,2,3,4,5,6,7' },
    'env-file': { type: 'string', default: join(repositoryRoot, '.env') },
    fresh: { type: 'boolean', default: false },
    'valid-days': { type: 'string', default: '30' },
    reissue: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const names = values.steps.split(',').map((name) => name.trim());
if (values.reissue && !names.includes('reissue')) names.push('reissue');
const unknown = names.filter((name) => !(name in STEPS));
if (unknown.length > 0) {
  console.error(`Unknown step: ${unknown.join(', ')}. Available: ${Object.keys(STEPS).join(', ')}`);
  process.exit(2);
}
const validDays = Number(values['valid-days']);
if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) {
  console.error('--valid-days must be a whole number of days from 1 to 365');
  process.exit(2);
}

/** What stopped the run, in one line. A chain error from viem comes with pages of detail. */
const reasonOf = (error: unknown) =>
  error instanceof BaseError
    ? error.shortMessage
    : error instanceof Error
      ? error.message
      : String(error);

let context: Context | null = null;
let failed = false;
try {
  context = await createContext(values['env-file'], { fresh: values.fresh, validDays });
  const { accounts, info, log, transactions, intents, drills, runtime, readState } = context;
  const startedAt = new Date().toISOString();

  log(`Agent Gateway demo on Arbitrum Sepolia (${info.chainId})`);
  log(`  vault      ${info.vault}`);
  log(`  settings   ${context.shown(values['env-file'])}`);
  log(`  principal  ${accounts.PRINCIPAL.address}`);
  log(`  executor   ${accounts.EXECUTOR.address}  (the gateway's capped role)`);
  log(`  approver   ${accounts.APPROVER.address}`);
  log(`  agent      ${accounts.AGENT.address}  (signs requests only)`);
  log(`  spend      ${accounts.SPEND_WALLET.address}  (pays per-call API charges)`);
  log(`  merchant   ${accounts.MERCHANT.address}  (${context.merchantUrl})`);
  log('  All company and vendor names are fictional. Testnet only.');

  // The mandates the demo runs under: the ones step 1 leaves behind.
  const mandatesOf = async () => {
    const { mandateId, spendMandateId } = await readState();
    return { vendors: mandateId, 'spend wallet': spendMandateId };
  };
  let demoMandates = await mandatesOf();
  const done: string[] = [];
  let stoppedBecause: string | null = null;
  try {
    for (const name of names) {
      log();
      await (STEPS[name] as (typeof STEPS)[string])(context);
      if (name === '1') demoMandates = await mandatesOf();
      done.push(name);
    }
  } catch (error) {
    stoppedBecause = reasonOf(error);
    failed = true;
  }

  log();
  log(
    `${stoppedBecause === null ? 'Done.' : 'Stopped early.'} ${transactions.length} transactions:`,
  );
  for (const transaction of transactions) {
    log(
      `  ${transaction.step.padEnd(4)} ${transaction.status === 'success' ? 'ok      ' : 'reverted'} ${transaction.url}`,
    );
  }

  // The run log is written even when a step failed, so that no transaction goes unrecorded.
  await mkdir(runtime.config.dataDir, { recursive: true });
  const runFile = join(runtime.config.dataDir, 'demo-run.json');
  await writeFile(
    runFile,
    `${JSON.stringify(
      {
        chainId: info.chainId,
        vault: info.vault,
        startedAt,
        finishedAt: new Date().toISOString(),
        /** The steps that ran to their end. */
        steps: done,
        completed: stoppedBecause === null,
        ...(stoppedBecause === null ? {} : { stoppedBecause }),
        agent: await context.agentLabel(),
        agentId: (await readState()).agentId,
        /** The mandates the demo ran under: one for vendor invoices, a small one for the spend wallet. */
        demoMandates,
        /** They differ from the above when new mandates were issued after the demo revoked its own. */
        mandatesAtEnd: await mandatesOf(),
        mandateValidDays: validDays,
        mandateCaps: MANDATES,
        names: context.names,
        addresses: Object.fromEntries(
          Object.entries(accounts).map(([role, account]) => [role, account.address]),
        ),
        mandates: context.mandates,
        transactions,
        intents,
        drills,
        plantedNote: context.outcome.plantedNote,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  log(`Run log: ${context.shown(runFile)}`);
  if (stoppedBecause !== null) {
    console.error('');
    console.error(`Demo stopped: ${stoppedBecause}`);
  }
} catch (error) {
  failed = true;
  console.error('');
  console.error(`Demo stopped: ${reasonOf(error)}`);
} finally {
  await context?.stop();
}
process.exit(failed ? 1 : 0);
