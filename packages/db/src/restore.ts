import { existsSync, renameSync, rmSync } from 'node:fs';

/** A pending restore is staged next to the DB and swapped in before opening. */
export function pendingRestorePath(dbPath: string): string {
  return `${dbPath}.restore-pending`;
}

/**
 * If a verified restore was staged, swap it in for the live DB. Must run
 * BEFORE the database is opened — you cannot safely replace a SQLite file
 * under an open handle (especially on Windows). Returns true if applied.
 */
export function applyPendingRestore(dbPath: string): boolean {
  const pending = pendingRestorePath(dbPath);
  if (!existsSync(pending)) return false;
  // Drop the current db and its WAL sidecars, then promote the staged file.
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  renameSync(pending, dbPath);
  return true;
}
