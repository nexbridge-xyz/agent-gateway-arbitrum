import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Hex } from 'viem';

import { mandateTermsHash } from '../protocol/mandateTerms';

/**
 * The plain-text terms of mandates, one file per text, named after its hash. A text can only be stored
 * under its own hash, so the store cannot be made to lie about what a `termsHash` stands for.
 */

export const MAX_TERMS_BYTES = 16 * 1024;
const MAX_TEXTS = 2000;

export class MandateTermsStore {
  constructor(private readonly dir: string) {}

  private path(termsHash: Hex): string {
    if (!/^0x[0-9a-f]{64}$/.test(termsHash)) throw new Error('Not a terms hash');
    return join(this.dir, `${termsHash}.txt`);
  }

  async get(termsHash: Hex): Promise<string | null> {
    try {
      return await readFile(this.path(termsHash), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Stores the text. Returns false if it does not hash to `termsHash`, is too long, or the store is full. */
  async put(termsHash: Hex, text: string): Promise<boolean> {
    if (Buffer.byteLength(text, 'utf8') > MAX_TERMS_BYTES) return false;
    if (!text.isWellFormed() || mandateTermsHash(text) !== termsHash) return false;
    if ((await this.get(termsHash)) !== null) return true;

    await mkdir(this.dir, { recursive: true });
    if ((await readdir(this.dir)).length >= MAX_TEXTS) return false;
    const path = this.path(termsHash);
    const temporary = `${path}.tmp`;
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, path);
    return true;
  }
}
