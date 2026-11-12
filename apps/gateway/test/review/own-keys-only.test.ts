import { parseEnv } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review finding: `pnpm keys:generate` writes the key of every role into one `.env`, and the gateway's
 * entry point loaded the whole file into its environment. So the process that the threat model
 * assumes to be attacked ("a thief who holds every key the gateway holds, the executor key and the
 * spend wallet key") held the principal's and the approver's keys as well. The demo merchant, which
 * the same model treats as a counterparty that may misbehave, did the same.
 *
 * The test starts the gateway's real entry point with a stand-in for the file and for the chain, and
 * looks at the environment afterwards.
 */

const ROLES = [
  'DEPLOYER',
  'PRINCIPAL',
  'EXECUTOR',
  'APPROVER',
  'SPEND_WALLET',
  'MERCHANT',
  'AGENT',
  'VENDOR_A',
  'VENDOR_B',
];

const state = vi.hoisted(() => ({ envText: '' }));

// The repository's .env, as `pnpm keys:generate` leaves it. The values are placeholders that are
// built here; no key is written in this file.
state.envText = [
  ...ROLES.map((role, index) => `${role}_PRIVATE_KEY=0x${(index + 17).toString(16).repeat(32)}`),
  'ANTHROPIC_API_KEY=placeholder-for-the-test',
  'GATEWAY_PORT=8799',
].join('\n');

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  const isEnvFile = (path: unknown) => typeof path === 'string' && path.endsWith('/.env');
  return {
    ...real,
    default: real,
    existsSync: (path: string) => isEnvFile(path) || real.existsSync(path),
    readFileSync: (path: string, ...rest: unknown[]) =>
      isEnvFile(path)
        ? state.envText
        : (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest),
  };
});

// No chain and no port: the entry point is run for what it loads, not for what it serves.
vi.mock('../../src/runtime', async (original) => ({
  ...(await original<typeof import('../../src/runtime')>()),
  createRuntime: (config: unknown) =>
    Promise.resolve({
      config,
      chain: { info: () => Promise.resolve({ chainId: 421_614, vault: '0x00' }) },
      executor: { address: '0x00' },
      purchases: null,
      ledger: { entries: [] },
    }),
}));
vi.mock('../../src/server', () => ({ createApp: () => ({ listen: () => undefined }) }));

const SECRET_NAMES = [...ROLES.map((role) => `${role}_PRIVATE_KEY`), 'ANTHROPIC_API_KEY'];
let before: Record<string, string | undefined>;

beforeEach(() => {
  before = Object.fromEntries(
    [...SECRET_NAMES, 'GATEWAY_PORT'].map((name) => [name, process.env[name]]),
  );
  for (const name of Object.keys(before)) delete process.env[name];
  // What Node's process.loadEnvFile does with a file: every variable in it that is not set yet.
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
    for (const [name, value] of Object.entries(parseEnv(state.envText))) {
      process.env[name] ??= value;
    }
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  process.exitCode = 0;
});

describe('review: what the gateway process holds after it has started', () => {
  it('has its own two keys and its settings, and no other role’s key', async () => {
    await import('../../src/main');
    // The entry point has read its settings once the executor's key is there.
    await vi.waitFor(() => {
      expect(process.env.EXECUTOR_PRIVATE_KEY).toBeDefined();
    });

    expect(process.env.SPEND_WALLET_PRIVATE_KEY).toBeDefined();
    expect(process.env.GATEWAY_PORT).toBe('8799');

    const held = SECRET_NAMES.filter((name) => process.env[name] !== undefined);
    // On main: all nine keys and the Claude API key.
    expect(held.sort()).toEqual(['EXECUTOR_PRIVATE_KEY', 'SPEND_WALLET_PRIVATE_KEY']);
  });
});
