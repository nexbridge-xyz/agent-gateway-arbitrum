import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GENESIS, Ledger, type LedgerEntry, parseLedger, verifyEntries } from '../src/store/ledger';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agw-ledger-'));
  path = join(dir, 'nested', 'ledger.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function threeEntries(): Promise<LedgerEntry[]> {
  const ledger = await Ledger.open(path);
  await ledger.append('INTENT_DECIDED', 'first', { n: 1 });
  await ledger.append('PAYMENT_EXECUTED', 'second', { n: 2 });
  await ledger.append('INTENT_DECIDED', 'third', { n: 3 });
  return ledger.entries.map((entry) => structuredClone(entry));
}

describe('ledger', () => {
  it('starts empty at the genesis hash', async () => {
    const ledger = await Ledger.open(path);
    expect(ledger.entries).toHaveLength(0);
    expect(ledger.head).toBe(GENESIS);
    expect(ledger.verify()).toEqual({ ok: true, count: 0, head: GENESIS });
  });

  it('chains every entry to the one before it', async () => {
    const entries = await threeEntries();
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(entries[0]?.prev).toBe(GENESIS);
    expect(entries[1]?.prev).toBe(entries[0]?.hash);
    expect(entries[2]?.prev).toBe(entries[1]?.hash);
    expect(verifyEntries(entries)).toEqual({ ok: true, count: 3, head: entries[2]?.hash });
  });

  it('writes one line per entry and reads the same chain back', async () => {
    const entries = await threeEntries();
    const text = await readFile(path, 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(3);
    expect(parseLedger(text)).toEqual(entries);

    const reopened = await Ledger.open(path);
    expect(reopened.head).toBe(entries[2]?.hash);
    const fourth = await reopened.append('PAYMENT_FAILED', 'fourth', {});
    expect(fourth.seq).toBe(4);
    expect(fourth.prev).toBe(entries[2]?.hash);
  });

  it('detects a changed entry', async () => {
    const entries = await threeEntries();
    (entries[1] as LedgerEntry).data = { n: 200 };
    expect(verifyEntries(entries)).toEqual({
      ok: false,
      count: 3,
      brokenAt: 2,
      why: 'entry was changed',
    });
  });

  it('detects a changed summary, kind or time', async () => {
    for (const change of [
      { summary: 'other' },
      { kind: 'PAYMENT_FAILED' as const },
      { ts: '2020-01-01T00:00:00.000Z' },
    ]) {
      const entries = await threeEntries();
      Object.assign(entries[0] as LedgerEntry, change);
      expect(verifyEntries(entries)).toMatchObject({
        ok: false,
        brokenAt: 1,
        why: 'entry was changed',
      });
      await rm(path);
    }
  });

  it('detects a deleted entry', async () => {
    const entries = await threeEntries();
    entries.splice(1, 1);
    expect(verifyEntries(entries)).toMatchObject({ ok: false, brokenAt: 2, why: 'sequence gap' });
  });

  it('detects a deleted entry even when the numbering is repaired', async () => {
    const entries = await threeEntries();
    entries.splice(1, 1);
    (entries[1] as LedgerEntry).seq = 2;
    expect(verifyEntries(entries)).toMatchObject({
      ok: false,
      brokenAt: 2,
      why: 'previous hash does not match',
    });
  });

  it('detects entries that were swapped', async () => {
    const entries = await threeEntries();
    [entries[0], entries[1]] = [entries[1] as LedgerEntry, entries[0] as LedgerEntry];
    expect(verifyEntries(entries).ok).toBe(false);
  });

  it('refuses to continue a file whose chain is broken', async () => {
    const entries = await threeEntries();
    (entries[0] as LedgerEntry).summary = 'rewritten';
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n'));
    await expect(Ledger.open(path)).rejects.toThrow(/broken at entry 1/);
  });
});
