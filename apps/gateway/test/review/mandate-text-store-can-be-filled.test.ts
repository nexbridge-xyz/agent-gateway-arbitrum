import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Hex, keccak256, stringToHex } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mandateTermsHash } from '../../src/protocol/mandateTerms';
import {
  MAX_WAITING_TEXTS,
  MandateTermsStore,
  type TermsInUse,
} from '../../src/store/mandateTerms';

/**
 * Review finding: PUT /v1/mandate-terms/:hash needs no signature and takes any text under its own hash.
 * The store took 2000 texts and then no more. The console stores a new mandate's text first and sends
 * createMandate only if that worked, so after 2000 texts from anybody the principal could no longer
 * create a mandate from the console. The server then answered "The text does not hash to this terms
 * hash", which is not what had happened.
 *
 * The fix ties the texts to the vault. A text that a mandate refers to is kept for good. Of the others
 * only so many wait, and when one more arrives the older half goes.
 */

/** MAX_WAITING_TEXTS, written out so that the first test also runs against the store before the fix. */
const ROOM = 2000;
const TERMS = 'AGENT PAYMENT MANDATE: VENDOR INVOICES\n\nPrincipal: Kirenami Trading\n';
const junk = (index: number) => `junk ${index}`;
const hashOf = (text: string): Hex => keccak256(stringToHex(text));
const NO_MANDATES: TermsInUse = () => Promise.resolve(new Set());

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agw-terms-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Writes texts into the folder as the store does for a caller without a signature. Each is a second
 * newer than the one before, so their order of arrival is not left to the speed of the disk.
 */
async function fill(count: number, from = 0): Promise<Hex[]> {
  await mkdir(dir, { recursive: true });
  const hashes: Hex[] = [];
  for (let index = from; index < from + count; index += 1) {
    const text = junk(index);
    const path = join(dir, `${hashOf(text)}.txt`);
    await writeFile(path, text, 'utf8');
    const storedAt = new Date(Date.UTC(2026, 10, 1) + index * 1000);
    await utimes(path, storedAt, storedAt);
    hashes.push(hashOf(text));
  }
  return hashes;
}
const stored = async () =>
  new Set((await readdir(dir)).map((name) => name.replace(/\.txt$/, '') as Hex));

