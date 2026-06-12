import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  runMigrations,
  seedDatabase,
  type OpenDatabaseResult,
} from '@leather-erp/db';
import { sealPacket } from '@leather-erp/sync';
import { AppError, ConflictError } from '../errors';
import { InstallService } from './install.service';
import { LedgerService } from './ledger.service';
import { PartyService } from './party.service';
import { ProductService } from './product.service';
import { PurchaseService } from './purchase.service';
import { SaleService } from './sale.service';
import { ExpenseService } from './expense.service';
import { SyncService } from './sync.service';
import type { ServiceDeps } from './deps';

const PASS = 'company-sync-secret';

interface Node {
  h: OpenDatabaseResult;
  deps: ServiceDeps;
  parties: PartyService;
  products: ProductService;
  purchases: PurchaseService;
  sales: SaleService;
  expenses: ExpenseService;
  sync: SyncService;
}

let tmpDir: string;
let dhk: Node; // hub
let ctg: Node; // branch

async function makeNode(
  file: string,
  branchCode: string,
  isHub: boolean,
  passphrase: string,
): Promise<Node> {
  const dbPath = join(tmpDir, file);
  const h = openDatabase(dbPath);
  runMigrations(h.db);
  await seedDatabase(h.db);
  const install = new InstallService(h.sqlite, h.db);
  install.bootstrap({ branchCode, branchName: branchCode, isHub }, null);
  const deps: ServiceDeps = {
    sqlite: h.sqlite,
    db: h.db,
    install,
    ledger: new LedgerService(h.sqlite, h.db),
  };
  const parties = new PartyService(deps);
  const products = new ProductService(deps);
  const node: Node = {
    h,
    deps,
    parties,
    products,
    purchases: new PurchaseService(deps, parties, products),
    sales: new SaleService(deps, parties, products),
    expenses: new ExpenseService(deps),
    sync: new SyncService(deps, dbPath),
  };
  node.sync.setPassphrase({ passphrase }, null);
  return node;
}

/** Net profit in paisa from journal lines (income − expense), optionally one branch. */
function pnl(node: Node, branchCode?: string): number {
  const row = node.h.sqlite
    .prepare(
      `SELECT COALESCE(SUM(CASE
           WHEN a.type = 'income' THEN l.credit_paisa - l.debit_paisa
           WHEN a.type = 'expense' THEN -(l.debit_paisa - l.credit_paisa)
           ELSE 0 END), 0) AS pnl
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id
       JOIN journal_entries e ON e.id = l.entry_id
       ${branchCode ? 'WHERE e.branch_code = ?' : ''}`,
    )
    .get(...(branchCode ? [branchCode] : [])) as { pnl: number };
  return row.pnl;
}

/** Stable snapshot of every own-branch row, for proving imports never touch them. */
function ownRowsSnapshot(node: Node, branchCode: string): string {
  const tables = ['parties', 'products', 'journal_entries', 'purchases', 'sales', 'payments', 'expenses', 'stock_moves'];
  const parts: string[] = [];
  for (const t of tables) {
    const rows = node.h.sqlite
      .prepare(`SELECT * FROM ${t} WHERE branch_code = ? ORDER BY id`)
      .all(branchCode);
    parts.push(JSON.stringify(rows));
  }
  return parts.join('|');
}

