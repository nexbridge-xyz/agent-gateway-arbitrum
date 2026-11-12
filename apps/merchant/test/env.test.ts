import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MERCHANT_ENV_NAMES, loadFromEnvFile } from '../src/env';

// The repository's .env holds the key of every role. The merchant takes its own settings from it and
// nothing else. The values below are placeholders built at run time.

let dir = '';
let file = '';
const placeholder = (byte: string) => `0x${byte.repeat(32)}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agw-merchant-env-'));
  file = join(dir, '.env');
  await writeFile(
    file,
    [
      `PRINCIPAL_PRIVATE_KEY=${placeholder('11')}`,
      `EXECUTOR_PRIVATE_KEY=${placeholder('12')}`,
      `APPROVER_PRIVATE_KEY=${placeholder('13')}`,
      `MERCHANT_PRIVATE_KEY=${placeholder('14')}`,
      'MERCHANT_PORT=8799',
      'ANTHROPIC_API_KEY=placeholder-for-the-test',
    ].join('\n'),
    'utf8',
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the settings the merchant loads', () => {
  it('are its own, and no other role’s key', () => {
    const env: NodeJS.ProcessEnv = {};
    loadFromEnvFile(file, MERCHANT_ENV_NAMES, env);
    expect(Object.keys(env).sort()).toEqual(['MERCHANT_PORT', 'MERCHANT_PRIVATE_KEY']);
  });

  it('leave a variable alone that is already set', () => {
    const env: NodeJS.ProcessEnv = { MERCHANT_PORT: '9000' };
    loadFromEnvFile(file, MERCHANT_ENV_NAMES, env);
    expect(env.MERCHANT_PORT).toBe('9000');
  });

  it('are empty when there is no file', () => {
    const env: NodeJS.ProcessEnv = {};
    loadFromEnvFile(join(dir, 'missing'), MERCHANT_ENV_NAMES, env);
    expect(env).toEqual({});
  });
});
