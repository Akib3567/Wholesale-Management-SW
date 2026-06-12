import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  runMigrations,
  seedDatabase,
  SYSTEM_ACCOUNTS,
  type OpenDatabaseResult,
} from '@leather-erp/db';
import { ForbiddenError } from '../errors';
import { InstallService } from './install.service';
import { LedgerService } from './ledger.service';
import { PartyService } from './party.service';
import { ProductService } from './product.service';
import { PurchaseService } from './purchase.service';
import { SaleService } from './sale.service';
import { PaymentService } from './payment.service';
import { ExpenseService } from './expense.service';
import type { ServiceDeps } from './deps';

let tmpDir: string;
let h: OpenDatabaseResult;
let deps: ServiceDeps;
let parties: PartyService;
let products: ProductService;
let purchases: PurchaseService;
let sales: SaleService;
let payments: PaymentService;
let expenses: ExpenseService;

/** Σdebit and Σcredit over the entire journal — must always be equal. */
function journalTotals() {
  return h.sqlite
    .prepare('SELECT SUM(debit_paisa) AS debit, SUM(credit_paisa) AS credit FROM journal_lines')
    .get() as { debit: number; credit: number };
}

/** Net posted amount for one account (debit − credit), optionally per party. */
function accountBalance(accountId: string, partyId?: string): number {
  const row = h.sqlite
    .prepare(
      `SELECT COALESCE(SUM(debit_paisa - credit_paisa), 0) AS bal
       FROM journal_lines WHERE account_id = ? ${partyId ? 'AND party_id = ?' : ''}`,
    )
    .get(...(partyId ? [accountId, partyId] : [accountId])) as { bal: number };
  return row.bal;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-trade-'));
  h = openDatabase(join(tmpDir, 'test.sqlite'));
  runMigrations(h.db);
  await seedDatabase(h.db);
  const install = new InstallService(h.sqlite, h.db);
  install.bootstrap({ branchCode: 'DHAKA', branchName: 'Dhaka Head Office', isHub: true }, null);
  const ledger = new LedgerService(h.sqlite, h.db);
  deps = { sqlite: h.sqlite, db: h.db, install, ledger };
  parties = new PartyService(deps);
  products = new ProductService(deps);
  purchases = new PurchaseService(deps, parties, products);
  sales = new SaleService(deps, parties, products);
  payments = new PaymentService(deps, parties);
  expenses = new ExpenseService(deps);
});

