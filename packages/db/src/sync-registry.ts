/**
 * The tables that travel in sync packets, in import order (FK targets first).
 *
 * Parent tables carry the sync columns (id ULID, branch_code, change_seq…)
 * and are exported changes-only by change_seq watermark. Child tables are
 * immutable line rows exported alongside their parent and upserted by id.
 */
export const SYNC_PARENT_TABLES = [
  'parties',
  'products',
  'product_merges',
  'journal_entries',
  'purchases',
  'sales',
  'payments',
  'expenses',
  'stock_moves',
  'daily_closing',
] as const;
export type SyncParentTable = (typeof SYNC_PARENT_TABLES)[number];

export interface SyncChildSpec {
  table: string;
  parentTable: SyncParentTable;
  /** Column on the child that references the parent's id. */
  parentKey: string;
}

export const SYNC_CHILD_TABLES: readonly SyncChildSpec[] = [
  { table: 'journal_lines', parentTable: 'journal_entries', parentKey: 'entry_id' },
  { table: 'purchase_items', parentTable: 'purchases', parentKey: 'purchase_id' },
  { table: 'sale_items', parentTable: 'sales', parentKey: 'sale_id' },
];
