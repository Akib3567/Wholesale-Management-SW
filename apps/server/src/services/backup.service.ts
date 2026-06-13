import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { newUlid } from '@leather-erp/core';
import {
  backups,
  openDatabase,
  pendingRestorePath,
  settings,
  type BACKUP_KINDS,
} from '@leather-erp/db';
import { decryptAesGcm, deriveKeys, encryptAesGcm, newSalt } from '@leather-erp/sync';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../errors';
import { writeAudit } from './audit';
import { nowIso } from './change-seq';
import type { ServiceDeps } from './deps';

type BackupKind = (typeof BACKUP_KINDS)[number];

const PASSPHRASE_KEY = 'backup_passphrase';
const MAGIC = Buffer.from('LBK1');

/** How many of each kind to keep; older ones are pruned. */
export const RETENTION: Record<BackupKind, number> = {
  manual: Number.POSITIVE_INFINITY,
  daily: 14,
  weekly: 8,
  monthly: 12,
  yearly: Number.POSITIVE_INFINITY,
  on_close: 10,
};

export const backupPassphraseSchema = z.object({
  passphrase: z.string().min(8, 'Backup passphrase must be at least 8 characters'),
});

export interface BackupRecord {
  id: string;
  kind: BackupKind;
  filePath: string;
  sizeBytes: number;
  sha256: string;
  takenAt: string;
  status: string;
}

interface BackupHeader {
  version: 1;
  kind: BackupKind;
  salt: string;
  iv: string;
  tag: string;
  /** SHA-256 of the plaintext snapshot — verified on restore. */
  sha256: string;
  createdAt: string;
}

