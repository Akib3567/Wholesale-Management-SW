import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { newUlid } from '@leather-erp/core';
import {
  branches,
  productMerges,
  products,
  settings,
  SHARED_BRANCH,
  SYNC_CHILD_TABLES,
  SYNC_PARENT_TABLES,
  syncLog,
  syncState,
  type SyncParentTable,
} from '@leather-erp/db';
import {
  buildManifest,
  openPacket,
  peekPacketMeta,
  sealPacket,
  SyncPacketError,
  type BranchMeta,
  type PacketRow,
  type PacketTables,
  type SyncPacket,
} from '@leather-erp/sync';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../errors';
import { writeAudit } from './audit';
import { nextChangeSeq, nowIso } from './change-seq';
import { requireInstall, type ServiceDeps } from './deps';

const PASSPHRASE_KEY = 'sync_passphrase';

export const passphraseSchema = z.object({
  passphrase: z.string().min(8, 'Sync passphrase must be at least 8 characters'),
});

export const exportSchema = z.object({
  /** Watermark bucket; 'HUB' by default (branch->hub carry). */
  destBranch: z.string().trim().min(1).max(20).default('HUB'),
  /** Ignore the watermark and export everything (safe resend after a lost pendrive). */
  full: z.boolean().default(false),
  outDir: z.string().min(1).optional(),
});

export const importSchema = z.object({ filePath: z.string().min(1) });

export const uploadSchema = z.object({
  fileName: z.string().trim().max(200).optional(),
  fileBase64: z.string().min(1),
});

export const mergeProductSchema = z.object({
  provisionalId: z.string().min(1),
  /** Merge into this existing master; omit to create a new master from the provisional. */
  masterId: z.string().min(1).optional(),
});

export interface ExportResult {
  filePath: string;
  packetId: string;
  kind: 'branch' | 'combined';
  fromSeq: number;
  toSeq: number;
  counts: Record<string, number>;
  totalRows: number;
}

export interface ImportCounts {
  inserted: number;
  updated: number;
  skippedOwn: number;
  skippedUnchanged: number;
  mergedProducts: number;
}

export interface ImportResult {
  senderBranch: string;
  kind: 'branch' | 'combined';
  packetId: string;
  counts: ImportCounts;
  branchesSeen: string[];
}

