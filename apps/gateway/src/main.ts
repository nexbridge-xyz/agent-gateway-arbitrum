import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { appOptions, configFromEnv, createRuntime, repositoryRoot } from './runtime';
import { createApp } from './server';

// Start the gateway: `pnpm gateway`. Settings come from the repository's .env.
async function main(): Promise<void> {
  const envFile = join(repositoryRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

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
