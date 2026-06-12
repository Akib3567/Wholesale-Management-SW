/**
 * DISPLAY-ONLY money helpers for the UI.
 *
 * The server computes every authoritative figure (rule 1). The UI needs two
 * things: format integer paisa it RECEIVED, and convert form input strings
 * to integer paisa it SENDS. Entry-form line previews use pure integer
 * arithmetic that mirrors packages/core exactly; the server recomputes and
 * is the only source of truth for what gets stored.
 */

export function formatPaisa(paisa: number): string {
  const negative = paisa < 0;
  const abs = Math.abs(Math.trunc(paisa));
  const taka = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = String(taka).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${frac}`;
}

/** "1234.5" -> 123450 paisa; null when not valid money (max 2 dp). */
export function parseTakaToPaisa(input: string): number | null {
  const s = input.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const [intPart = '0', fracPart = ''] = (negative ? s.slice(1) : s).split('.');
  const paisa = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(paisa)) return null;
  return negative ? -paisa : paisa;
}

/** "2.5" -> 2500 milli-units; null when invalid (max 3 dp). */
export function parseQtyToMilli(input: string): number | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return null;
  const [intPart = '0', fracPart = ''] = s.split('.');
  const milli = Number(intPart) * 1000 + Number(fracPart.padEnd(3, '0') || '0');
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null;
}

export function formatQtyMilli(milli: number): string {
  const intPart = Math.trunc(milli / 1000);
  const frac = String(Math.abs(milli % 1000)).padStart(3, '0').replace(/0+$/, '');
  return frac ? `${intPart}.${frac}` : String(intPart);
}

/** PREVIEW line total: round(unitPaisa × qtyMilli / 1000), half-up — mirrors core's costOfQty. */
export function previewLineTotal(unitPaisa: number, qtyMilli: number): number {
  return Math.round((unitPaisa * qtyMilli) / 1000);
}
