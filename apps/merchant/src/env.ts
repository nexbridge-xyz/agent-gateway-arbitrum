import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * The repository's `.env` holds the key of every role. The merchant takes the variables it needs by
 * name, so that the principal's, the approver's and the gateway's keys never enter its environment.
 */

/** Everything the demo merchant reads from the environment. */
export const MERCHANT_ENV_NAMES = [
  'ARBITRUM_SEPOLIA_RPC_URL',
  'MERCHANT_PRIVATE_KEY',
  'MERCHANT_PORT',
  'MERCHANT_MPP_SECRET',
  'MERCHANT_PLANTED_NOTE',
] as const;

/**
 * Copies the named variables from an env file into `env`, and nothing else. A variable that is already
 * set wins over the file. A missing file is not an error.
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
