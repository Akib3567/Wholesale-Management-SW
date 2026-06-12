import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { syncColumns, timestamps } from './columns';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Chart of accounts. Seeded identically on every install with DETERMINISTIC
 * ids ('ACC-<code>') so journal lines reference the same account ids on all
 * branches. v1: accounts are system-seeded only (no per-branch custom
 * accounts), which keeps cross-branch reports consistent by construction.
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: ACCOUNT_TYPES }).notNull(),
    isCash: integer('is_cash', { mode: 'boolean' }).notNull().default(false),
    isBank: integer('is_bank', { mode: 'boolean' }).notNull().default(false),
    parentId: text('parent_id').references((): AnySQLiteColumn => accounts.id),
    isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('accounts_code_uq').on(t.code)],
);

export const JOURNAL_REF_TYPES = [
  'purchase',
  'sale',
  'payment',
  'receipt',
  'expense',
  'return',
  'opening',
  'adjustment',
] as const;
export type JournalRefType = (typeof JOURNAL_REF_TYPES)[number];

/**
 * One header per business event. Never hard-deleted, never edited after
 * posting — corrections post a reversing entry and set is_reversed here.
 */
export const journalEntries = sqliteTable(
  'journal_entries',
  {
    ...syncColumns,
    entryDate: text('entry_date').notNull(), // YYYY-MM-DD
    narration: text('narration').notNull().default(''),
    refType: text('ref_type', { enum: JOURNAL_REF_TYPES }).notNull(),
    refId: text('ref_id'),
    isReversed: integer('is_reversed', { mode: 'boolean' }).notNull().default(false),
    reversedByEntryId: text('reversed_by_entry_id'),
  },
  (t) => [
    index('je_branch_date_idx').on(t.branchCode, t.entryDate),
    index('je_branch_seq_idx').on(t.branchCode, t.changeSeq),
    index('je_ref_idx').on(t.refType, t.refId),
  ],
);

/**
 * Debit/credit lines; per entry Σdebit = Σcredit (enforced by LedgerService
 * inside the posting transaction). Each line is exactly one side, > 0.
 * party_id is a soft reference to parties (no FK: parties live in another
 * branch's packet and may arrive in any order).
 */
export const journalLines = sqliteTable(
  'journal_lines',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id')
      .notNull()
      .references(() => journalEntries.id),
    lineNo: integer('line_no').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    partyId: text('party_id'),
    debitPaisa: integer('debit_paisa').notNull().default(0),
    creditPaisa: integer('credit_paisa').notNull().default(0),
    lineNote: text('line_note'),
  },
  (t) => [
    index('jl_entry_idx').on(t.entryId),
    index('jl_account_idx').on(t.accountId),
    index('jl_party_idx').on(t.partyId),
    check(
      'jl_one_side_positive',
      sql`${t.debitPaisa} >= 0 AND ${t.creditPaisa} >= 0
          AND NOT (${t.debitPaisa} > 0 AND ${t.creditPaisa} > 0)
          AND (${t.debitPaisa} + ${t.creditPaisa}) > 0`,
    ),
  ],
);
