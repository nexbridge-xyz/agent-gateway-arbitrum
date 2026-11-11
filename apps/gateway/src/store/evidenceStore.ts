import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Hex } from 'viem';

import type { EvidenceFile } from '../protocol/evidence';

/** One JSON file per decision, named after the intent id. */
export class EvidenceStore {
  constructor(private readonly dir: string) {}

  private path(intentId: Hex): string {
    if (!/^0x[0-9a-f]{64}$/.test(intentId)) throw new Error('Not an intent id');
    return join(this.dir, `${intentId}.json`);
  }

  async save(file: EvidenceFile): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const path = this.path(file.record.intentId);
    // Write to a temporary file and rename, so a reader never sees half a record.
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
    return path;
  }

  async get(intentId: Hex): Promise<EvidenceFile | null> {
    try {
      return JSON.parse(await readFile(this.path(intentId), 'utf8')) as EvidenceFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  pathFor(intentId: Hex): string {
    return this.path(intentId);
  }

  async list(): Promise<Hex[]> {
    try {
      const names = await readdir(this.dir);
      return names
        .filter((name) => /^0x[0-9a-f]{64}\.json$/.test(name))
        .map((name) => name.slice(0, 66) as Hex);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
