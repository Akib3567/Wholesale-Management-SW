import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema/index';

export type DbSchema = typeof schema;
export type Db = BetterSQLite3Database<DbSchema>;

export interface OpenDatabaseResult {
  /** Raw better-sqlite3 handle (transactions, pragmas, backup API). */
  sqlite: Database.Database;
  /** Drizzle instance over the same connection. */
  db: Db;
}

export interface OpenDatabaseOptions {
  readonly?: boolean;
}

/** Open (or create) a database file with the pragmas every install runs with. */
export function openDatabase(
  filePath: string,
  options: OpenDatabaseOptions = {},
): OpenDatabaseResult {
  const sqlite = new Database(filePath, { readonly: options.readonly ?? false });
  if (!options.readonly) {
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
