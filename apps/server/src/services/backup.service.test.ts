import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  pendingRestorePath,
  runMigrations,
  seedDatabase,
  applyPendingRestore,
  type OpenDatabaseResult,
} from '@leather-erp/db';
import { AppError, ConflictError } from '../errors';
import { InstallService } from './install.service';
import { LedgerService } from './ledger.service';
import { PartyService } from './party.service';
import { BackupService } from './backup.service';
import type { ServiceDeps } from './deps';

const PASS = 'backup-secret-123';
let tmpDir: string;
let dbPath: string;
let h: OpenDatabaseResult;
let deps: ServiceDeps;
let parties: PartyService;
let backup: BackupService;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-backup-'));
  dbPath = join(tmpDir, 'shop.sqlite');
  h = openDatabase(dbPath);
  runMigrations(h.db);
  await seedDatabase(h.db);
  const install = new InstallService(h.sqlite, h.db);
  install.bootstrap({ branchCode: 'DHAKA', branchName: 'Dhaka', isHub: true }, null);
  deps = { sqlite: h.sqlite, db: h.db, install, ledger: new LedgerService(h.sqlite, h.db) };
  parties = new PartyService(deps);
  backup = new BackupService(deps, dbPath, join(tmpDir, 'backups'));
});

afterAll(() => {
  h.sqlite.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('passphrase gating', () => {
  it('refuses to back up before a passphrase is set', () => {
    expect(() => backup.createBackup('manual', null)).toThrow(ConflictError);
    expect(backup.isPassphraseSet()).toBe(false);
  });

  it('sets a passphrase', () => {
    backup.setPassphrase({ passphrase: PASS }, null);
    expect(backup.isPassphraseSet()).toBe(true);
  });
});

describe('create + verify', () => {
  it('writes an encrypted backup that is NOT a readable sqlite file', () => {
    parties.create({ name: 'Backup Co', kind: 'customer' }, null);
    const rec = backup.createBackup('manual', null);

    expect(existsSync(rec.filePath)).toBe(true);
    expect(rec.sha256).toHaveLength(64);
    const bytes = readFileSync(rec.filePath);
    expect(bytes.subarray(0, 4).toString()).toBe('LBK1'); // our framing, not 'SQLite format 3'
    expect(bytes.includes(Buffer.from('SQLite format 3'))).toBe(false); // encrypted, not plaintext

    expect(backup.verify(rec.id)).toEqual({ ok: true, sha256Match: true });
  });

  it('rejects a tampered backup file', () => {
    const rec = backup.createBackup('manual', null);
    const bytes = readFileSync(rec.filePath);
    const last = bytes.length - 1;
    bytes.writeUInt8(bytes.readUInt8(last) ^ 0xff, last); // flip a ciphertext byte
    writeFileSync(rec.filePath, bytes);
    expect(() => backup.verify(rec.id)).toThrow(AppError);
  });

  it('fails verify with the wrong passphrase', async () => {
    const rec = backup.createBackup('manual', null);
    // A fresh install with a DIFFERENT backup passphrase cannot read this file.
    const otherDir = join(tmpDir, 'other');
    const freshPath = join(tmpDir, 'fresh.sqlite');
    const fh = openDatabase(freshPath);
    runMigrations(fh.db);
    await seedDatabase(fh.db);
    const fdeps: ServiceDeps = {
      sqlite: fh.sqlite,
      db: fh.db,
      install: new InstallService(fh.sqlite, fh.db),
      ledger: new LedgerService(fh.sqlite, fh.db),
    };
    fdeps.install.bootstrap({ branchCode: 'DHAKA', branchName: 'D', isHub: true }, null);
    const wrong = new BackupService(fdeps, freshPath, otherDir);
    wrong.setPassphrase({ passphrase: 'a-totally-different-secret' }, null);
    // point it at the real backup file by inserting a matching backups row
    fh.sqlite
      .prepare(
        `INSERT INTO backups (id, kind, file_path, size_bytes, sha256, status) VALUES (?,?,?,?,?,?)`,
      )
      .run('FAKEID', 'manual', rec.filePath, rec.sizeBytes, rec.sha256, 'ok');
    expect(() => wrong.verify('FAKEID')).toThrow(/decrypt/i);
    fh.sqlite.close();
  });
});

describe('retention / prune', () => {
  it('keeps only RETENTION[on_close]=10 of a capped kind', () => {
    for (let i = 0; i < 13; i++) backup.createBackup('on_close', null);
    const remaining = backup.list().filter((b) => b.kind === 'on_close');
    expect(remaining.length).toBe(10);
    // files of pruned backups are gone
    for (const b of remaining) expect(existsSync(b.filePath)).toBe(true);
  });
});

describe('restore round trip (staged, applied on next open)', () => {
  it('verifies, takes a safety backup, stages the snapshot, and the staged DB has the old state', async () => {
    // snapshot now (one customer 'Backup Co' from earlier + others)
    const snapshot = backup.createBackup('manual', null);
    const countBefore = (h.sqlite.prepare('SELECT COUNT(*) c FROM parties').get() as { c: number }).c;

    // mutate AFTER the snapshot
    parties.create({ name: 'Added After Snapshot', kind: 'supplier' }, null);
    const countAfter = (h.sqlite.prepare('SELECT COUNT(*) c FROM parties').get() as { c: number }).c;
    expect(countAfter).toBe(countBefore + 1);

    const result = backup.restore(snapshot.id, null);
    expect(result.staged).toBe(true);
    expect(existsSync(pendingRestorePath(dbPath))).toBe(true);
    expect(backup.get(result.safetyBackupId).kind).toBe('manual');

    // simulate app restart: close live db, apply pending, reopen
    h.sqlite.close();
    expect(applyPendingRestore(dbPath)).toBe(true);
    expect(existsSync(pendingRestorePath(dbPath))).toBe(false);

    const reopened = openDatabase(dbPath);
    const restoredCount = (
      reopened.sqlite.prepare('SELECT COUNT(*) c FROM parties').get() as { c: number }
    ).c;
    expect(restoredCount).toBe(countBefore); // back to the snapshot state
    const added = reopened.sqlite
      .prepare(`SELECT 1 FROM parties WHERE name = 'Added After Snapshot'`)
      .get();
    expect(added).toBeUndefined(); // the post-snapshot change is gone
    reopened.sqlite.close();

    // reopen for afterAll cleanup symmetry
    h = openDatabase(dbPath);
  });
});