export class BackupService {
  private readonly backupDir: string;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly dbPath: string,
    backupDir?: string,
  ) {
    this.backupDir = resolve(backupDir ?? join(dirname(dbPath), 'backups'));
  }

  // ---------- passphrase ----------

  isPassphraseSet(): boolean {
    return this.readPassphrase() !== null;
  }

  setPassphrase(input: z.input<typeof backupPassphraseSchema>, actorId: string | null): void {
    const { passphrase } = backupPassphraseSchema.parse(input);
    const existing = this.readPassphrase();
    if (existing && this.hasBackups()) {
      // Old backups were encrypted with the old key; changing it would orphan them.
      throw new ConflictError(
        'Backup passphrase is already set and backups exist. Changing it would make existing backups unreadable.',
      );
    }
    this.deps.sqlite
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = ?`,
      )
      .run(PASSPHRASE_KEY, JSON.stringify(passphrase), nowIso());
    writeAudit(this.deps.db, { userId: actorId, action: 'backup.set_passphrase' });
  }

  private readPassphrase(): string | null {
    const row = this.deps.db.select().from(settings).where(eq(settings.key, PASSPHRASE_KEY)).get();
    if (!row) return null;
    const value: unknown = JSON.parse(row.value);
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private requirePassphrase(): string {
    const p = this.readPassphrase();
    if (!p) throw new ConflictError('Backup passphrase is not set — configure it in Backups first');
    return p;
  }

  private hasBackups(): boolean {
    return this.deps.db.select({ id: backups.id }).from(backups).limit(1).get() !== undefined;
  }

  // ---------- snapshot + encrypt ----------

  /**
   * Take a consistent snapshot (VACUUM INTO — never a raw copy of a live DB),
   * gzip, AES-256-GCM encrypt, hash, write to backups/, log it, then prune.
   */
  createBackup(kind: BackupKind, actorId: string | null): BackupRecord {
    const passphrase = this.requirePassphrase();
    mkdirSync(this.backupDir, { recursive: true });

    const stamp = nowIso().replace(/[-:T]/g, '').slice(0, 14);
    const snapshotPath = join(this.backupDir, `.snapshot-${stamp}-${Math.random().toString(36).slice(2)}.tmp`);

    let plaintext: Buffer;
    try {
      // VACUUM INTO produces a clean, fully-checkpointed copy of the live DB.
      this.deps.sqlite.prepare('VACUUM INTO ?').run(snapshotPath);
      plaintext = readFileSync(snapshotPath);
    } finally {
      rmSync(snapshotPath, { force: true });
    }

    const sha256 = createHash('sha256').update(plaintext).digest('hex');
    const salt = newSalt();
    const keys = deriveKeys(passphrase, salt);
    const blob = encryptAesGcm(keys.encKey, gzipSync(plaintext));

    const header: BackupHeader = {
      version: 1,
      kind,
      salt: salt.toString('base64'),
      iv: blob.iv.toString('base64'),
      tag: blob.tag.toString('base64'),
      sha256,
      createdAt: nowIso(),
    };
    const file = this.frame(header, blob.data);
    const id = newUlid();
    // id in the name guarantees uniqueness even for many backups within one second.
    const fileName = `${kind}-${stamp}-${id.slice(-8)}.backup`;
    const filePath = join(this.backupDir, fileName);
    writeFileSync(filePath, file);
    this.deps.db
      .insert(backups)
      .values({
        id,
        kind,
        filePath,
        sizeBytes: file.length,
        sha256,
        status: 'ok',
      })
      .run();
    writeAudit(this.deps.db, {
      userId: actorId,
      action: 'backup.create',
      tableName: 'backups',
      recordId: id,
      detail: { kind, sizeBytes: file.length },
    });

    this.prune(kind);
    return this.get(id);
  }

  // ---------- list / prune ----------

  list(): BackupRecord[] {
    return this.deps.db
      .select()
      .from(backups)
      .orderBy(desc(backups.takenAt))
      .all()
      .map((b) => ({
        id: b.id,
        kind: b.kind,
        filePath: b.filePath,
        sizeBytes: b.sizeBytes,
        sha256: b.sha256,
        takenAt: b.takenAt,
        status: b.status,
      }));
  }

  get(id: string): BackupRecord {
    const b = this.deps.db.select().from(backups).where(eq(backups.id, id)).get();
    if (!b) throw new NotFoundError('Backup not found');
    return {
      id: b.id,
      kind: b.kind,
      filePath: b.filePath,
      sizeBytes: b.sizeBytes,
      sha256: b.sha256,
      takenAt: b.takenAt,
      status: b.status,
    };
  }

  /** Keep the newest RETENTION[kind] backups of a kind; delete the rest (file + row). */
  prune(kind: BackupKind): number {
    const keep = RETENTION[kind];
    if (!Number.isFinite(keep)) return 0;
    const all = this.deps.db
      .select()
      .from(backups)
      .where(eq(backups.kind, kind))
      .orderBy(desc(backups.takenAt))
      .all();
    const stale = all.slice(keep);
    for (const b of stale) {
      rmSync(b.filePath, { force: true });
      this.deps.db.delete(backups).where(eq(backups.id, b.id)).run();
    }
    return stale.length;
  }

  // ---------- restore ----------

  /**
   * Verify a backup (decrypt + SHA-256 + integrity check), take a pre-restore
   * SAFETY backup of the current DB, then STAGE the snapshot to be swapped in
   * on next launch (a live SQLite file can't be safely replaced under an open
   * handle). The UI then prompts to restart.
   */
  restore(backupId: string, actorId: string | null): { safetyBackupId: string; staged: true } {
    const passphrase = this.requirePassphrase();
    const record = this.get(backupId);
    if (!existsSync(record.filePath)) {
      throw new NotFoundError(`Backup file is missing: ${record.filePath}`);
    }

    const plaintext = this.decryptVerify(readFileSync(record.filePath), passphrase, record.sha256);
    this.assertLooksLikeOurDb(plaintext);

    // Safety net: snapshot the current state before we replace it.
    const safety = this.createBackup('manual', actorId);

    writeFileSync(pendingRestorePath(this.dbPath), plaintext);
    this.deps.db.update(backups).set({ status: 'restored' }).where(eq(backups.id, backupId)).run();
    writeAudit(this.deps.db, {
      userId: actorId,
      action: 'backup.restore_staged',
      tableName: 'backups',
      recordId: backupId,
      detail: { safetyBackupId: safety.id },
    });
    return { safetyBackupId: safety.id, staged: true };
  }

  /** Verify a backup is decryptable + intact without restoring it. */
  verify(backupId: string): { ok: boolean; sha256Match: boolean } {
    const passphrase = this.requirePassphrase();
    const record = this.get(backupId);
    if (!existsSync(record.filePath)) throw new NotFoundError('Backup file is missing');
    const plaintext = this.decryptVerify(readFileSync(record.filePath), passphrase, record.sha256);
    this.assertLooksLikeOurDb(plaintext);
    return { ok: true, sha256Match: true };
  }

  // ---------- scheduling ----------

  /** Run an on-close backup if a passphrase is configured (best-effort, never throws). */
  backupOnClose(): void {
    if (!this.isPassphraseSet()) return;
    try {
      this.createBackup('on_close', null);
    } catch {
      // closing must not fail because a backup couldn't be written
    }
  }

  // ---------- helpers ----------

  /** [MAGIC][u32 header length][header JSON][ciphertext] — header small, body raw (not base64). */
  private frame(header: BackupHeader, ciphertext: Buffer): Buffer {
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(headerBuf.length, 0);
    return Buffer.concat([MAGIC, lenBuf, headerBuf, ciphertext]);
  }

  private decryptVerify(file: Buffer, passphrase: string, expectedSha: string): Buffer {
    if (file.length < 8 || !file.subarray(0, 4).equals(MAGIC)) {
      throw new BadRequestError('Not a leather-erp backup file');
    }
    const headerLen = file.readUInt32LE(4);
    let header: BackupHeader;
    try {
      header = JSON.parse(file.subarray(8, 8 + headerLen).toString('utf8')) as BackupHeader;
    } catch {
      throw new BadRequestError('Backup header is corrupt');
    }
    const ciphertext = file.subarray(8 + headerLen);
    const keys = deriveKeys(passphrase, Buffer.from(header.salt, 'base64'));
    let plaintext: Buffer;
    try {
      const gz = decryptAesGcm(keys.encKey, {
        iv: Buffer.from(header.iv, 'base64'),
        tag: Buffer.from(header.tag, 'base64'),
        data: ciphertext,
      });
      plaintext = gunzipSync(gz);
    } catch {
      throw new AppError(
        400,
        'BACKUP_DECRYPT_FAILED',
        'Could not decrypt backup — wrong backup passphrase, or the file is corrupted',
      );
    }
    const actual = createHash('sha256').update(plaintext).digest('hex');
    if (actual !== expectedSha || actual !== header.sha256) {
      throw new AppError(400, 'BACKUP_HASH_MISMATCH', 'Backup hash verification failed');
    }
    return plaintext;
  }

  /** Open the decrypted bytes as a throwaway DB and sanity-check it's really ours. */
  private assertLooksLikeOurDb(plaintext: Buffer): void {
    const tmp = join(this.backupDir, `.verify-${newUlid()}.tmp`);
    mkdirSync(this.backupDir, { recursive: true });
    writeFileSync(tmp, plaintext);
    try {
      const { sqlite } = openDatabase(tmp, { readonly: true });
      try {
        const integrity = sqlite.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') throw new AppError(400, 'BACKUP_CORRUPT', 'Backup failed integrity check');
        const row = sqlite
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='this_install'`)
          .get();
        if (!row) throw new AppError(400, 'BACKUP_NOT_RECOGNISED', 'Backup is not a leather-erp database');
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}
