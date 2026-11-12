import { describe, expect, it } from 'vitest';

import { clock, day, money, short, until, yen } from '@/lib/format';

describe('money', () => {
  it('writes an amount with at least two decimals', () => {
    expect(money('1500000', 6)).toBe('1.50');
    expect(money(100_000n, 6)).toBe('0.10');
    expect(money('6000000', 6)).toBe('6.00');
    expect(money('0', 6)).toBe('0.00');
  });

  it('keeps every digit of a small amount and groups a large one', () => {
    expect(money('1', 6)).toBe('0.000001');
    expect(money('12345678901234', 6)).toBe('12,345,678.901234');
    expect(money('999999999999999999', 6)).toBe('999,999,999,999.999999');
  });
});

describe('yen at the demo rate', () => {
  it('multiplies by 150 and rounds to whole yen', () => {
    expect(yen('1500000', 6)).toBe('225');
    expect(yen('100000', 6)).toBe('15');
    expect(yen('6000000', 6)).toBe('900');
  });

  it('rounds half up, and stays exact for amounts a float cannot hold', () => {
    expect(yen('3333', 6)).toBe('0');
    expect(yen('3334', 6)).toBe('1');
    expect(yen('999999999999999999', 6)).toBe('150,000,000,000,000');
  });
});

describe('short', () => {
  it('keeps the start and the end of a long value', () => {
    expect(short('0x7293763f6b73783834484cd976528D01Cb6c8CCf')).toBe('0x7293…8CCf');
    expect(short('0x7293763f6b73783834484cd976528D01Cb6c8CCf', 10, 8)).toBe('0x7293763f…Cb6c8CCf');
  });

  it('leaves a short value alone', () => {
    expect(short('0x1234')).toBe('0x1234');
  });
});

describe('times, always in UTC', () => {
  it('prints the time of day to the second', () => {
    expect(clock('2026-11-12T02:38:50.123Z')).toBe('02:38:50');
    expect(clock('not a date')).toBe('--:--:--');
  });

  it('prints a date from text or from Unix seconds', () => {
    expect(day('2026-11-12T23:59:59Z')).toBe('12 Nov 2026');
    expect(day(1_797_000_000)).toBe('11 Dec 2026');
    expect(day('not a date')).toBe('unknown date');
  });

  it('says how long is left in the unit that fits', () => {
    expect(until(1000, 1000)).toBe('passed');
    expect(until(1045, 1000)).toBe('in 45 s');
    expect(until(1600, 1000)).toBe('in 10 min');
    expect(until(1000 + 7200, 1000)).toBe('in 2 h');
    expect(until(1000 + 30 * 86_400, 1000)).toBe('in 30 days');
  });
});
