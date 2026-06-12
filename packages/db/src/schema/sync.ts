import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { isoNow } from './columns';

/** Per peer branch: high-water marks for changes-only export/import. */
export const syncState = sqliteTable('sync_state', {
  peerBranch: text('peer_branch').primaryKey(),
  lastExportSeq: integer('last_export_seq').notNull().default(0),
  lastImportSeq: integer('last_import_seq').notNull().default(0),
  lastExportAt: text('last_export_at'),
  lastImportAt: text('last_import_at'),
});

export const SYNC_DIRECTIONS = ['export', 'import'] as const;
export const SYNC_STATUSES = ['ok', 'rejected', 'failed'] as const;

/** Every packet ever exported or imported, success or not. */
export const syncLog = sqliteTable('sync_log', {
  id: text('id').primaryKey(),
  direction: text('direction', { enum: SYNC_DIRECTIONS }).notNull(),
  peerBranch: text('peer_branch').notNull(),
  packetSha256: text('packet_sha256').notNull(),
  recordCount: integer('record_count').notNull().default(0),
  status: text('status', { enum: SYNC_STATUSES }).notNull(),
  detail: text('detail'),
  at: text('at').notNull().default(isoNow),
});

export const BACKUP_KINDS = ['manual', 'daily', 'weekly', 'monthly', 'yearly', 'on_close'] as const;
export const BACKUP_STATUSES = ['ok', 'failed', 'pruned', 'restored'] as const;

export const backups = sqliteTable('backups', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: BACKUP_KINDS }).notNull(),
  filePath: text('file_path').notNull(),
  sizeBytes: integer('size_bytes').notNull().default(0),
  sha256: text('sha256').notNull(),
  takenAt: text('taken_at').notNull().default(isoNow),
  status: text('status', { enum: BACKUP_STATUSES }).notNull().default('ok'),
});
