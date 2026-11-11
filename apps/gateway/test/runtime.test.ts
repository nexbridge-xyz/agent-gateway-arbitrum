import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { configFromEnv } from '../src/runtime';

describe('gateway settings', () => {
  it('uses the recorded deployment and the public endpoint by default', () => {
    const config = configFromEnv({ EXECUTOR_PRIVATE_KEY: generatePrivateKey() });
    expect(config.vault).toBe('0x7293763f6b73783834484cd976528D01Cb6c8CCf');
    expect(config.rpcUrl).toBe('https://sepolia-rollup.arbitrum.io/rpc');
    expect(config.port).toBe(8787);
    expect(config.dataDir.endsWith('apps/gateway/data')).toBe(true);
  });

  it('treats empty variables as not set, as they are in a fresh .env', () => {
    const config = configFromEnv({
      EXECUTOR_PRIVATE_KEY: generatePrivateKey(),
      ARBITRUM_SEPOLIA_RPC_URL: '',
      MANDATE_VAULT_ADDRESS: '',
      GATEWAY_PORT: '',
      GATEWAY_DATA_DIR: '',
    });
    expect(config.vault).toBe('0x7293763f6b73783834484cd976528D01Cb6c8CCf');
    expect(config.port).toBe(8787);
  });

  it('accepts overrides', () => {
    const config = configFromEnv({
      EXECUTOR_PRIVATE_KEY: generatePrivateKey(),
      ARBITRUM_SEPOLIA_RPC_URL: 'http://127.0.0.1:8546',
      MANDATE_VAULT_ADDRESS: '0xc8ea68c4327ffe3831a9b075840389fb042773fa',
      GATEWAY_PORT: '9000',
      GATEWAY_DATA_DIR: '/tmp/gateway-data',
    });
    expect(config).toMatchObject({
      rpcUrl: 'http://127.0.0.1:8546',
      vault: '0xc8EA68C4327ffE3831a9b075840389Fb042773Fa',
      port: 9000,
      dataDir: '/tmp/gateway-data',
    });
  });

  it('says how to fix a missing executor key', () => {
    expect(() => configFromEnv({})).toThrow(/EXECUTOR_PRIVATE_KEY is not set.*keys:generate/);
    expect(() => configFromEnv({ EXECUTOR_PRIVATE_KEY: '' })).toThrow(
      /EXECUTOR_PRIVATE_KEY is not set/,
    );
  });

  it('never repeats a malformed key in the error message', () => {
    const almost = `${generatePrivateKey()}ff`;
    let message = '';
    try {
      configFromEnv({ EXECUTOR_PRIVATE_KEY: almost });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/EXECUTOR_PRIVATE_KEY/);
    expect(message).not.toContain(almost);
    expect(message).not.toContain(almost.slice(2, 20));
  });

  it('rejects a port that is not a port', () => {
    expect(() =>
      configFromEnv({ EXECUTOR_PRIVATE_KEY: generatePrivateKey(), GATEWAY_PORT: '99999' }),
    ).toThrow(/GATEWAY_PORT/);
  });
});
