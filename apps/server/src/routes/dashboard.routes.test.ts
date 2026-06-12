import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ADMIN } from '@leather-erp/db';
import { buildServer, type BuiltServer } from '../server';

let tmpDir: string;
let server: BuiltServer;
let token: string;

function today(): string {
  return new Date().toLocaleDateString('en-CA');
}

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

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-dash-'));
  server = await buildServer({ dbPath: join(tmpDir, 'test.sqlite') });
  const login = await server.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: DEFAULT_ADMIN.username, password: DEFAULT_ADMIN.password },
  });
  token = (login.json() as { token: string }).token;
  await post('/api/install/bootstrap', { branchCode: 'DHAKA', branchName: 'Dhaka', isHub: true });

  const { party: supplier } = await post<{ party: { id: string } }>('/api/parties', {
    name: 'Dash Supplier',
    kind: 'supplier',
  });
  const { product } = await post<{ product: { id: string } }>('/api/products', {
    name: 'Dash Belt',
    unit: 'pcs',
  });
  // purchase 10 pcs @ 100.00 on credit
  await post('/api/purchases', {
    partyId: supplier.id,
    docDate: today(),
    items: [{ productId: product.id, qtyMilli: 10_000, unitCostPaisa: 10_000 }],
  });
  // walk-in sale 2 pcs @ 150.00 fully paid cash
  await post('/api/sales', {
    docDate: today(),
    items: [{ productId: product.id, qtyMilli: 2_000, unitPricePaisa: 15_000 }],
    paidPaisa: 30_000,
  });
  // expense 5.00 cash
  await post('/api/expenses', {
    expenseAccountId: 'ACC-5120',
    amountPaisa: 500,
    spentDate: today(),
  });
  // make the product low-stock: on hand 8, reorder level 20
  await server.app.inject({
    method: 'PATCH',
    url: `/api/products/${product.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { reorderLevelMilli: 20_000 },
  });
});

afterAll(async () => {
  await server.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/dashboard', () => {
  it('returns server-computed paisa figures for this branch', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json() as {
      scope: string;
      today: { salesPaisa: number; purchasesPaisa: number; expensesPaisa: number };
      cashPaisa: number;
      receivablesPaisa: number;
      payablesPaisa: number;
      lowStockCount: number;
      series: Array<{ date: string; salesPaisa: number; purchasesPaisa: number }>;
      branches: Array<{ code: string; isSelf: boolean }>;
    };

    expect(d.scope).toBe('DHAKA');
    expect(d.today.salesPaisa).toBe(30_000);
    expect(d.today.purchasesPaisa).toBe(100_000);
    expect(d.today.expensesPaisa).toBe(500);
    // cash: +30000 sale −500 expense
    expect(d.cashPaisa).toBe(29_500);
    expect(d.receivablesPaisa).toBe(0);
    expect(d.payablesPaisa).toBe(100_000);
    expect(d.lowStockCount).toBe(1);

    expect(d.series).toHaveLength(30);
    const last = d.series[d.series.length - 1]!;
    expect(last.date).toBe(today());
    expect(last.salesPaisa).toBe(30_000);
    expect(last.purchasesPaisa).toBe(100_000);

    expect(d.branches.some((b) => b.code === 'DHAKA' && b.isSelf)).toBe(true);
  });

  it('scope=ALL covers the whole company (same here: one branch)', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/dashboard?scope=ALL',
      headers: { authorization: `Bearer ${token}` },
    });
    const d = res.json() as { scope: string; today: { salesPaisa: number } };
    expect(d.scope).toBe('ALL');
    expect(d.today.salesPaisa).toBe(30_000);
  });
});
