import type { OpenDatabaseResult } from '@leather-erp/db';
import { InstallNotConfiguredError } from '../errors';

export type Sqlite = OpenDatabaseResult['sqlite'];

/**
 * Claim the next change_seq for this install's own branch. Must be called
 * inside the same transaction that writes the row it stamps, so a rolled-back
 * write also rolls the counter back (no gaps, no phantom sequences).
 */
export function nextChangeSeq(sqlite: Sqlite): number {
  const row = sqlite
    .prepare(
      'UPDATE this_install SET next_change_seq = next_change_seq + 1 WHERE id = 1 RETURNING next_change_seq',
    )
    .get() as { next_change_seq: number } | undefined;
  if (!row) throw new InstallNotConfiguredError();
  return row.next_change_seq;
}

/** Current ISO-8601 UTC timestamp for updated_at stamping. */
export function nowIso(): string {
  return new Date().toISOString();
}