// These tests write and read thousands of small files. That takes a second or two on a fast disk and
// several on a slow or busy one, so they get more time than the default five seconds.
describe('review: the store of mandate texts', { timeout: 60_000 }, () => {
  it('must still take the principal’s text after strangers have filled it', async () => {
    const store = new MandateTermsStore(dir, NO_MANDATES);
    // PUT /v1/mandate-terms/:hash needs no signature. Any text is accepted under its own hash.
    for (let index = 0; index < ROOM; index += 1) {
      expect(await store.put(hashOf(junk(index)), junk(index))).toBe(true);
    }
    expect(await readdir(dir)).toHaveLength(ROOM);

    // The console stores the text first and sends createMandate only if that worked.
    expect(await store.put(mandateTermsHash(TERMS), TERMS)).toBe(true);
    expect(await store.get(mandateTermsHash(TERMS))).toBe(TERMS);
  });

  it('makes room by dropping the older half of the texts that no mandate refers to', async () => {
    expect(MAX_WAITING_TEXTS).toBe(ROOM);
    const hashes = await fill(ROOM);
    const store = new MandateTermsStore(dir, NO_MANDATES);
    expect(await store.put(mandateTermsHash(TERMS), TERMS)).toBe(true);

    const now = await stored();
    expect(now.size).toBe(ROOM / 2 + 1);
    expect(now.has(mandateTermsHash(TERMS))).toBe(true);
    expect(hashes.slice(0, ROOM / 2).some((hash) => now.has(hash))).toBe(false);
    expect(hashes.slice(ROOM / 2).every((hash) => now.has(hash))).toBe(true);
  });

  it('never drops a text that a mandate in the vault refers to, however old it is', async () => {
    const hashes = await fill(ROOM + 3);
    // The three oldest texts belong to mandates.
    const inUse = new Set(hashes.slice(0, 3));
    const store = new MandateTermsStore(dir, () => Promise.resolve(inUse));
    expect(await store.put(mandateTermsHash(TERMS), TERMS)).toBe(true);

    const now = await stored();
    expect([...inUse].every((hash) => now.has(hash))).toBe(true);
    // Of the 2000 others the older half went.
    expect(hashes.slice(3, 3 + ROOM / 2).some((hash) => now.has(hash))).toBe(false);
    expect(now.size).toBe(3 + ROOM / 2 + 1);
  });

  it('keeps a text whose mandate was created while it waited, whatever arrives afterwards', async () => {
    const mandates = new Set<Hex>();
    const store = new MandateTermsStore(dir, () => Promise.resolve(mandates));
    // The console stores the text, then the principal's transaction creates the mandate.
    expect(await store.put(mandateTermsHash(TERMS), TERMS)).toBe(true);
    const written = new Date(Date.UTC(2026, 9, 1));
    await utimes(join(dir, `${mandateTermsHash(TERMS)}.txt`), written, written);
    mandates.add(mandateTermsHash(TERMS));

    // Then twice as many texts arrive as may wait. The mandate's text is the oldest of all.
    for (let round = 0; round < 4; round += 1) {
      await fill(ROOM / 2, round * (ROOM / 2));
      expect(await store.put(hashOf(`late ${round}`), `late ${round}`)).toBe(true);
    }
    expect(await store.get(mandateTermsHash(TERMS))).toBe(TERMS);
    expect((await stored()).size).toBeLessThanOrEqual(ROOM + 1);
  });

  it('asks the vault only when room has to be made', async () => {
    let asked = 0;
    const store = new MandateTermsStore(dir, () => {
      asked += 1;
      return Promise.resolve(new Set());
    });
    await fill(ROOM - 1);
    expect(await store.put(hashOf('one more'), 'one more')).toBe(true);
    expect(asked).toBe(0);

    expect(await store.put(mandateTermsHash(TERMS), TERMS)).toBe(true);
    expect(asked).toBe(1);
    // A text that is already there is not stored again, and nobody is asked.
    expect(await store.put(mandateTermsHash(TERMS), TERMS)).toBe(true);
    expect(asked).toBe(1);
  });

  it('drops nothing while the vault cannot be read', async () => {
    let reachable = false;
    const store = new MandateTermsStore(dir, () =>
      reachable ? Promise.resolve(new Set()) : Promise.reject(new Error('the node is down')),
    );
    const hashes = await fill(ROOM);
    await expect(store.put(mandateTermsHash(TERMS), TERMS)).rejects.toThrow('the node is down');
    expect(await stored()).toEqual(new Set(hashes));

    // The store is not stuck: the next text is taken as soon as the vault answers.
    reachable = true;
    expect(await store.put(mandateTermsHash(TERMS), TERMS)).toBe(true);
    expect(await store.get(mandateTermsHash(TERMS))).toBe(TERMS);
  });

  it('takes two texts that arrive at the same moment, one after the other', async () => {
    await fill(ROOM - 1);
    const store = new MandateTermsStore(dir, NO_MANDATES);
    const [first, second] = await Promise.all([
      store.put(hashOf('first'), 'first'),
      store.put(hashOf('second'), 'second'),
    ]);
    expect([first, second]).toEqual([true, true]);
    const now = await stored();
    expect(now.has(hashOf('first')) && now.has(hashOf('second'))).toBe(true);
    // The first filled the room. The second made room once, and both are among the newer half.
    expect(now.size).toBe(ROOM / 2 + 1);
  });

  it('still refuses a text under a hash that is not its own, and one that is too long', async () => {
    const store = new MandateTermsStore(dir, NO_MANDATES);
    expect(await store.put(hashOf('another text'), TERMS)).toBe(false);
    const long = 'x'.repeat(16 * 1024 + 1);
    expect(await store.put(hashOf(long), long)).toBe(false);
  });
});
