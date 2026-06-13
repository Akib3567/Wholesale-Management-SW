import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ADMIN } from '@leather-erp/db';
import { buildServer, type BuiltServer } from '../server';

let tmpDir: string;
let server: BuiltServer;
let token: string;
let supplierId: string;

const D = '2026-06-13';

async function post<T>(url: string, payload: unknown): Promise<T> {
  const res = await server.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });
  if (res.statusCode >= 400) throw new Error(`${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

async function get<T>(url: string): Promise<T> {
  const res = await server.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.statusCode >= 400) throw new Error(`${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-acct-'));
  server = await buildServer({ dbPath: join(tmpDir, 'test.sqlite') });
  const login = await server.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: DEFAULT_ADMIN.username, password: DEFAULT_ADMIN.password },
  });
  token = (login.json() as { token: string }).token;
  await post('/api/install/bootstrap', { branchCode: 'DHAKA', branchName: 'Dhaka', isHub: true });

  const { party } = await post<{ party: { id: string } }>('/api/parties', {
    name: 'Acct Supplier',
    kind: 'supplier',
  });
  supplierId = party.id;
  const { product } = await post<{ product: { id: string } }>('/api/products', {
    name: 'Acct Belt',
    unit: 'pcs',
  });
  // purchase 10 @ 100.00 on credit -> Inventory 100000 Dr / AP 100000 Cr
  await post('/api/purchases', {
    partyId: supplierId,
    docDate: D,
    items: [{ productId: product.id, qtyMilli: 10_000, unitCostPaisa: 10_000 }],
  });
  // walk-in sale 2 @ 150.00 cash -> Cash 30000 / Sales 30000; COGS 20000 / Inventory 20000
  await post('/api/sales', {
    docDate: D,
    items: [{ productId: product.id, qtyMilli: 2_000, unitPricePaisa: 15_000 }],
    paidPaisa: 30_000,
  });
  // expense 5.00 cash
  await post('/api/expenses', { expenseAccountId: 'ACC-5120', amountPaisa: 500, spentDate: D });
  // pay supplier 100.00 cash -> AP 10000 Dr / Cash 10000 Cr
  await post('/api/payments', {
    partyId: supplierId,
    direction: 'out',
    amountPaisa: 10_000,
    method: 'cash',
    paidDate: D,
  });
});

