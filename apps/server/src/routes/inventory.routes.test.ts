import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ADMIN } from '@leather-erp/db';
import { buildServer, type BuiltServer } from '../server';

let tmpDir: string;
let server: BuiltServer;
let token: string;
let productId: string;

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
function trialBalanced(): boolean {
  const r = server.ctx.sqlite
    .prepare('SELECT SUM(debit_paisa) d, SUM(credit_paisa) c FROM journal_lines')
    .get() as { d: number; c: number };
  return r.d === r.c;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-inv-'));
  server = await buildServer({ dbPath: join(tmpDir, 'test.sqlite') });
  const login = await server.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: DEFAULT_ADMIN.username, password: DEFAULT_ADMIN.password },
  });
  token = (login.json() as { token: string }).token;
  await post('/api/install/bootstrap', { branchCode: 'DHAKA', branchName: 'Dhaka', isHub: true });

  const { party } = await post<{ party: { id: string } }>('/api/parties', {
    name: 'Inv Supplier',
    kind: 'supplier',
  });
  const { product } = await post<{ product: { id: string } }>('/api/products', {
    name: 'Inv Belt',
    unit: 'pcs',
    reorderLevelMilli: 5000,
  });
  productId = product.id;
  // buy 10 @ 100.00
  await post('/api/purchases', {
    partyId: party.id,
    docDate: D,
    items: [{ productId, qtyMilli: 10_000, unitCostPaisa: 10_000 }],
  });
});

afterAll(async () => {
  await server.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('inventory list & valuation', () => {
  it('reports on-hand, avg cost and value', async () => {
    const inv = await get<{
      totalValuePaisa: number;
      lowStockCount: number;
      rows: Array<{ productId: string; qtyOnHandMilli: number; avgCostPaisa: number; valuePaisa: number; isLow: boolean }>;
    }>('/api/inventory');
    const row = inv.rows.find((r) => r.productId === productId)!;
    expect(row.qtyOnHandMilli).toBe(10_000);
    expect(row.avgCostPaisa).toBe(10_000);
    expect(row.valuePaisa).toBe(100_000); // 10 × 100.00
    expect(row.isLow).toBe(false);
    expect(inv.totalValuePaisa).toBeGreaterThanOrEqual(100_000);
  });

  it('scope=THIS resolves to this branch (the path the UI uses)', async () => {
    // Regression: 'THIS' must map to the install branch, not be used as a literal filter.
    const inv = await get<{
      branch: string;
      rows: Array<{ productId: string; qtyOnHandMilli: number }>;
    }>('/api/inventory?scope=THIS');
    expect(inv.branch).toBe('DHAKA');
    expect(inv.rows.find((r) => r.productId === productId)?.qtyOnHandMilli).toBe(10_000);
  });

  it('scope=ALL sums across branches', async () => {
    const inv = await get<{ branch: string; rows: Array<{ productId: string; qtyOnHandMilli: number }> }>(
      '/api/inventory?scope=ALL',
    );
    expect(inv.branch).toBe('ALL');
    expect(inv.rows.find((r) => r.productId === productId)?.qtyOnHandMilli).toBe(10_000);
  });
});

describe('manual stock adjustment', () => {
  it('decrease (shrinkage) posts Dr Adjustment / Cr Inventory, stays balanced', async () => {
    // counted 8 -> delta −2 at avg cost 100.00 = 200.00 write-down
    const res = await post<{ deltaMilli: number }>('/api/inventory/adjust', {
      productId,
      countedQtyMilli: 8_000,
      note: 'damaged',
    });
    expect(res.deltaMilli).toBe(-2_000);
    expect(trialBalanced()).toBe(true);

    const invValue = server.ctx.sqlite
      .prepare(
        `SELECT COALESCE(SUM(debit_paisa - credit_paisa),0) v FROM journal_lines WHERE account_id = 'ACC-1200'`,
      )
      .get() as { v: number };
    expect(invValue.v).toBe(80_000); // 100000 − 20000

    const adj = server.ctx.sqlite
      .prepare(
        `SELECT COALESCE(SUM(debit_paisa - credit_paisa),0) v FROM journal_lines WHERE account_id = 'ACC-5020'`,
      )
      .get() as { v: number };
    expect(adj.v).toBe(20_000); // expense (loss)

    const inv = await get<{ rows: Array<{ productId: string; qtyOnHandMilli: number; isLow: boolean }> }>(
      '/api/inventory',
    );
    const row = inv.rows.find((r) => r.productId === productId)!;
    expect(row.qtyOnHandMilli).toBe(8_000);
  });

  it('increase posts Dr Inventory / Cr Adjustment', async () => {
    await post('/api/inventory/adjust', { productId, countedQtyMilli: 9_000 }); // +1 at avg cost
    expect(trialBalanced()).toBe(true);
    const inv = await get<{ rows: Array<{ productId: string; qtyOnHandMilli: number }> }>('/api/inventory');
    expect(inv.rows.find((r) => r.productId === productId)!.qtyOnHandMilli).toBe(9_000);
  });

  it('rejects a no-op adjustment', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/inventory/adjust',
      headers: { authorization: `Bearer ${token}` },
      payload: { productId, countedQtyMilli: 9_000 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('daily day-view with cash balance-forward', () => {
  it('opening + day cash movement = closing', async () => {
    // a cash sale today so cash moves
    await post('/api/sales', {
      docDate: D,
      items: [{ productId, qtyMilli: 1_000, unitPricePaisa: 20_000 }],
      paidPaisa: 20_000,
    });
    const day = await get<{
      openingCashPaisa: number;
      closingCashPaisa: number;
      receivablesPaisa: number;
      payablesPaisa: number;
      sales: unknown[];
      totals: { salesPaisa: number; purchasesPaisa: number };
    }>(`/api/reports/daily?date=${D}`);

    expect(day.totals.salesPaisa).toBe(20_000);
    expect(day.totals.purchasesPaisa).toBe(100_000);
    // all activity is on D, so opening (before D) is 0 and closing = today's net cash
    expect(day.openingCashPaisa).toBe(0);
    expect(day.closingCashPaisa).toBe(20_000); // +20000 sale (purchase was on credit)
    expect(day.sales.length).toBe(1);

    // Outstanding dues as of D: the credit purchase left AP = 100000; sales were cash so AR = 0.
    expect(day.payablesPaisa).toBe(100_000);
    expect(day.receivablesPaisa).toBe(0);
  });

  it('a credit sale increases receivables as of the day', async () => {
    const { party } = await post<{ party: { id: string } }>('/api/parties', {
      name: 'Daily Credit Customer',
      kind: 'customer',
    });
    // sell 1 @ 300.00, pay only 100.00 -> 200.00 receivable
    await post('/api/sales', {
      partyId: party.id,
      docDate: D,
      items: [{ productId, qtyMilli: 1_000, unitPricePaisa: 30_000 }],
      paidPaisa: 10_000,
    });
    const day = await get<{ receivablesPaisa: number }>(`/api/reports/daily?date=${D}`);
    expect(day.receivablesPaisa).toBe(20_000);
  });
});
