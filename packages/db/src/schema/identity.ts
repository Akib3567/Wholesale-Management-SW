import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { isoNow, timestamps } from './columns';

/** Known branch codes and display names. Rows are auto-registered on sync import. */
export const branches = sqliteTable('branches', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  isHub: integer('is_hub', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(isoNow),
});

/**
 * Single-row table: this PC's identity, set once at first launch, immutable.
 * next_change_seq is THE per-branch change counter — every insert/update of
 * an own-branch syncable row takes the next value from here.
 */
export const thisInstall = sqliteTable(
  'this_install',
  {
    id: integer('id').primaryKey(),
    branchCode: text('branch_code').notNull(),
    isHub: integer('is_hub', { mode: 'boolean' }).notNull().default(false),
    nextChangeSeq: integer('next_change_seq').notNull().default(0),
    installedAt: text('installed_at').notNull().default(isoNow),
  },
  (t) => [check('this_install_single_row', sql`${t.id} = 1`)],
);

export const USER_ROLES = ['admin', 'manager', 'operator', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Local auth per install — users are not synced between branches. */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_username_uq').on(t.username)],
);

/** Key/value settings; values are JSON strings. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(isoNow),
});

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  action: text('action').notNull(),
  tableName: text('table_name'),
  recordId: text('record_id'),
  detailJson: text('detail_json'),
  at: text('at').notNull().default(isoNow),
});
