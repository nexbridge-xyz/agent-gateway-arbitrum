import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { repositoryRoot } from '@agent-gateway/gateway';

import { type Context, createContext } from './demo/context';
import { type StepOptions, drill, gas, payVendor, setup } from './demo/steps';

// Runs the demo on Arbitrum Sepolia and prints an Arbiscan link for every transaction.
//
//   pnpm demo                    every step that exists so far
//   pnpm demo --steps 1,3        chosen steps
//   pnpm demo --fresh            register a new agent and create a new mandate

const STEPS: Record<string, (context: Context, options: StepOptions) => Promise<void>> = {
  gas,
  '1': setup,
  '3': payVendor,
  '6': drill,
};

const { values } = parseArgs({
  options: {
    steps: { type: 'string', default: 'gas,1,3,6' },
    'env-file': { type: 'string', default: join(repositoryRoot, '.env') },
    fresh: { type: 'boolean', default: false },
  },
});

const names = values.steps.split(',').map((name) => name.trim());
const unknown = names.filter((name) => !(name in STEPS));
if (unknown.length > 0) {
  console.error(`Unknown step: ${unknown.join(', ')}. Available: ${Object.keys(STEPS).join(', ')}`);
  process.exit(2);
}

try {
  const context = await createContext(values['env-file']);
  const { accounts, info, log, transactions, runtime } = context;

  log(`Agent Gateway demo on Arbitrum Sepolia (${info.chainId})`);
  log(`  vault      ${info.vault}`);
  log(`  principal  ${accounts.PRINCIPAL.address}`);
  log(`  executor   ${accounts.EXECUTOR.address}  (the gateway's capped role)`);
  log(`  approver   ${accounts.APPROVER.address}`);
  log(`  agent      ${accounts.AGENT.address}  (signs requests only)`);
  log('  All company and vendor names are fictional.');

  for (const name of names) {
    log();
    await (STEPS[name] as (typeof STEPS)[string])(context, { fresh: values.fresh });
  }

  log();
  log(`Done. ${transactions.length} transactions:`);
  for (const transaction of transactions) {
    log(
      `  ${transaction.step.padEnd(3)} ${transaction.status === 'success' ? 'ok      ' : 'reverted'} ${transaction.url}`,
    );
  }

  await mkdir(runtime.config.dataDir, { recursive: true });
  const runFile = join(runtime.config.dataDir, 'demo-run.json');
  await writeFile(
    runFile,
    `${JSON.stringify({ chainId: info.chainId, vault: info.vault, finishedAt: new Date().toISOString(), steps: names, transactions }, null, 2)}\n`,
    'utf8',
  );
  log(`Run log: ${runFile}`);
} catch (error) {
  console.error('');
  console.error(`Demo stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
