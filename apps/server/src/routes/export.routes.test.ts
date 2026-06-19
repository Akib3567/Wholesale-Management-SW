import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ADMIN } from '@leather-erp/db';
import { buildServer, type BuiltServer } from '../server';

let tmpDir: string;
let server: BuiltServer;
let token: string;
const D = '2026-06-19';
const OLD = '2026-01-01';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-export-'));
  server = await buildServer({ dbPath: join(tmpDir, 'test.sqlite') });
  token = (
    await server.app
      .inject({ method: 'POST', url: '/api/auth/login', payload: { username: DEFAULT_ADMIN.username, password: DEFAULT_ADMIN.password } })
      .then((r) => r.json() as { token: string })
  ).token;
  await post('/api/install/bootstrap', { branchCode: 'DHAKA', branchName: 'Dhaka', isHub: true });

  const { party: sup } = await post<{ party: { id: string } }>('/api/parties', { name: 'Exp Supplier', kind: 'supplier' });
  const { party: cust } = await post<{ party: { id: string } }>('/api/parties', { name: 'Exp Customer', kind: 'customer' });
  const { product } = await post<{ product: { id: string } }>('/api/products', { name: 'Exp Belt', unit: 'pcs' });

  await post('/api/purchases', { partyId: sup.id, docDate: D, items: [{ productId: product.id, qtyMilli: 10_000, unitCostPaisa: 10_000 }] });
  await post('/api/sales', { partyId: cust.id, docDate: D, items: [{ productId: product.id, qtyMilli: 2_000, unitPricePaisa: 20_000 }], paidPaisa: 10_000 });
  await post('/api/payments', { partyId: cust.id, direction: 'in', amountPaisa: 5_000, method: 'cash', paidDate: D });
  await post('/api/expenses', { expenseAccountId: 'ACC-5120', amountPaisa: 1_500, spentDate: D, note: 'Van fare' });
});

afterAll(async () => {
  await server.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface ExportData {
  sales: Array<{ partyName: string | null; totalPaisa: number }>;
  purchases: Array<{ partyName: string | null; totalPaisa: number }>;
  payments: Array<{ partyName: string | null; direction: string; amountPaisa: number }>;
  expenses: Array<{ accountName: string; amountPaisa: number; note: string | null }>;
}

describe('GET /api/export/data', () => {
  it('returns all record types in the range with names resolved', async () => {
    const d = await get<ExportData>(`/api/export/data?from=${D}&to=${D}`);
    expect(d.sales).toHaveLength(1);
    expect(d.sales[0]!.partyName).toBe('Exp Customer');
    expect(d.sales[0]!.totalPaisa).toBe(40_000);
    expect(d.purchases).toHaveLength(1);
    expect(d.purchases[0]!.partyName).toBe('Exp Supplier');
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0]).toMatchObject({ partyName: 'Exp Customer', direction: 'in', amountPaisa: 5_000 });
    expect(d.expenses).toHaveLength(1);
    expect(d.expenses[0]).toMatchObject({ accountName: 'Transport', amountPaisa: 1_500, note: 'Van fare' });
  });

  it('respects the date range (excludes records outside it)', async () => {
    const d = await get<ExportData>(`/api/export/data?from=${OLD}&to=${OLD}`);
    expect(d.sales).toHaveLength(0);
    expect(d.purchases).toHaveLength(0);
    expect(d.payments).toHaveLength(0);
    expect(d.expenses).toHaveLength(0);
  });

  it('rejects a bad date', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/export/data?from=nope&to=2026-06-19',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