function rowCount(node: Node, table: string): number {
  return (node.h.sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

let ctgProvisionalId: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-sync-'));
  dhk = await makeNode('dhaka.sqlite', 'DHAKA', true, PASS);
  ctg = await makeNode('ctg.sqlite', 'CTG', false, PASS);

  // --- DHAKA business activity: P&L = 1400 − 800 − 50 = +550.00 (55_000 paisa)
  const dSupplier = dhk.parties.create({ name: 'Dhaka Hides', kind: 'supplier' }, null);
  const dCustomer = dhk.parties.create({ name: 'Dhaka Customer', kind: 'customer' }, null);
  const belt = dhk.products.create({ name: 'Leather Belt', unit: 'pcs' }, null);
  dhk.products.create({ name: 'Bifold Wallet', unit: 'pcs' }, null);
  dhk.purchases.create(
    {
      partyId: dSupplier.id,
      docDate: '2026-06-10',
      items: [{ productId: belt.id, qtyMilli: 10_000, unitCostPaisa: 20_000 }],
    },
    null,
  );
  dhk.sales.create(
    {
      partyId: dCustomer.id,
      docDate: '2026-06-11',
      items: [{ productId: belt.id, qtyMilli: 4_000, unitPricePaisa: 35_000 }],
      paidPaisa: 140_000,
    },
    null,
  );
  dhk.expenses.create(
    { expenseAccountId: 'ACC-5120', amountPaisa: 5_000, spentDate: '2026-06-11' },
    null,
  );

  // --- CTG business activity: P&L = 360 − 200 − 20 = +140.00 (14_000 paisa)
  const cSupplier = ctg.parties.create({ name: 'Agrabad Hides', kind: 'supplier' }, null);
  const special = ctg.products.create({ name: 'CTG Special Belt', unit: 'pcs' }, null);
  ctgProvisionalId = special.id;
  ctg.purchases.create(
    {
      partyId: cSupplier.id,
      docDate: '2026-06-10',
      items: [{ productId: special.id, qtyMilli: 5_000, unitCostPaisa: 10_000 }],
    },
    null,
  );
  ctg.sales.create(
    {
      docDate: '2026-06-11',
      items: [{ productId: special.id, qtyMilli: 2_000, unitPricePaisa: 18_000 }],
      paidPaisa: 36_000,
    },
    null,
  );
  ctg.expenses.create(
    { expenseAccountId: 'ACC-5130', amountPaisa: 2_000, spentDate: '2026-06-11' },
    null,
  );
});