afterAll(async () => {
  await server.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('trial balance', () => {
  it('balances and shows expected account balances', async () => {
    const tb = await get<{
      accounts: Array<{ id: string; debitBalancePaisa: number; creditBalancePaisa: number }>;
      totalDebitPaisa: number;
      totalCreditPaisa: number;
      balanced: boolean;
    }>(`/api/accounting/trial-balance?asOf=${D}`);

    expect(tb.balanced).toBe(true);
    expect(tb.totalDebitPaisa).toBe(tb.totalCreditPaisa);

    const byId = new Map(tb.accounts.map((a) => [a.id, a]));
    expect(byId.get('ACC-1010')?.debitBalancePaisa).toBe(19_500); // cash 30000-500-10000
    expect(byId.get('ACC-1200')?.debitBalancePaisa).toBe(80_000); // inventory 100000-20000
    expect(byId.get('ACC-2100')?.creditBalancePaisa).toBe(90_000); // AP 100000-10000
    expect(byId.get('ACC-4010')?.creditBalancePaisa).toBe(30_000); // sales
    expect(byId.get('ACC-5010')?.debitBalancePaisa).toBe(20_000); // COGS
    expect(byId.get('ACC-5120')?.debitBalancePaisa).toBe(500); // transport
  });
});

describe('ledger & cash book', () => {
  it('cash ledger runs opening -> closing correctly', async () => {
    const ledger = await get<{
      openingPaisa: number;
      closingPaisa: number;
      rows: Array<{ debitPaisa: number; creditPaisa: number; balancePaisa: number }>;
    }>(`/api/accounting/ledger?accountId=ACC-1010&from=${D}&to=${D}`);

    expect(ledger.openingPaisa).toBe(0);
    expect(ledger.closingPaisa).toBe(19_500);
    const last = ledger.rows[ledger.rows.length - 1]!;
    expect(last.balancePaisa).toBe(19_500);
  });

  it('cash book combines cash accounts with in/out totals', async () => {
    const book = await get<{
      openingPaisa: number;
      closingPaisa: number;
      totalInPaisa: number;
      totalOutPaisa: number;
    }>(`/api/accounting/cash-book?from=${D}&to=${D}&kind=cash`);
    expect(book.totalInPaisa).toBe(30_000);
    expect(book.totalOutPaisa).toBe(10_500);
    expect(book.closingPaisa).toBe(19_500);
  });

  it('journal returns balanced entries with lines', async () => {
    const journal = await get<{
      entries: Array<{ lines: Array<{ debitPaisa: number; creditPaisa: number }> }>;
    }>(`/api/accounting/journal?from=${D}&to=${D}`);
    expect(journal.entries.length).toBeGreaterThanOrEqual(4);
    for (const e of journal.entries) {
      const dr = e.lines.reduce((s, l) => s + l.debitPaisa, 0);
      const cr = e.lines.reduce((s, l) => s + l.creditPaisa, 0);
      expect(dr).toBe(cr);
    }
  });
});

describe('reports', () => {
  it('daily sales/purchases return rows + server-computed totals', async () => {
    const sales = await get<{ totals: { count: number; totalPaisa: number; paidPaisa: number } }>(
      `/api/reports/daily-sales?date=${D}`,
    );
    expect(sales.totals).toMatchObject({ count: 1, totalPaisa: 30_000, paidPaisa: 30_000 });

    const purchases = await get<{ totals: { count: number; totalPaisa: number; duePaisa: number } }>(
      `/api/reports/daily-purchases?date=${D}`,
    );
    expect(purchases.totals).toMatchObject({ count: 1, totalPaisa: 100_000, duePaisa: 100_000 });
  });

  it('supplier statement: purchase increases what we owe, payment reduces it', async () => {
    const st = await get<{
      openingPaisa: number;
      closingPaisa: number;
      rows: Array<{ refType: string; balancePaisa: number }>;
    }>(`/api/reports/statement?partyId=${supplierId}&from=${D}&to=${D}`);

    expect(st.openingPaisa).toBe(0);
    // negative = we owe the party
    expect(st.closingPaisa).toBe(-90_000);
    expect(st.rows.map((r) => r.refType)).toEqual(['purchase', 'payment']);
    expect(st.rows[0]!.balancePaisa).toBe(-100_000);
    expect(st.rows[1]!.balancePaisa).toBe(-90_000);
  });

  it('P&L: revenue − COGS = gross; − expenses = net', async () => {
    const pnl = await get<{
      income: Array<{ id: string; amountPaisa: number }>;
      cogsPaisa: number;
      grossProfitPaisa: number;
      expensesPaisa: number;
      netProfitPaisa: number;
      asOf: unknown[];
    }>(`/api/reports/pnl?from=${D}&to=${D}`);

    expect(pnl.income.find((r) => r.id === 'ACC-4010')?.amountPaisa).toBe(30_000);
    expect(pnl.cogsPaisa).toBe(20_000);
    expect(pnl.grossProfitPaisa).toBe(10_000);
    expect(pnl.expensesPaisa).toBe(500);
    expect(pnl.netProfitPaisa).toBe(9_500);
  });

  it('scope=ALL discloses foreign branches as-of (none yet -> empty)', async () => {
    const pnl = await get<{ scope: string; asOf: unknown[] }>(
      `/api/reports/pnl?from=${D}&to=${D}&scope=ALL`,
    );
    expect(pnl.scope).toBe('ALL');
    expect(pnl.asOf).toEqual([]);
  });
});
