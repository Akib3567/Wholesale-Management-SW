import { describe, expect, it } from 'vitest';
import { MoneyError } from './money';
import { costOfQty, formatQty, milliFromQty, qtyFromMilli } from './qty';

describe('milliFromQty / qtyFromMilli', () => {
  it('parses and round-trips exactly', () => {
    expect(milliFromQty('1')).toBe(1000);
    expect(milliFromQty('2.5')).toBe(2500);
    expect(milliFromQty('0.001')).toBe(1);
    expect(milliFromQty('123.456')).toBe(123_456);
    for (const s of ['0.001', '2.5', '1000', '99.999']) {
      expect(qtyFromMilli(milliFromQty(s)).toString()).toBe(s.replace(/^0+(?=\d)/, ''));
    }
  });

  it('rejects more than 3 decimal places and garbage', () => {
    expect(() => milliFromQty('1.2345')).toThrow(MoneyError);
    expect(() => milliFromQty('abc')).toThrow(MoneyError);
    expect(() => milliFromQty('')).toThrow(MoneyError);
  });
});

describe('costOfQty', () => {
  it('computes line totals exactly with half-up rounding', () => {
    expect(costOfQty(10_000, 2500)).toBe(25_000); // 100.00 × 2.5 = 250.00
    expect(costOfQty(12_345, 2500)).toBe(30_863); // 123.45 × 2.5 = 308.625 -> 308.63
    expect(costOfQty(1, 1)).toBe(0); // 0.01 × 0.001 = 0.00001 -> 0
    expect(costOfQty(333, 3000)).toBe(999);
  });

  it('rejects float inputs', () => {
    expect(() => costOfQty(10.5, 1000)).toThrow(MoneyError);
    expect(() => costOfQty(1000, 10.5)).toThrow(MoneyError);
  });
});

describe('formatQty', () => {
  it('trims trailing zeros', () => {
    expect(formatQty(2500)).toBe('2.5');
    expect(formatQty(1000)).toBe('1');
    expect(formatQty(1)).toBe('0.001');
  });
});