afterAll(() => {
  dhk.h.sqlite.close();
  ctg.h.sqlite.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

let dhakaPacket1: string;

describe('DHAKA -> CTG round trip (REQUIRED phase test)', () => {
  it('exports a changes-only branch packet from DHAKA', () => {
    const result = dhk.sync.exportPacket({}, null);
    dhakaPacket1 = result.filePath;
    expect(result.kind).toBe('branch');
    expect(result.counts['parties']).toBe(2);
    expect(result.counts['products']).toBe(2);
    expect(result.counts['purchases']).toBe(1);
    expect(result.counts['sales']).toBe(1);
    expect(result.counts['expenses']).toBe(1);
    expect(result.counts['journal_lines']).toBeGreaterThanOrEqual(8);
    expect(result.fromSeq).toBe(0);
    expect(result.toSeq).toBeGreaterThan(0);
  });

  it('CTG gains DHAKA rows; CTG own rows are byte-identical before/after', () => {
    const before = ownRowsSnapshot(ctg, 'CTG');
    const result = ctg.sync.importPacketFile({ filePath: dhakaPacket1 }, null);

    expect(result.senderBranch).toBe('DHAKA');
    expect(result.counts.inserted).toBeGreaterThan(0);
    expect(result.counts.updated).toBe(0);
    expect(ownRowsSnapshot(ctg, 'CTG')).toBe(before);

    const foreignParties = ctg.h.sqlite
      .prepare(`SELECT name FROM parties WHERE branch_code = 'DHAKA' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(foreignParties.map((p) => p.name)).toEqual(['Dhaka Customer', 'Dhaka Hides']);

    const state = ctg.h.sqlite
      .prepare(`SELECT * FROM sync_state WHERE peer_branch = 'DHAKA'`)
      .get() as { last_import_seq: number; last_import_at: string };
    expect(state.last_import_seq).toBeGreaterThan(0);
    expect(state.last_import_at).toBeTruthy();
  });

  it('re-importing the same packet is a no-op (idempotent)', () => {
    const entriesBefore = rowCount(ctg, 'journal_entries');
    const linesBefore = rowCount(ctg, 'journal_lines');
    const result = ctg.sync.importPacketFile({ filePath: dhakaPacket1 }, null);
    expect(result.counts.inserted).toBe(0);
    expect(result.counts.updated).toBe(0);
    expect(result.counts.skippedUnchanged).toBeGreaterThan(0);
    expect(rowCount(ctg, 'journal_entries')).toBe(entriesBefore);
    expect(rowCount(ctg, 'journal_lines')).toBe(linesBefore);
  });

  it('combined P&L at CTG = DHAKA part + CTG part (REQUIRED phase test)', () => {
    expect(pnl(ctg, 'DHAKA')).toBe(55_000);
    expect(pnl(ctg, 'CTG')).toBe(14_000);
    expect(pnl(ctg)).toBe(69_000);
    expect(pnl(ctg)).toBe(pnl(ctg, 'DHAKA') + pnl(ctg, 'CTG'));
  });

  it('second export carries only NEW changes (watermark)', () => {
    dhk.sales.create(
      {
        docDate: '2026-06-12',
        items: [
          {
            productId: (dhk.products.list({ q: 'Leather Belt' })[0] as { id: string }).id,
            qtyMilli: 1_000,
            unitPricePaisa: 35_000,
          },
        ],
        paidPaisa: 35_000,
      },
      null,
    );
    const result = dhk.sync.exportPacket({}, null);
    expect(result.counts['sales']).toBe(1);
    expect(result.counts['parties']).toBe(0);
    expect(result.counts['products']).toBe(0);
    expect(result.fromSeq).toBeGreaterThan(0);

    ctg.sync.importPacketFile({ filePath: result.filePath }, null);
    // DHAKA P&L now 55_000 + (350 − 200)×100 = 70_000; combined 84_000
    expect(pnl(ctg, 'DHAKA')).toBe(70_000);
    expect(pnl(ctg)).toBe(84_000);
  });
});

describe('import safety', () => {
  it('refuses to import a packet from itself', () => {
    expect(() => dhk.sync.importPacketFile({ filePath: dhakaPacket1 }, null)).toThrow(
      ConflictError,
    );
    const last = dhk.h.sqlite
      .prepare(`SELECT status FROM sync_log WHERE direction='import' ORDER BY at DESC LIMIT 1`)
      .get() as { status: string };
    expect(last.status).toBe('rejected');
  });

  it('a forged packet claiming foreign sender CANNOT touch own rows', () => {
    // Adversarial packet: valid crypto (knows the passphrase), sender says
    // DHAKA, but it carries a modified copy of CTG's OWN party row.
    const ownParty = ctg.h.sqlite
      .prepare(`SELECT * FROM parties WHERE branch_code = 'CTG' LIMIT 1`)
      .get() as Record<string, unknown>;
    const forged = sealPacket(
      {
        header: {
          formatVersion: 1,
          packetId: '01FORGEDPACKET00000000000X',
          kind: 'branch',
          senderBranch: 'DHAKA',
          senderIsHub: true,
          createdAt: new Date().toISOString(),
          watermark: { fromSeq: 0, toSeq: 999 },
        },
        branches: [],
        tables: { parties: [{ ...ownParty, name: 'HACKED NAME', change_seq: 999_999 }] },
      },
      PASS,
    );
    const forgedPath = join(tmpDir, 'forged.packet');
    writeFileSync(forgedPath, forged);

    const result = ctg.sync.importPacketFile({ filePath: forgedPath }, null);
    expect(result.counts.skippedOwn).toBe(1);
    expect(result.counts.inserted).toBe(0);
    expect(result.counts.updated).toBe(0);

    const after = ctg.h.sqlite
      .prepare(`SELECT name FROM parties WHERE id = ?`)
      .get(ownParty['id']) as { name: string };
    expect(after.name).toBe(ownParty['name']); // untouched
  });

  it('a tampered file is rejected and logged, writing nothing', () => {
    const original = readFileSync(dhakaPacket1, 'utf8');
    const json = JSON.parse(original) as { data: string };
    const chars = json.data.split('');
    const i = Math.floor(chars.length / 2);
    chars[i] = chars[i] === 'A' ? 'B' : 'A';
    json.data = chars.join('');
    const tamperedPath = join(tmpDir, 'tampered.packet');
    writeFileSync(tamperedPath, JSON.stringify(json));

    const entriesBefore = rowCount(ctg, 'journal_entries');
    expect(() => ctg.sync.importPacketFile({ filePath: tamperedPath }, null)).toThrow(AppError);
    expect(rowCount(ctg, 'journal_entries')).toBe(entriesBefore);
    const last = ctg.h.sqlite
      .prepare(`SELECT status FROM sync_log WHERE direction='import' ORDER BY at DESC LIMIT 1`)
      .get() as { status: string };
    expect(last.status).toBe('rejected');
  });

  it('an install with a different passphrase cannot read the packet', async () => {
    const bogra = await makeNode('bogra.sqlite', 'BOGRA', false, 'a-different-secret');
    try {
      expect(() => bogra.sync.importPacketFile({ filePath: dhakaPacket1 }, null)).toThrow(
        /decrypt/i,
      );
    } finally {
      bogra.h.sqlite.close();
    }
  });
});

describe('hub flow: combined packet + provisional product merge (REQUIRED phase test)', () => {
  it('hub imports CTG packet and sees the provisional product', () => {
    const ctgExport = ctg.sync.exportPacket({}, null);
    const result = dhk.sync.importPacketFile({ filePath: ctgExport.filePath }, null);
    expect(result.counts.inserted).toBeGreaterThan(0);

    const prov = dhk.h.sqlite
      .prepare(`SELECT * FROM products WHERE id = ?`)
      .get(ctgProvisionalId) as { is_provisional: number; branch_code: string };
    expect(prov.is_provisional).toBe(1);
    expect(prov.branch_code).toBe('CTG');

    // combined P&L agrees at the hub too
    expect(pnl(dhk)).toBe(84_000);
    expect(pnl(dhk, 'CTG')).toBe(14_000);
  });

  it('hub merges the provisional into a new SHARED master', () => {
    const { masterId } = dhk.sync.mergeProvisionalProduct(
      { provisionalId: ctgProvisionalId },
      null,
    );
    const master = dhk.h.sqlite
      .prepare(`SELECT * FROM products WHERE id = ?`)
      .get(masterId) as { branch_code: string; is_provisional: number; name: string };
    expect(master.branch_code).toBe('SHARED');
    expect(master.is_provisional).toBe(0);
    expect(master.name).toBe('CTG Special Belt');

    const mapping = dhk.h.sqlite
      .prepare(`SELECT * FROM product_merges WHERE provisional_id = ?`)
      .get(ctgProvisionalId) as { master_id: string };
    expect(mapping.master_id).toBe(masterId);

    expect(() => dhk.sync.mergeProvisionalProduct({ provisionalId: ctgProvisionalId }, null)).toThrow(
      /already merged/,
    );
  });

  it('CTG imports the combined packet: own provisional row gets master_id via OWN edit', () => {
    const combined = dhk.sync.buildCombinedPacket({ outDir: undefined }, null);
    expect(combined.kind).toBe('combined');

    const seqBefore = (
      ctg.h.sqlite.prepare(`SELECT change_seq FROM products WHERE id = ?`).get(ctgProvisionalId) as {
        change_seq: number;
      }
    ).change_seq;

    const result = ctg.sync.importPacketFile({ filePath: combined.filePath }, null);
    expect(result.counts.mergedProducts).toBe(1);
    expect(result.counts.skippedOwn).toBeGreaterThan(0); // own rows in the combined snapshot skipped

    const prov = ctg.h.sqlite
      .prepare(`SELECT master_id, is_active, change_seq, branch_code FROM products WHERE id = ?`)
      .get(ctgProvisionalId) as {
      master_id: string;
      is_active: number;
      change_seq: number;
      branch_code: string;
    };
    expect(prov.master_id).toBeTruthy();
    expect(prov.is_active).toBe(0);
    expect(prov.branch_code).toBe('CTG'); // still owned by CTG
    expect(prov.change_seq).toBeGreaterThan(seqBefore); // CTG's own seq bump → propagates onward

    const master = ctg.h.sqlite
      .prepare(`SELECT branch_code FROM products WHERE id = ?`)
      .get(prov.master_id) as { branch_code: string };
    expect(master.branch_code).toBe('SHARED');
  });

  it('re-importing the combined packet changes nothing further', () => {
    const combined = dhk.sync.buildCombinedPacket({ outDir: undefined }, null);
    const before = ownRowsSnapshot(ctg, 'CTG');
    const productCount = rowCount(ctg, 'products');
    const result = ctg.sync.importPacketFile({ filePath: combined.filePath }, null);
    expect(result.counts.inserted).toBe(0);
    expect(result.counts.mergedProducts).toBe(0);
    expect(ownRowsSnapshot(ctg, 'CTG')).toBe(before);
    expect(rowCount(ctg, 'products')).toBe(productCount);
  });

  it('both installs agree on the whole-company P&L', () => {
    expect(pnl(dhk)).toBe(84_000);
    expect(pnl(ctg)).toBe(84_000);
    expect(pnl(dhk, 'DHAKA')).toBe(pnl(ctg, 'DHAKA'));
    expect(pnl(dhk, 'CTG')).toBe(pnl(ctg, 'CTG'));
  });
});