afterAll(() => {
  h.sqlite.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

let supplierId: string;
let customerId: string;
let beltId: string;
let walletId: string;

describe('parties & products', () => {
  it('creates parties with auto codes and posts opening balance entries', () => {
    const supplier = parties.create(
      { name: 'Hazaribagh Tannery', kind: 'supplier', openingBalancePaisa: -50_000 }, // we owe 500.00
      null,
    );
    const customer = parties.create(
      { name: 'Chawkbazar Stores', kind: 'customer', openingBalancePaisa: 20_000 }, // owes us 200.00
      null,
    );
    supplierId = supplier.id;
    customerId = customer.id;

    expect(supplier.code).toBe('S-0001');
    expect(customer.code).toBe('C-0001');
    expect(supplier.branchCode).toBe('DHAKA');

    // opening entries: AP credit 50_000 for supplier, AR debit 20_000 for customer
    expect(accountBalance(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, supplier.id)).toBe(-50_000);
    expect(accountBalance(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, customer.id)).toBe(20_000);
    const t = journalTotals();
    expect(t.debit).toBe(t.credit);
  });

  it('hub creates master (SHARED) products', () => {
    const belt = products.create({ name: 'Leather Belt 40mm', unit: 'pcs' }, null);
    const wallet = products.create({ name: 'Bifold Wallet', unit: 'pcs' }, null);
    beltId = belt.id;
    walletId = wallet.id;
    expect(belt.branchCode).toBe('SHARED');
    expect(belt.isProvisional).toBe(false);
  });
});

describe('purchase posting (REQUIRED phase test)', () => {
  it('posts doc + items + stock IN + ONE balanced journal entry', () => {
    const before = journalTotals();
    const { purchase, items } = purchases.create(
      {
        partyId: supplierId,
        docDate: '2026-06-12',
        items: [
          { productId: beltId, qtyMilli: 10_000, unitCostPaisa: 25_000 }, // 10 × 250.00 = 2500.00
          { productId: walletId, qtyMilli: 20_000, unitCostPaisa: 15_000 }, // 20 × 150.00 = 3000.00
        ],
        discountPaisa: 50_000, // 500.00 discount received
        paidPaisa: 100_000, // 1000.00 cash now
      },
      null,
    );

    // money math
    expect(purchase.subtotalPaisa).toBe(550_000);
    expect(purchase.totalPaisa).toBe(500_000);
    expect(purchase.docNo).toBe('PUR-000001');
    expect(purchase.branchCode).toBe('DHAKA');
    expect(items).toHaveLength(2);

    // journal: Dr Inventory 5500, Cr OtherIncome 500, Cr Cash 1000, Cr AP 4000
    const lines = h.sqlite
      .prepare('SELECT account_id, debit_paisa, credit_paisa, party_id FROM journal_lines WHERE entry_id = ?')
      .all(purchase.journalEntryId) as Array<{
      account_id: string;
      debit_paisa: number;
      credit_paisa: number;
      party_id: string | null;
    }>;
    expect(lines.find((l) => l.account_id === SYSTEM_ACCOUNTS.INVENTORY)?.debit_paisa).toBe(550_000);
    expect(lines.find((l) => l.account_id === SYSTEM_ACCOUNTS.OTHER_INCOME)?.credit_paisa).toBe(50_000);
    expect(lines.find((l) => l.account_id === SYSTEM_ACCOUNTS.CASH)?.credit_paisa).toBe(100_000);
    const apLine = lines.find((l) => l.account_id === SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE);
    expect(apLine?.credit_paisa).toBe(400_000);
    expect(apLine?.party_id).toBe(supplierId);

    // stock arrived
    expect(products.qtyOnHandMilli('DHAKA', beltId)).toBe(10_000);
    expect(products.qtyOnHandMilli('DHAKA', walletId)).toBe(20_000);
    expect(products.avgCostPaisa('DHAKA', beltId)).toBe(25_000);

    // whole journal still balances
    const after = journalTotals();
    expect(after.debit).toBe(after.credit);
    expect(after.debit).toBeGreaterThan(before.debit);
  });

  it('weighted-average cost updates with a second purchase at a different price', () => {
    purchases.create(
      {
        partyId: supplierId,
        docDate: '2026-06-12',
        items: [{ productId: beltId, qtyMilli: 10_000, unitCostPaisa: 35_000 }],
      },
      null,
    );
    // (10×250 + 10×350) / 20 = 300.00
    expect(products.avgCostPaisa('DHAKA', beltId)).toBe(30_000);
    expect(products.qtyOnHandMilli('DHAKA', beltId)).toBe(20_000);
  });
});

describe('sale posting (REQUIRED phase test)', () => {
  it('posts revenue + AR + COGS legs and stock OUT, all balanced', () => {
    const { sale } = sales.create(
      {
        partyId: customerId,
        docDate: '2026-06-12',
        items: [{ productId: beltId, qtyMilli: 5_000, unitPricePaisa: 45_000 }], // 5 × 450.00
        paidPaisa: 100_000, // 1000.00 now, rest on credit
      },
      null,
    );

    expect(sale.totalPaisa).toBe(225_000);
    expect(sale.docNo).toBe('SAL-000001');

    const lines = h.sqlite
      .prepare('SELECT account_id, debit_paisa, credit_paisa, party_id FROM journal_lines WHERE entry_id = ?')
      .all(sale.journalEntryId) as Array<{
      account_id: string;
      debit_paisa: number;
      credit_paisa: number;
      party_id: string | null;
    }>;
    expect(lines.find((l) => l.account_id === SYSTEM_ACCOUNTS.CASH)?.debit_paisa).toBe(100_000);
    const ar = lines.find((l) => l.account_id === SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE);
    expect(ar?.debit_paisa).toBe(125_000);
    expect(ar?.party_id).toBe(customerId);
    expect(lines.find((l) => l.account_id === SYSTEM_ACCOUNTS.SALES_REVENUE)?.credit_paisa).toBe(225_000);
    // COGS at weighted-average cost 300.00 × 5 = 1500.00
    expect(lines.find((l) => l.account_id === SYSTEM_ACCOUNTS.COGS)?.debit_paisa).toBe(150_000);
    expect(lines.find((l) => l.account_id === SYSTEM_ACCOUNTS.INVENTORY)?.credit_paisa).toBe(150_000);

    // stock reduced 20 - 5 = 15
    expect(products.qtyOnHandMilli('DHAKA', beltId)).toBe(15_000);

    const t = journalTotals();
    expect(t.debit).toBe(t.credit);
  });

  it('rejects overselling and writes nothing', () => {
    const before = journalTotals();
    expect(() =>
      sales.create(
        {
          partyId: customerId,
          docDate: '2026-06-12',
          items: [{ productId: beltId, qtyMilli: 999_000, unitPricePaisa: 45_000 }],
        },
        null,
      ),
    ).toThrow(/Insufficient stock/);
    expect(journalTotals()).toEqual(before);
  });

  it('walk-in sale without a customer must be fully paid', () => {
    expect(() =>
      sales.create(
        {
          docDate: '2026-06-12',
          items: [{ productId: walletId, qtyMilli: 1_000, unitPricePaisa: 30_000 }],
          paidPaisa: 10_000,
        },
        null,
      ),
    ).toThrow(/fully paid/);

    const { sale } = sales.create(
      {
        docDate: '2026-06-12',
        items: [{ productId: walletId, qtyMilli: 1_000, unitPricePaisa: 30_000 }],
        paidPaisa: 30_000,
      },
      null,
    );
    expect(sale.partyId).toBeNull();
  });
});

describe('payments & expenses', () => {
  it('payment to supplier debits AP; receipt from customer credits AR', () => {
    payments.create(
      { partyId: supplierId, direction: 'out', amountPaisa: 200_000, method: 'cash', paidDate: '2026-06-12' },
      null,
    );
    // AP: -50000 (opening) -400000 (purchase 1) -350000 (purchase 2) +200000 (payment) = -600000
    expect(accountBalance(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, supplierId)).toBe(-600_000);

    payments.create(
      { partyId: customerId, direction: 'in', amountPaisa: 50_000, method: 'bank', paidDate: '2026-06-12' },
      null,
    );
    // AR: +20000 (opening) +125000 (sale) -50000 (receipt) = 95000
    expect(accountBalance(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, customerId)).toBe(95_000);

    const t = journalTotals();
    expect(t.debit).toBe(t.credit);
  });

  it('expense posts Dr expense / Cr cash and rejects non-expense accounts', () => {
    expenses.create(
      { expenseAccountId: 'ACC-5120', amountPaisa: 1_500, spentDate: '2026-06-12', note: 'Truck fare' },
      null,
    );
    expect(accountBalance('ACC-5120')).toBe(1_500);

    expect(() =>
      expenses.create(
        { expenseAccountId: SYSTEM_ACCOUNTS.CASH, amountPaisa: 1_000, spentDate: '2026-06-12' },
        null,
      ),
    ).toThrow(/not a postable expense account/);
    // the group header 'Expenses' is not postable either
    expect(() =>
      expenses.create(
        { expenseAccountId: 'ACC-5000', amountPaisa: 1_000, spentDate: '2026-06-12' },
        null,
      ),
    ).toThrow(/not a postable expense account/);
  });
});

describe('purchase reversal (goods return)', () => {
  it('reverses the journal, restocks out, flags the doc, refuses twice', () => {
    const { purchase } = purchases.create(
      {
        partyId: supplierId,
        docDate: '2026-06-12',
        items: [{ productId: walletId, qtyMilli: 2_000, unitCostPaisa: 15_000 }],
      },
      null,
    );
    const stockBefore = products.qtyOnHandMilli('DHAKA', walletId);

    const reversed = purchases.reverse(purchase.id, { reason: 'damaged goods' }, null);
    expect(reversed.purchase.status).toBe('reversed');
    expect(products.qtyOnHandMilli('DHAKA', walletId)).toBe(stockBefore - 2_000);

    const entry = h.sqlite
      .prepare('SELECT is_reversed FROM journal_entries WHERE id = ?')
      .get(purchase.journalEntryId) as { is_reversed: number };
    expect(entry.is_reversed).toBe(1);

    expect(() => purchases.reverse(purchase.id, {}, null)).toThrow(/already reversed/);
    const t = journalTotals();
    expect(t.debit).toBe(t.credit);
  });
});

describe('foreign-branch edit guard (REQUIRED phase test)', () => {
  it('blocks edits, deletes and reversals of foreign-branch rows', () => {
    // Simulate rows imported from CTG
    h.sqlite
      .prepare(
        `INSERT INTO parties (id, branch_code, change_seq, code, name, kind)
         VALUES ('CTGPARTY00000000000000001', 'CTG', 1, 'S-0001', 'Agrabad Leather', 'supplier')`,
      )
      .run();
    h.sqlite
      .prepare(
        `INSERT INTO purchases (id, branch_code, change_seq, party_id, doc_no, doc_date)
         VALUES ('CTGPURCHASE00000000000001', 'CTG', 2, 'CTGPARTY00000000000000001', 'PUR-000001', '2026-06-10')`,
      )
      .run();

    expect(() =>
      parties.update('CTGPARTY00000000000000001', { name: 'Renamed' }, null),
    ).toThrow(ForbiddenError);
    expect(() => parties.softDelete('CTGPARTY00000000000000001', null)).toThrow(ForbiddenError);
    expect(() => purchases.reverse('CTGPURCHASE00000000000001', {}, null)).toThrow(
      ForbiddenError,
    );
    // …but transacting AGAINST a foreign party (read-only reference) is allowed
    const payment = payments.create(
      {
        partyId: 'CTGPARTY00000000000000001',
        direction: 'out',
        amountPaisa: 1_000,
        method: 'cash',
        paidDate: '2026-06-12',
      },
      null,
    );
    expect(payment.branchCode).toBe('DHAKA');
  });
});

describe('non-hub install behaviour (provisional products, SHARED guard)', () => {
  let h2: OpenDatabaseResult;
  let deps2: ServiceDeps;
  let products2: ProductService;
  let parties2: PartyService;

  beforeAll(async () => {
    h2 = openDatabase(join(tmpDir, 'ctg.sqlite'));
    runMigrations(h2.db);
    await seedDatabase(h2.db);
    const install2 = new InstallService(h2.sqlite, h2.db);
    install2.bootstrap({ branchCode: 'CTG', branchName: 'Chittagong', isHub: false }, null);
    deps2 = { sqlite: h2.sqlite, db: h2.db, install: install2, ledger: new LedgerService(h2.sqlite, h2.db) };
    products2 = new ProductService(deps2);
    parties2 = new PartyService(deps2);
  });

  afterAll(() => {
    h2.sqlite.close();
  });

  it('non-hub creates PROVISIONAL products owned by its branch', () => {
    const p = products2.create({ name: 'New Belt (CTG)', unit: 'pcs' }, null);
    expect(p.branchCode).toBe('CTG');
    expect(p.isProvisional).toBe(true);
    expect(p.provisionalOriginBranch).toBe('CTG');
  });

  it('non-hub cannot create SHARED parties nor edit SHARED products', () => {
    expect(() => parties2.create({ name: 'Shared Co', kind: 'both', shared: true }, null)).toThrow(
      ForbiddenError,
    );
    // simulate an imported SHARED master product
    h2.sqlite
      .prepare(
        `INSERT INTO products (id, branch_code, change_seq, name, unit)
         VALUES ('SHAREDPRODUCT000000000001', 'SHARED', 1, 'Master Belt', 'pcs')`,
      )
      .run();
    expect(() =>
      products2.update('SHAREDPRODUCT000000000001', { name: 'Hijacked' }, null),
    ).toThrow(ForbiddenError);
  });
});
