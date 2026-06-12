import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  MoneyError,
  addPaisa,
  asPaisa,
  formatTaka,
  multiplyPaisa,
  negatePaisa,
  paisaFromTaka,
  percentOfPaisa,
  subtractPaisa,
  sumPaisa,
  takaFromPaisa,
} from './money';

describe('the float problem this module exists to prevent', () => {
  it('0.1 + 0.2 is broken in float but exact in paisa', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the bug we are avoiding

    const sum = addPaisa(paisaFromTaka('0.10'), paisaFromTaka('0.20'));
    expect(sum).toBe(paisaFromTaka('0.30'));
    expect(takaFromPaisa(sum).toString()).toBe('0.3');
  });

  it('repeated addition stays exact (1000 × 0.01 = 10.00)', () => {
    const oneePoisha = paisaFromTaka('0.01');
    let total = 0;
    for (let i = 0; i < 1000; i++) total = addPaisa(total, oneePoisha);
    expect(takaFromPaisa(total).toString()).toBe('10');
  });
});

describe('paisaFromTaka', () => {
  it('parses whole and fractional taka', () => {
    expect(paisaFromTaka('0')).toBe(0);
    expect(paisaFromTaka('1')).toBe(100);
    expect(paisaFromTaka('12.5')).toBe(1250);
    expect(paisaFromTaka('12.50')).toBe(1250);
    expect(paisaFromTaka('0.01')).toBe(1);
    expect(paisaFromTaka('1234567.89')).toBe(123456789);
    expect(paisaFromTaka(' 99.99 ')).toBe(9999);
  });

  it('accepts negative amounts (e.g. adjustments)', () => {
    expect(paisaFromTaka('-12.34')).toBe(-1234);
  });

  it('accepts Decimal input', () => {
    expect(paisaFromTaka(new Decimal('10.25'))).toBe(1025);
  });

  it('rejects more than 2 decimal places — never silently rounds user money', () => {
    expect(() => paisaFromTaka('12.345')).toThrow(MoneyError);
    expect(() => paisaFromTaka('0.001')).toThrow(MoneyError);
  });

  it('rejects garbage input', () => {
    expect(() => paisaFromTaka('abc')).toThrow(MoneyError);
    expect(() => paisaFromTaka('')).toThrow(MoneyError);
    expect(() => paisaFromTaka('12.3.4')).toThrow(MoneyError);
    expect(() => paisaFromTaka('NaN')).toThrow(MoneyError);
    expect(() => paisaFromTaka('Infinity')).toThrow(MoneyError);
  });
});

describe('paisa round-trips', () => {
  it('taka string -> paisa -> taka is exact', () => {
    for (const s of ['0', '0.01', '1', '12.5', '99.99', '1234567.89', '-45.05']) {
      expect(takaFromPaisa(paisaFromTaka(s)).equals(new Decimal(s))).toBe(true);
    }
  });

  it('paisa -> taka -> paisa is exact', () => {
    for (const p of [0, 1, 99, 100, 1250, 123456789, -1234]) {
      expect(paisaFromTaka(takaFromPaisa(p))).toBe(p);
    }
  });
});

describe('asPaisa validation', () => {
  it('accepts safe integers', () => {
    expect(asPaisa(0)).toBe(0);
    expect(asPaisa(-500)).toBe(-500);
    expect(asPaisa(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects floats, NaN, Infinity, and unsafe integers', () => {
    expect(() => asPaisa(1.5)).toThrow(MoneyError);
    expect(() => asPaisa(NaN)).toThrow(MoneyError);
    expect(() => asPaisa(Infinity)).toThrow(MoneyError);
    expect(() => asPaisa(Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyError);
  });
});

describe('integer arithmetic', () => {
  it('add / subtract / negate / sum', () => {
    expect(addPaisa(100, 250, 50)).toBe(400);
    expect(subtractPaisa(1000, 999)).toBe(1);
    expect(negatePaisa(123)).toBe(-123);
    expect(sumPaisa([100, 200, 300])).toBe(600);
    expect(sumPaisa([])).toBe(0);
  });

  it('refuses float operands anywhere', () => {
    expect(() => addPaisa(100, 0.5)).toThrow(MoneyError);
    expect(() => subtractPaisa(1.1, 1)).toThrow(MoneyError);
    expect(() => sumPaisa([100, 2.5])).toThrow(MoneyError);
  });
});

describe('multiplyPaisa / percentOfPaisa (decimal.js, half-up)', () => {
  it('multiplies by integer quantities exactly', () => {
    expect(multiplyPaisa(3333, 3)).toBe(9999);
    expect(multiplyPaisa(1250, '12')).toBe(15000); // 12 pcs × 12.50
  });

  it('multiplies by fractional quantities with half-up rounding', () => {
    expect(multiplyPaisa(100, '0.333')).toBe(33); // 33.3 -> 33
    expect(multiplyPaisa(5, '0.5')).toBe(3); // 2.5 -> 3 (half-up)
    expect(multiplyPaisa(1000, new Decimal('2.5'))).toBe(2500);
  });

  it('computes percentages with half-up rounding', () => {
    expect(percentOfPaisa(10000, '15')).toBe(1500); // 15% of 100.00
    expect(percentOfPaisa(999, '10')).toBe(100); // 99.9 -> 100
    expect(percentOfPaisa(50, '5')).toBe(3); // 2.5 -> 3 (half-up)
  });
});

describe('formatTaka', () => {
  it('formats with grouping and 2 decimals', () => {
    expect(formatTaka(0)).toBe('0.00');
    expect(formatTaka(1)).toBe('0.01');
    expect(formatTaka(1250)).toBe('12.50');
    expect(formatTaka(123456789)).toBe('1,234,567.89');
    expect(formatTaka(-9999)).toBe('-99.99');
  });
});
