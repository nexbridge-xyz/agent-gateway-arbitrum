import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { type Hex, keccak256, stringToHex } from 'viem';

import { type JsonObject, canonicalize } from '../protocol/json';

/**
 * Append-only audit ledger. Each entry carries the hash of the one before it, so changing or deleting
 * any past entry breaks every hash after it. Stored as one JSON object per line.
 */

export const GENESIS: Hex = `0x${'0'.repeat(64)}`;

export type LedgerKind =
  'INTENT_DECIDED' | 'PAYMENT_EXECUTED' | 'PAYMENT_FAILED' | 'APPROVAL_RECEIVED';

export type LedgerEntry = {
  seq: number;
  /** ISO 8601 UTC. */
  ts: string;
  kind: LedgerKind;
  summary: string;
  data: JsonObject;
  /** Hash of the previous entry, or GENESIS for the first one. */
  prev: Hex;
  hash: Hex;
};

export type LedgerCheck =
  | { ok: true; count: number; head: Hex }
  | { ok: false; count: number; brokenAt: number; why: string };

export function entryHash(entry: Omit<LedgerEntry, 'hash'>): Hex {
  const body: JsonObject = {
    seq: entry.seq,
    ts: entry.ts,
    kind: entry.kind,
    summary: entry.summary,
    data: entry.data,
    prev: entry.prev,
  };
  return keccak256(stringToHex(canonicalize(body)));
}

/** Walks the chain from the first entry and reports the first place where it breaks. */
export function verifyEntries(entries: readonly LedgerEntry[]): LedgerCheck {
  let prev = GENESIS;
  for (const [index, entry] of entries.entries()) {
    const position = index + 1;
    if (entry.seq !== position) {
      return { ok: false, count: entries.length, brokenAt: position, why: 'sequence gap' };
    }
    if (entry.prev !== prev) {
      return {
        ok: false,
        count: entries.length,
        brokenAt: position,
        why: 'previous hash does not match',
      };
    }
    let recomputed: Hex;
    try {
      recomputed = entryHash(entry);
    } catch {
      return {
        ok: false,
        count: entries.length,
        brokenAt: position,
        why: 'entry cannot be hashed',
      };
    }
    if (recomputed !== entry.hash) {
      return { ok: false, count: entries.length, brokenAt: position, why: 'entry was changed' };
    }
    prev = entry.hash;
  }
  return { ok: true, count: entries.length, head: prev };
}

export function parseLedger(text: string): LedgerEntry[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerEntry);
}

export class Ledger {
  private constructor(
    private readonly path: string,
    private readonly list: LedgerEntry[],
  ) {}

  /** Opens the ledger file, creating it if needed. Refuses to continue a chain that is broken. */
  static async open(path: string): Promise<Ledger> {
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(dirname(path), { recursive: true });
    }
    const entries = parseLedger(text);
    const check = verifyEntries(entries);
    if (!check.ok) {
      throw new Error(`Ledger at ${path} is broken at entry ${check.brokenAt}: ${check.why}`);
    }
    return new Ledger(path, entries);
  }

  get entries(): readonly LedgerEntry[] {
    return this.list;
  }

  get head(): Hex {
    return this.list.at(-1)?.hash ?? GENESIS;
  }

  async append(
    kind: LedgerKind,
    summary: string,
    data: JsonObject,
    now = new Date(),
  ): Promise<LedgerEntry> {
    const body = {
      seq: this.list.length + 1,
      ts: now.toISOString(),
      kind,
      summary,
      data,
      prev: this.head,
    };
    const entry: LedgerEntry = { ...body, hash: entryHash(body) };
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    this.list.push(entry);
    return entry;
  }

  verify(): LedgerCheck {
    return verifyEntries(this.list);
  }
}
