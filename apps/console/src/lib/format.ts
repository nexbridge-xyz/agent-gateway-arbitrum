import { formatUnits } from 'viem';

/**
 * A fixed rate for showing a yen figure next to USDC amounts in the demo. It is not a market rate and
 * the console says so wherever it is used.
 */
export const DEMO_JPY_PER_USDC = 150n;

/** An amount in whole tokens with at least two decimals: 1500000 at 6 decimals is "1.50". */
export function money(amount: string | bigint, decimals: number): string {
  const [whole = '0', fraction = ''] = formatUnits(BigInt(amount), decimals).split('.');
  return `${BigInt(whole).toLocaleString('en-US')}.${fraction.padEnd(2, '0')}`;
}

/** The yen figure for an amount at the demo rate, rounded to whole yen. Integer arithmetic only. */
export function yen(amount: string | bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const value = (BigInt(amount) * DEMO_JPY_PER_USDC + unit / 2n) / unit;
  return value.toLocaleString('en-US');
}

/** The start and the end of a long hex value: 0x7293…8CCf. */
export function short(value: string, lead = 6, tail = 4): string {
  return value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

const pad = (value: number) => value.toString().padStart(2, '0');

/** A time of day in UTC, to the second: 02:38:50. */
export function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date in UTC: 12 Nov 2026. */
export function day(value: string | number): string {
  // Seconds past the year 9999 are a way of saying "never", not a date to print.
  if (typeof value === 'number' && value > 253_402_300_799) return 'no end date';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
}

/** How long until a moment, in words: "in 9 min", "in 23 days", "passed". */
export function until(unixSeconds: number, nowSeconds: number): string {
  const left = unixSeconds - nowSeconds;
  if (left <= 0) return 'passed';
  if (left < 90) return `in ${left} s`;
  if (left < 5400) return `in ${Math.round(left / 60)} min`;
  if (left < 172_800) return `in ${Math.round(left / 3600)} h`;
  if (left > 36_500 * 86_400) return 'in more than 100 years';
  return `in ${Math.round(left / 86_400)} days`;
}
