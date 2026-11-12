import { join } from 'node:path';

import { GATEWAY_ENV_NAMES, loadFromEnvFile } from './env';
import { appOptions, configFromEnv, createRuntime, repositoryRoot } from './runtime';
import { createApp } from './server';

// Start the gateway: `pnpm gateway`. Settings come from the repository's .env.
async function main(): Promise<void> {
  // The gateway's own settings only: the same file holds the principal's and the approver's keys.
  loadFromEnvFile(join(repositoryRoot, '.env'), GATEWAY_ENV_NAMES);

  const config = configFromEnv();
  const runtime = await createRuntime(config);
  const info = await runtime.chain.info();
  const app = createApp(appOptions(runtime));

  app.listen(config.port, '127.0.0.1', () => {
    console.log(`Agent Gateway listening on http://127.0.0.1:${config.port}`);
    console.log(`  chain     Arbitrum Sepolia (${info.chainId})`);
    console.log(`  vault     ${info.vault}`);
    console.log(`  executor  ${runtime.executor.address}`);
    console.log(
      `  spend     ${runtime.purchases?.spendWallet ?? 'none: per-call purchases are refused'}`,
    );
    console.log(`  ledger    ${runtime.ledger.entries.length} entries`);
  });
}

main().catch((error: unknown) => {
  console.error(
    `The gateway did not start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
