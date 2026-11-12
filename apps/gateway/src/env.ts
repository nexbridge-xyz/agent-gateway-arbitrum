import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Settings from the repository's `.env`, one process at a time.
 *
 * `pnpm keys:generate` writes the key of every role into that one file: the principal's and the
 * approver's next to the executor's. `process.loadEnvFile` would put all of them into the environment
 * of whichever process calls it. The gateway is the part that is assumed to be attacked, and what its
 * keys are worth is stated for two keys, not nine. So each process takes the variables it needs by
 * name, and the rest of the file never enters its environment.
 */

/** Everything the gateway reads from the environment (see `configFromEnv`). */
export const GATEWAY_ENV_NAMES = [
  'ARBITRUM_SEPOLIA_RPC_URL',
  'EXECUTOR_PRIVATE_KEY',
  'SPEND_WALLET_PRIVATE_KEY',
  'MANDATE_VAULT_ADDRESS',
  'GATEWAY_PORT',
  'GATEWAY_DATA_DIR',
  'GATEWAY_PURCHASE_CALL_CAP',
] as const;

/**
 * Copies the named variables from an env file into `env`, and nothing else. A variable that is already
 * set wins over the file, as with `process.loadEnvFile`. A missing file is not an error.
 */
export function loadFromEnvFile(
  path: string,
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!existsSync(path)) return;
  const values = parseEnv(readFileSync(path, 'utf8'));
  for (const name of names) {
    const value = values[name];
    if (value !== undefined && env[name] === undefined) env[name] = value;
  }
}
