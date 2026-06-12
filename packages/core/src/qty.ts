import Decimal from 'decimal.js';
import { asPaisa, MoneyError, type Paisa } from './money';

/**
 * Quantities (pcs, sqft, kg) are stored as INTEGER milli-units (qty × 1000,
 * max 3 decimal places) so they round-trip exactly — the same discipline as
 * integer-paisa money. Valuations (qty × unit cost) go through decimal.js.
 */

const QtyDecimal = Decimal.clone({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export const MILLI_PER_UNIT = 1000;

/** Parse a quantity (string/Decimal) to integer milli-units. Throws on >3 dp or garbage. */
export function milliFromQty(qty: string | Decimal): number {
  let d: Decimal;
  try {
    d = new QtyDecimal(typeof qty === 'string' ? qty.trim() : qty);
  } catch {
    throw new MoneyError(`Not a valid quantity: ${String(qty)}`);
  }
  if (!d.isFinite()) throw new MoneyError(`Not a valid quantity: ${String(qty)}`);
  const m = d.times(MILLI_PER_UNIT);
  if (!m.isInteger()) {
    throw new MoneyError(`Quantity has more than 3 decimal places: ${d.toString()}`);
  }
  const n = m.toNumber();
  if (!Number.isSafeInteger(n)) throw new MoneyError(`Quantity out of range: ${d.toString()}`);
  return n;
}

/** Integer milli-units back to a Decimal quantity (exact). */
export function qtyFromMilli(milli: number): Decimal {
  if (!Number.isSafeInteger(milli)) throw new MoneyError(`Invalid milli quantity: ${milli}`);
  return new QtyDecimal(milli).dividedBy(MILLI_PER_UNIT);
}

/**
 * Line value = unit cost/price × quantity, rounded half-up to integer paisa.
 * The single place where money × quantity arithmetic happens.
 */
export function costOfQty(unitPaisa: number, qtyMilli: number): Paisa {
  asPaisa(unitPaisa);
  if (!Number.isSafeInteger(qtyMilli)) throw new MoneyError(`Invalid milli quantity: ${qtyMilli}`);
  const value = new QtyDecimal(unitPaisa).times(qtyMilli).dividedBy(MILLI_PER_UNIT).round();
  return asPaisa(value.toNumber());
}

/** Format milli-units for display, trimming trailing zeros: 2500 -> "2.5". */
export function formatQty(milli: number): string {
  return qtyFromMilli(milli).toString();
}
