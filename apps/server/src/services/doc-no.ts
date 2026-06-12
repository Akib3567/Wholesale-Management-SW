import type { Sqlite } from './change-seq';

/**
 * Next document number for this branch: PREFIX-000001, PREFIX-000002, …
 * Zero-padded so lexicographic order == numeric order. Per-branch sequences
 * never collide across branches because doc_no is unique per (branch, doc_no)
 * and packets never mix ownership. Call inside the inserting transaction.
 */
export function nextDocNo(
  sqlite: Sqlite,
  table: 'purchases' | 'sales',
  branchCode: string,
  prefix: string,
): string {
  const row = sqlite
    .prepare(
      `SELECT doc_no FROM ${table} WHERE branch_code = ? AND doc_no LIKE ? ORDER BY doc_no DESC LIMIT 1`,
    )
    .get(branchCode, `${prefix}-%`) as { doc_no: string } | undefined;
  const last = row ? Number.parseInt(row.doc_no.slice(prefix.length + 1), 10) : 0;
  return `${prefix}-${String(last + 1).padStart(6, '0')}`;
}
