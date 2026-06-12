import { sql } from 'drizzle-orm';
import { integer, text } from 'drizzle-orm/sqlite-core';

/**
 * Owner branch code for rows mastered at the hub (master products, shared
 * parties). Only the hub install may edit SHARED rows; everyone else
 * receives them read-only via sync. 'SHARED' is not a row in `branches`,
 * which is why branch_code columns are plain TEXT without a foreign key.
 */
export const SHARED_BRANCH = 'SHARED';

/** ISO-8601 UTC with milliseconds, e.g. 2026-06-12T10:30:45.123Z. */
export const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const timestamps = {
  createdAt: text('created_at').notNull().default(isoNow),
  updatedAt: text('updated_at').notNull().default(isoNow),
};

/**
 * Identity + sync columns shared by every syncable table.
 *
 * - id: ULID, globally unique across branches — sync upserts key on it.
 * - branch_code: owner branch (or 'SHARED'). Only the owner may edit.
 * - change_seq: this install's per-branch monotonic counter, bumped on every
 *   insert/update of an own-branch row; drives changes-only export.
 * - is_deleted: soft delete for non-financial rows; financial rows are never
 *   deleted at all (corrections post reversing entries).
 *
 * Child line tables (journal_lines, purchase_items, sale_items) do NOT carry
 * these columns: lines are immutable once posted and travel inside their
 * parent's sync record, inheriting the parent's ownership.
 */
export const syncColumns = {
  id: text('id').primaryKey(),
  branchCode: text('branch_code').notNull(),
  changeSeq: integer('change_seq').notNull(),
  isDeleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
  createdBy: text('created_by'),
};