export class SyncService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly dbPath: string,
  ) {}

  // ---------- passphrase ----------

  isPassphraseSet(): boolean {
    return this.readPassphrase() !== null;
  }

  setPassphrase(input: z.input<typeof passphraseSchema>, actorId: string | null): void {
    const { passphrase } = passphraseSchema.parse(input);
    this.deps.sqlite
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = ?`,
      )
      .run(PASSPHRASE_KEY, JSON.stringify(passphrase), nowIso());
    writeAudit(this.deps.db, { userId: actorId, action: 'sync.set_passphrase' });
  }

  private readPassphrase(): string | null {
    const row = this.deps.db.select().from(settings).where(eq(settings.key, PASSPHRASE_KEY)).get();
    if (!row) return null;
    const value: unknown = JSON.parse(row.value);
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private requirePassphrase(): string {
    const p = this.readPassphrase();
    if (!p) {
      throw new ConflictError('Sync passphrase is not set — configure it in Settings first');
    }
    return p;
  }

  /** Default folder packets are written to / served from (beside the DB file). */
  private defaultPacketDir(): string {
    return resolve(join(dirname(this.dbPath), 'sync-packets'));
  }

  /**
   * Read a previously-exported packet for download. Basename only and must
   * end in .packet — no path traversal, no reading arbitrary files.
   */
  readPacketForDownload(name: string): { fileName: string; buffer: Buffer } {
    const base = name.replace(/^.*[\\/]/, '');
    if (!base.endsWith('.packet') || base.includes('..')) {
      throw new BadRequestError('Invalid packet file name');
    }
    const filePath = join(this.defaultPacketDir(), base);
    if (!existsSync(filePath)) throw new NotFoundError(`No packet named ${base}`);
    return { fileName: base, buffer: readFileSync(filePath) };
  }

  // ---------- status ----------

  status() {
    const install = this.deps.install.getInstall();
    return {
      branchCode: install?.branchCode ?? null,
      isHub: install?.isHub ?? false,
      passphraseSet: this.isPassphraseSet(),
      state: this.deps.db.select().from(syncState).all(),
      log: this.deps.db.select().from(syncLog).orderBy(desc(syncLog.at)).limit(50).all(),
    };
  }

  // ---------- export ----------

  exportPacket(input: z.input<typeof exportSchema>, actorId: string | null): ExportResult {
    const parsed = exportSchema.parse(input);
    const install = requireInstall(this.deps);
    const passphrase = this.requirePassphrase();

    const fromSeq = parsed.full ? 0 : this.lastExportSeq(parsed.destBranch);
    const toSeq = this.currentSeq();
    const tables = this.collectOwnRows(install.branchCode, install.isHub, fromSeq);

    const packet: SyncPacket = {
      header: {
        formatVersion: 1,
        packetId: newUlid(),
        kind: 'branch',
        senderBranch: install.branchCode,
        senderIsHub: install.isHub,
        createdAt: nowIso(),
        watermark: { fromSeq, toSeq },
      },
      branches: this.branchMetas(),
      tables,
    };

    return this.writePacket(packet, passphrase, parsed.destBranch, toSeq, parsed.outDir, actorId);
  }

  /** Hub only: full snapshot of EVERY branch's rows (incl. SHARED + merges). */
  buildCombinedPacket(input: { outDir?: string | undefined }, actorId: string | null): ExportResult {
    const install = requireInstall(this.deps);
    if (!install.isHub) throw new ForbiddenError('Only the hub can build a combined packet');
    const passphrase = this.requirePassphrase();

    const tables: PacketTables = {};
    for (const table of SYNC_PARENT_TABLES) {
      tables[table] = this.deps.sqlite.prepare(`SELECT * FROM ${table}`).all() as PacketRow[];
    }
    for (const child of SYNC_CHILD_TABLES) {
      tables[child.table] = this.deps.sqlite
        .prepare(`SELECT * FROM ${child.table}`)
        .all() as PacketRow[];
    }

    const toSeq = this.currentSeq();
    const packet: SyncPacket = {
      header: {
        formatVersion: 1,
        packetId: newUlid(),
        kind: 'combined',
        senderBranch: install.branchCode,
        senderIsHub: true,
        createdAt: nowIso(),
        watermark: { fromSeq: 0, toSeq },
      },
      branches: this.branchMetas(),
      tables,
    };
    return this.writePacket(packet, passphrase, 'ALL', toSeq, input.outDir, actorId);
  }

  private writePacket(
    packet: SyncPacket,
    passphrase: string,
    destBranch: string,
    toSeq: number,
    outDir: string | undefined,
    actorId: string | null,
  ): ExportResult {
    const buffer = sealPacket(packet, passphrase);
    const manifest = buildManifest(packet);
    const dir = resolve(outDir ?? join(dirname(this.dbPath), 'sync-packets'));
    mkdirSync(dir, { recursive: true });
    const stamp = packet.header.createdAt.replace(/[-:T]/g, '').slice(0, 14);
    const fileName = `${packet.header.senderBranch}-${packet.header.kind}-${stamp}.packet`;
    const filePath = join(dir, fileName);
    writeFileSync(filePath, buffer);

    const counts = manifest.counts;
    let totalRows = 0;
    for (const n of Object.values(counts)) totalRows += n;

    this.deps.sqlite.transaction(() => {
      if (packet.header.kind === 'branch') {
        this.deps.sqlite
          .prepare(
            `INSERT INTO sync_state (peer_branch, last_export_seq, last_export_at) VALUES (?, ?, ?)
             ON CONFLICT(peer_branch) DO UPDATE SET last_export_seq = excluded.last_export_seq, last_export_at = excluded.last_export_at`,
          )
          .run(destBranch, toSeq, nowIso());
      }
      this.deps.db
        .insert(syncLog)
        .values({
          id: newUlid(),
          direction: 'export',
          peerBranch: destBranch,
          packetSha256: manifest.sha256,
          recordCount: totalRows,
          status: 'ok',
          detail: fileName,
        })
        .run();
    })();

    writeAudit(this.deps.db, {
      userId: actorId,
      action: packet.header.kind === 'combined' ? 'sync.export_combined' : 'sync.export',
      detail: { fileName, totalRows },
    });

    return {
      filePath,
      packetId: packet.header.packetId,
      kind: packet.header.kind,
      fromSeq: packet.header.watermark.fromSeq,
      toSeq,
      counts,
      totalRows,
    };
  }

  // ---------- import ----------

  importPacketFile(input: z.input<typeof importSchema>, actorId: string | null): ImportResult {
    const { filePath } = importSchema.parse(input);
    if (!existsSync(filePath)) throw new NotFoundError(`No file at ${filePath}`);
    return this.importBuffer(readFileSync(filePath), actorId);
  }

  /** Import a packet the UI uploaded (browser file picker) as base64 bytes. */
  importPacketBytes(input: z.input<typeof uploadSchema>, actorId: string | null): ImportResult {
    const { fileBase64 } = uploadSchema.parse(input);
    let buffer: Buffer;
    try {
      buffer = Buffer.from(fileBase64, 'base64');
    } catch {
      throw new BadRequestError('Uploaded packet is not valid base64');
    }
    return this.importBuffer(buffer, actorId);
  }

  private importBuffer(buffer: Buffer, actorId: string | null): ImportResult {
    const install = requireInstall(this.deps);
    const passphrase = this.requirePassphrase();
    const peek = peekPacketMeta(buffer);

    let packet: SyncPacket;
    let sha256: string;
    try {
      const opened = openPacket(buffer, passphrase);
      packet = opened.packet;
      sha256 = opened.manifest.sha256;
    } catch (e) {
      const message = e instanceof SyncPacketError ? e.message : 'Unreadable packet';
      this.logImport(peek?.sender ?? 'UNKNOWN', 'rejected', 0, message, '');
      throw new AppError(400, e instanceof SyncPacketError ? `SYNC_${e.code}` : 'SYNC_BAD_FORMAT', message);
    }

    if (packet.header.senderBranch === install.branchCode) {
      const message = `Packet was exported by this branch (${install.branchCode}) — refusing to import own data as foreign`;
      this.logImport(install.branchCode, 'rejected', 0, message, sha256);
      throw new ConflictError(message);
    }

    try {
      const result = this.deps.sqlite.transaction(() =>
        this.applyPacket(packet, install.branchCode),
      )();
      this.logImport(packet.header.senderBranch, 'ok',
        result.counts.inserted + result.counts.updated, JSON.stringify(result.counts), sha256);
      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'sync.import',
        detail: { from: packet.header.senderBranch, kind: packet.header.kind, ...result.counts },
      });
      return result;
    } catch (e) {
      this.logImport(packet.header.senderBranch, 'failed', 0, e instanceof Error ? e.message : 'unknown', sha256);
      throw e;
    }
  }

  private applyPacket(packet: SyncPacket, myBranch: string): ImportResult {
    const counts: ImportCounts = {
      inserted: 0,
      updated: 0,
      skippedOwn: 0,
      skippedUnchanged: 0,
      mergedProducts: 0,
    };
    const maxSeqByBranch = new Map<string, number>();

    // Register branches we learn about (never demoting anything local).
    for (const b of packet.branches) {
      this.deps.db
        .insert(branches)
        .values({ code: b.code, name: b.name, isHub: b.isHub })
        .onConflictDoNothing()
        .run();
    }

    for (const table of SYNC_PARENT_TABLES) {
      const rows = packet.tables[table] ?? [];
      for (const row of rows) {
        this.upsertParentRow(table, row, myBranch, counts, maxSeqByBranch);
      }
    }
    for (const child of SYNC_CHILD_TABLES) {
      const rows = packet.tables[child.table] ?? [];
      for (const row of rows) {
        this.upsertChildRow(child.table, child.parentTable, child.parentKey, row, myBranch, counts);
      }
    }

    counts.mergedProducts = this.applyProductMerges(myBranch);

    const now = nowIso();
    for (const [branch, maxSeq] of maxSeqByBranch) {
      this.deps.sqlite
        .prepare(
          `INSERT INTO sync_state (peer_branch, last_import_seq, last_import_at) VALUES (?, ?, ?)
           ON CONFLICT(peer_branch) DO UPDATE SET
             last_import_seq = MAX(last_import_seq, excluded.last_import_seq),
             last_import_at = excluded.last_import_at`,
        )
        .run(branch, maxSeq, now);
    }

    return {
      senderBranch: packet.header.senderBranch,
      kind: packet.header.kind,
      packetId: packet.header.packetId,
      counts,
      branchesSeen: [...maxSeqByBranch.keys()],
    };
  }

  private upsertParentRow(
    table: SyncParentTable,
    row: PacketRow,
    myBranch: string,
    counts: ImportCounts,
    maxSeqByBranch: Map<string, number>,
  ): void {
    const id = row['id'];
    const branchCode = row['branch_code'];
    const changeSeq = row['change_seq'];
    if (typeof id !== 'string' || typeof branchCode !== 'string' || typeof changeSeq !== 'number') {
      throw new BadRequestError(`Packet row in '${table}' is missing id/branch_code/change_seq`);
    }

    // RULE 3: imports never touch this branch's own rows.
    if (branchCode === myBranch) {
      counts.skippedOwn += 1;
      return;
    }
    if (branchCode !== SHARED_BRANCH) {
      maxSeqByBranch.set(branchCode, Math.max(maxSeqByBranch.get(branchCode) ?? 0, changeSeq));
    }

    const local = this.deps.sqlite
      .prepare(`SELECT branch_code, change_seq FROM ${table} WHERE id = ?`)
      .get(id) as { branch_code: string; change_seq: number } | undefined;

    if (local && local.branch_code === myBranch) {
      // id collision with an own row — never overwrite, whatever the packet claims
      counts.skippedOwn += 1;
      return;
    }

    const cols = this.tableColumns(table);
    const params: Record<string, unknown> = {};
    for (const col of cols) params[col] = row[col] ?? null;

    if (!local) {
      this.deps.sqlite
        .prepare(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
        )
        .run(params);
      counts.inserted += 1;
    } else if (changeSeq > local.change_seq) {
      const sets = cols.filter((c) => c !== 'id').map((c) => `${c} = @${c}`);
      this.deps.sqlite.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      counts.updated += 1;
    } else {
      counts.skippedUnchanged += 1;
    }
  }

  private upsertChildRow(
    table: string,
    parentTable: SyncParentTable,
    parentKey: string,
    row: PacketRow,
    myBranch: string,
    counts: ImportCounts,
  ): void {
    const id = row['id'];
    const parentId = row[parentKey];
    if (typeof id !== 'string' || typeof parentId !== 'string') {
      throw new BadRequestError(`Packet row in '${table}' is missing id/${parentKey}`);
    }
    const parent = this.deps.sqlite
      .prepare(`SELECT branch_code FROM ${parentTable} WHERE id = ?`)
      .get(parentId) as { branch_code: string } | undefined;
    if (!parent) {
      throw new BadRequestError(
        `Packet row in '${table}' references missing ${parentTable} ${parentId}`,
      );
    }
    if (parent.branch_code === myBranch) {
      counts.skippedOwn += 1;
      return;
    }
    const cols = this.tableColumns(table);
    const params: Record<string, unknown> = {};
    for (const col of cols) params[col] = row[col] ?? null;
    const result = this.deps.sqlite
      .prepare(
        `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
      )
      .run(params);
    if (result.changes > 0) counts.inserted += 1;
    else counts.skippedUnchanged += 1;
  }

  /**
   * Apply hub merge instructions to local product rows. Own provisional rows
   * get a change_seq bump (the fix must propagate onward); foreign copies are
   * corrected in place as part of import.
   */
  private applyProductMerges(myBranch: string): number {
    const pending = this.deps.sqlite
      .prepare(
        `SELECT pm.provisional_id AS provisionalId, pm.master_id AS masterId, p.branch_code AS branchCode
         FROM product_merges pm
         JOIN products p ON p.id = pm.provisional_id
         WHERE p.master_id IS NULL`,
      )
      .all() as Array<{ provisionalId: string; masterId: string; branchCode: string }>;

    for (const m of pending) {
      if (m.branchCode === myBranch) {
        this.deps.sqlite
          .prepare(
            `UPDATE products SET master_id = ?, is_active = 0, change_seq = ?, updated_at = ? WHERE id = ?`,
          )
          .run(m.masterId, nextChangeSeq(this.deps.sqlite), nowIso(), m.provisionalId);
      } else {
        this.deps.sqlite
          .prepare(`UPDATE products SET master_id = ?, is_active = 0, updated_at = ? WHERE id = ?`)
          .run(m.masterId, nowIso(), m.provisionalId);
      }
    }
    return pending.length;
  }

  // ---------- hub: provisional product merge ----------

  mergeProvisionalProduct(
    input: z.input<typeof mergeProductSchema>,
    actorId: string | null,
  ): { provisionalId: string; masterId: string } {
    const parsed = mergeProductSchema.parse(input);
    const install = requireInstall(this.deps);
    if (!install.isHub) throw new ForbiddenError('Only the hub can merge provisional products');

    return this.deps.sqlite.transaction(() => {
      const provisional = this.deps.db
        .select()
        .from(products)
        .where(eq(products.id, parsed.provisionalId))
        .get();
      if (!provisional) throw new NotFoundError('Provisional product not found');
      if (!provisional.isProvisional) throw new BadRequestError('Product is not provisional');
      if (provisional.masterId) throw new ConflictError('Product is already merged');

      let masterId = parsed.masterId ?? null;
      if (masterId) {
        const master = this.deps.db.select().from(products).where(eq(products.id, masterId)).get();
        if (!master) throw new NotFoundError('Master product not found');
        if (master.isProvisional || master.branchCode !== SHARED_BRANCH) {
          throw new BadRequestError('Target product is not a SHARED master product');
        }
      } else {
        masterId = newUlid();
        this.deps.db
          .insert(products)
          .values({
            id: masterId,
            branchCode: SHARED_BRANCH,
            changeSeq: nextChangeSeq(this.deps.sqlite),
            name: provisional.name,
            sku: provisional.sku,
            unit: provisional.unit,
            category: provisional.category,
            reorderLevelMilli: provisional.reorderLevelMilli,
            isProvisional: false,
            createdBy: actorId,
          })
          .run();
      }

      this.deps.db
        .insert(productMerges)
        .values({
          id: newUlid(),
          branchCode: SHARED_BRANCH,
          changeSeq: nextChangeSeq(this.deps.sqlite),
          provisionalId: provisional.id,
          masterId,
          createdBy: actorId,
        })
        .run();

      // Correct the hub's local (foreign) copy right away; the origin branch
      // applies it to ITS own row when it imports the next combined packet.
      this.deps.sqlite
        .prepare(`UPDATE products SET master_id = ?, is_active = 0, updated_at = ? WHERE id = ?`)
        .run(masterId, nowIso(), provisional.id);

      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'sync.merge_product',
        tableName: 'products',
        recordId: provisional.id,
        detail: { masterId },
      });
      return { provisionalId: provisional.id, masterId };
    })();
  }

  // ---------- helpers ----------

  private currentSeq(): number {
    const row = this.deps.sqlite
      .prepare('SELECT next_change_seq AS seq FROM this_install WHERE id = 1')
      .get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  private lastExportSeq(destBranch: string): number {
    const row = this.deps.db
      .select()
      .from(syncState)
      .where(eq(syncState.peerBranch, destBranch))
      .get();
    return row?.lastExportSeq ?? 0;
  }

  private branchMetas(): BranchMeta[] {
    return this.deps.db
      .select()
      .from(branches)
      .all()
      .map((b) => ({ code: b.code, name: b.name, isHub: b.isHub }));
  }

  /** Own-branch rows (plus SHARED rows when hub) with change_seq > sinceSeq, children included. */
  private collectOwnRows(myBranch: string, isHub: boolean, sinceSeq: number): PacketTables {
    const owners = isHub ? [myBranch, SHARED_BRANCH] : [myBranch];
    const ph = owners.map(() => '?').join(', ');
    const tables: PacketTables = {};

    for (const table of SYNC_PARENT_TABLES) {
      tables[table] = this.deps.sqlite
        .prepare(
          `SELECT * FROM ${table} WHERE branch_code IN (${ph}) AND change_seq > ? ORDER BY change_seq`,
        )
        .all(...owners, sinceSeq) as PacketRow[];
    }
    for (const child of SYNC_CHILD_TABLES) {
      tables[child.table] = this.deps.sqlite
        .prepare(
          `SELECT c.* FROM ${child.table} c
           JOIN ${child.parentTable} p ON p.id = c.${child.parentKey}
           WHERE p.branch_code IN (${ph}) AND p.change_seq > ?`,
        )
        .all(...owners, sinceSeq) as PacketRow[];
    }
    return tables;
  }

  private columnCache = new Map<string, string[]>();

  private tableColumns(table: string): string[] {
    let cols = this.columnCache.get(table);
    if (!cols) {
      cols = (this.deps.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
        (c) => c.name,
      );
      if (cols.length === 0) throw new Error(`Unknown table ${table}`);
      this.columnCache.set(table, cols);
    }
    return cols;
  }

  private logImport(
    peerBranch: string,
    status: 'ok' | 'rejected' | 'failed',
    recordCount: number,
    detail: string,
    sha256: string,
  ): void {
    this.deps.db
      .insert(syncLog)
      .values({
        id: newUlid(),
        direction: 'import',
        peerBranch,
        packetSha256: sha256,
        recordCount,
        status,
        detail,
      })
      .run();
  }
}
