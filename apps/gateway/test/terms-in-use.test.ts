import type { Hex, PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';

import { createTermsInUse } from '../src/chain/termsInUse';
import { VAULT } from './helpers';

// Which texts the store of mandate texts must keep: the terms hashes of the mandates in the vault.

const hashOf = (id: number): Hex => `0x${id.toString(16).padStart(64, '0')}`;

/** A vault with `count` mandates; mandate n has terms hash n. It keeps what it was asked. */
function vault(count: number) {
  const state = { count, reads: [] as number[][], failNext: false };
  const client = {
    readContract: () => Promise.resolve(BigInt(state.count)),
    multicall: ({ contracts }: { contracts: { args: readonly [bigint] }[] }) => {
      if (state.failNext) {
        state.failNext = false;
        return Promise.reject(new Error('the node is down'));
      }
      const ids = contracts.map((call) => Number(call.args[0]));
      state.reads.push(ids);
      return Promise.resolve(ids.map((id) => ({ termsHash: hashOf(id) })));
    },
  } as unknown as PublicClient;
  return { state, termsInUse: createTermsInUse(client, VAULT) };
}

describe('the terms hashes that mandates in the vault refer to', () => {
  it('reads every mandate, from the first to the newest', async () => {
    const { state, termsInUse } = vault(3);
    expect(await termsInUse()).toEqual(new Set([hashOf(1), hashOf(2), hashOf(3)]));
    expect(state.reads).toEqual([[1, 2, 3]]);
  });

  it('reads nothing from an empty vault', async () => {
    const { state, termsInUse } = vault(0);
    expect((await termsInUse()).size).toBe(0);
    expect(state.reads).toEqual([]);
  });

  it('reads each mandate once: a later call reads only the mandates created since', async () => {
    const { state, termsInUse } = vault(2);
    await termsInUse();
    await termsInUse();
    expect(state.reads).toEqual([[1, 2]]);

    state.count = 4;
    expect(await termsInUse()).toEqual(new Set([1, 2, 3, 4].map(hashOf)));
    expect(state.reads).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('reads a large vault 200 mandates at a time', async () => {
    const { state, termsInUse } = vault(450);
    expect((await termsInUse()).size).toBe(450);
    expect(state.reads.map((ids) => ids.length)).toEqual([200, 200, 50]);
    expect(state.reads[2]?.at(-1)).toBe(450);
  });

  it('skips no mandate when two calls run at once', async () => {
    const { termsInUse } = vault(450);
    const [first, second] = await Promise.all([termsInUse(), termsInUse()]);
    expect(first.size).toBe(450);
    expect(second.size).toBe(450);
  });

  it('reads a mandate again after a read that failed', async () => {
    const { state, termsInUse } = vault(2);
    state.failNext = true;
    await expect(termsInUse()).rejects.toThrow('the node is down');
    expect(await termsInUse()).toEqual(new Set([hashOf(1), hashOf(2)]));
  });
});
