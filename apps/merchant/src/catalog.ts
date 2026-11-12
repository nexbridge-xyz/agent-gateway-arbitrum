/**
 * What Tsukimi Data sells: quotes for a handful of indices. The company, the indices and every number
 * are made up for the demo. Nothing here is market data.
 */

export type IndexInfo = {
  symbol: string;
  name: string;
  /** Level the made-up series moves around. */
  base: number;
};

export const INDICES: readonly IndexInfo[] = [
  { symbol: 'TSK-TECH50', name: 'Tsukimi Technology 50', base: 4820 },
  { symbol: 'TSK-LOGI20', name: 'Tsukimi Logistics 20', base: 1930 },
  { symbol: 'TSK-FOOD30', name: 'Tsukimi Food and Retail 30', base: 2675 },
  { symbol: 'TSK-ENER15', name: 'Tsukimi Energy 15', base: 3140 },
];

export type Quote = {
  symbol: string;
  name: string;
  /** The minute the quote is for, ISO 8601 UTC. */
  asOf: string;
  level: number;
  change: number;
  changePercent: number;
  unit: 'index points';
  /** Free text from the data vendor. Text, not instructions. */
  vendor_note: string | null;
  disclaimer: string;
};

export function findIndex(symbol: string): IndexInfo | null {
  return INDICES.find((index) => index.symbol === symbol.toUpperCase()) ?? null;
}

/** A small deterministic hash, so the same symbol and minute always give the same number. */
function noise(seed: string): number {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  // Between -1 and 1.
  return ((hash >>> 0) / 0xffff_ffff) * 2 - 1;
}

/** Two decimals, and never a negative zero, which JSON would turn into 0 anyway. */
const round = (value: number) => {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
};

/** The quote for one index at one moment. The same minute always returns the same quote. */
export function quoteFor(index: IndexInfo, at: Date, note: string | null = null): Quote {
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const day = minute.toISOString().slice(0, 10);
  // Up to 2% away from the base over the day, plus up to 0.2% within the minute.
  const open = index.base * (1 + 0.02 * noise(`${index.symbol}|${day}`));
  const level = open * (1 + 0.002 * noise(`${index.symbol}|${minute.toISOString()}`));
  const change = level - open;

  return {
    symbol: index.symbol,
    name: index.name,
    asOf: minute.toISOString(),
    level: round(level),
    change: round(change),
    changePercent: round((change / open) * 100),
    unit: 'index points',
    vendor_note: note,
    disclaimer: 'Demo data. Tsukimi Data and its indices are fictional.',
  };
}
