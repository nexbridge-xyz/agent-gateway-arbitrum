import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Hex } from 'viem';

import { mandateTermsHash } from '../protocol/mandateTerms';

/**
 * The plain-text terms of mandates, one file per text, named after its hash. A text can only be stored
 * under its own hash, so the store cannot be made to lie about what a `termsHash` stands for.
 *
 * Storing a text needs no signature, and a text arrives before its mandate exists. So the store tells
 * two kinds of text apart. A text that a mandate in the vault refers to is kept for good. Any other text
 * waits, and only so many may wait: when one more arrives, the older half of them goes. Texts that
 * nobody turned into a mandate therefore cannot keep a new one out.
 */

export const MAX_TERMS_BYTES = 16 * 1024;
/** How many texts are kept that no mandate in the vault refers to. */
export const MAX_WAITING_TEXTS = 2000;

/** Reads the terms hashes that the mandates in the vault refer to. */
export type TermsInUse = () => Promise<ReadonlySet<Hex>>;

const TEXT_FILE = /^(0x[0-9a-f]{64})\.txt$/;

export class MandateTermsStore {
  /** The terms hashes of the vault's mandates, as last read. A mandate keeps its hash, so this only grows. */
  private inUse: ReadonlySet<Hex> = new Set();
  private queue: Promise<unknown> = Promise.resolve();

  /** `termsInUse` is asked only when room has to be made, never for a text that fits. */
  constructor(
    private readonly dir: string,
    private readonly termsInUse: TermsInUse,
  ) {}

  private path(termsHash: Hex): string {
    if (!/^0x[0-9a-f]{64}$/.test(termsHash)) throw new Error('Not a terms hash');
    return join(this.dir, `${termsHash}.txt`);
  }

  /** One text is stored at a time, so two that arrive together cannot both count the same room. */
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async get(termsHash: Hex): Promise<string | null> {
    try {
      return await readFile(this.path(termsHash), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Stores the text. Returns false if it does not hash to `termsHash` or is too long. Throws if room
   * had to be made and the vault could not be read: nothing is dropped on a guess.
   */
  async put(termsHash: Hex, text: string): Promise<boolean> {
    if (Buffer.byteLength(text, 'utf8') > MAX_TERMS_BYTES) return false;
    if (!text.isWellFormed() || mandateTermsHash(text) !== termsHash) return false;

    return this.inTurn(async () => {
      if ((await this.get(termsHash)) !== null) return true;

      await mkdir(this.dir, { recursive: true });
      await this.makeRoom();
      const path = this.path(termsHash);
      const temporary = `${path}.tmp`;
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, path);
      return true;
    });
  }

  /** Drops the older half of the waiting texts once as many wait as may. Texts in use are never dropped. */
  private async makeRoom(): Promise<void> {
    const stored: Hex[] = [];
    for (const name of await readdir(this.dir)) {
      const hash = TEXT_FILE.exec(name)?.[1];
      if (hash !== undefined) stored.push(hash as Hex);
    }
    const waiting = () => stored.filter((hash) => !this.inUse.has(hash));
    if (waiting().length < MAX_WAITING_TEXTS) return;

    // The vault is asked before anything goes, so a text whose mandate exists by now stays.
    this.inUse = await this.termsInUse();
    const candidates = waiting();
    if (candidates.length < MAX_WAITING_TEXTS) return;

    const aged = await Promise.all(
      candidates.map(async (hash) => ({ hash, storedAt: (await stat(this.path(hash))).mtimeMs })),
    );
    aged.sort((a, b) => a.storedAt - b.storedAt);
    for (const { hash } of aged.slice(0, aged.length - MAX_WAITING_TEXTS / 2)) {
      await rm(this.path(hash), { force: true });
    }
  }
}
