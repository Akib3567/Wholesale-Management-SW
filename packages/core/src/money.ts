import Decimal from 'decimal.js';

/**
 * Money model for the whole application.
 *
 * Money is stored in SQLite and passed between layers as INTEGER paisa
 * (1 taka = 100 paisa). All arithmetic that could leave the integers —
 * parsing user input, multiplying by quantities, percentages, formatting —
 * goes through decimal.js. No layer ever does float arithmetic on money.
 *
 * Rounding is ROUND_HALF_UP (standard commercial rounding).
 */

const MoneyDecimal = Decimal.clone({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export const PAISA_PER_TAKA = 100;

declare const paisaBrand: unique symbol;
/**
 * A branded integer paisa amount. Obtain one via asPaisa() / paisaFromTaka()
 * so that plain numbers can't silently flow into money positions.
 */
export type Paisa = number & { readonly [paisaBrand]: true };

export const ZERO_PAISA = 0 as Paisa;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Validate that a raw number (e.g. read from SQLite) is a usable integer paisa amount. */
export function asPaisa(value: number): Paisa {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MoneyError(`Invalid paisa amount: ${String(value)} (must be a safe integer)`);
  }
  return value as Paisa;
}

/**
 * Parse a taka amount (user input string or Decimal) into integer paisa.
 * Throws if the value is not valid money (garbage input, or more than 2
 * decimal places — user-entered money must be exact, never silently rounded).
 */
export function paisaFromTaka(taka: string | Decimal): Paisa {
  let d: Decimal;
  try {
    d = new MoneyDecimal(typeof taka === 'string' ? taka.trim() : taka);
  } catch {
    throw new MoneyError(`Not a valid taka amount: ${String(taka)}`);
  }
  if (!d.isFinite()) {
    throw new MoneyError(`Not a valid taka amount: ${String(taka)}`);
  }
  const p = d.times(PAISA_PER_TAKA);
  if (!p.isInteger()) {
    throw new MoneyError(`Taka amount has more than 2 decimal places: ${d.toString()}`);
  }
  return asPaisa(p.toNumber());
}

/** Convert integer paisa to a Decimal taka value (exact, e.g. 1050 -> 10.5). */
export function takaFromPaisa(paisa: number): Decimal {
  return new MoneyDecimal(asPaisa(paisa)).dividedBy(PAISA_PER_TAKA);
}

/** Sum paisa amounts. Validates every operand and the result. */
export function addPaisa(...amounts: number[]): Paisa {
  let total = 0;
  for (const a of amounts) {
    total += asPaisa(a);
  }
  return asPaisa(total);
}

/** a - b in paisa. */
export function subtractPaisa(a: number, b: number): Paisa {
  return asPaisa(asPaisa(a) - asPaisa(b));
}

export function negatePaisa(a: number): Paisa {
  return asPaisa(-asPaisa(a));
}

/** Sum an iterable of paisa amounts (e.g. line totals). */
export function sumPaisa(amounts: Iterable<number>): Paisa {
  let total = 0;
  for (const a of amounts) {
    total += asPaisa(a);
  }
  return asPaisa(total);
}

/**
 * Multiply a paisa amount by a factor (quantity, rate…), rounding half-up
 * to integer paisa. Pass quantities as string or Decimal where possible.
 */
export function multiplyPaisa(paisa: number, factor: string | number | Decimal): Paisa {
  const result = new MoneyDecimal(asPaisa(paisa)).times(new MoneyDecimal(factor)).round();
  return asPaisa(result.toNumber());
}

/** percent% of a paisa amount, rounded half-up (e.g. discount, VAT). */
export function percentOfPaisa(paisa: number, percent: string | number | Decimal): Paisa {
  const result = new MoneyDecimal(asPaisa(paisa))
    .times(new MoneyDecimal(percent))
    .dividedBy(100)
    .round();
  return asPaisa(result.toNumber());
}

/**
 * Format integer paisa as a taka display string: 123456789 -> "1,234,567.89".
 * Always 2 decimal places; minus sign for negatives.
 */
export function formatTaka(paisa: number): string {
  const taka = takaFromPaisa(paisa);
  const fixed = taka.abs().toFixed(2);
  const [intPart, fracPart] = fixed.split('.') as [string, string];
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${taka.isNegative() ? '-' : ''}${grouped}.${fracPart}`;
}
