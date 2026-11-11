import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { configFromEnv, createRuntime, explorerTx, repositoryRoot } from './runtime';
import { createApp } from './server';

// Start the gateway: `pnpm gateway`. Settings come from the repository's .env.
const envFile = join(repositoryRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = configFromEnv();
const runtime = await createRuntime(config);
const info = await runtime.chain.info();
const app = createApp({
  gateway: runtime.gateway,
  chain: runtime.chain,
  ledger: runtime.ledger,
  explorerTx,
});

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Agent Gateway listening on http://127.0.0.1:${config.port}`);
  console.log(`  chain     Arbitrum Sepolia (${info.chainId})`);
  console.log(`  vault     ${info.vault}`);
  console.log(`  executor  ${runtime.executor.address}`);
  console.log(`  ledger    ${runtime.ledger.entries.length} entries`);
});
