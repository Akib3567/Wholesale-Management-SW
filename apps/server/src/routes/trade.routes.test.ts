import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ADMIN } from '@leather-erp/db';
import { buildServer, type BuiltServer } from '../server';

let tmpDir: string;
let server: BuiltServer;
let adminToken: string;
let viewerToken: string;

async function login(username: string, password: string): Promise<string> {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  return (res.json() as { token: string }).token;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-routes-'));
  server = await buildServer({ dbPath: join(tmpDir, 'test.sqlite') });
  adminToken = await login(DEFAULT_ADMIN.username, DEFAULT_ADMIN.password);
  await server.app.inject({
    method: 'POST',
    url: '/api/install/bootstrap',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { branchCode: 'DHAKA', branchName: 'Dhaka', isHub: true },
  });
  await server.app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { username: 'watcher', password: 'watch123', fullName: 'Watcher', role: 'viewer' },
  });
  viewerToken = await login('watcher', 'watch123');
});

afterAll(async () => {
  await server.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('trade API end to end', () => {
  it('drives a purchase through the REST API', async () => {
    const supplierRes = await server.app.inject({
      method: 'POST',
      url: '/api/parties',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'API Supplier', kind: 'supplier' },
    });
    expect(supplierRes.statusCode).toBe(201);
    const supplierId = (supplierRes.json() as { party: { id: string } }).party.id;

    const productRes = await server.app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'API Belt', unit: 'pcs' },
    });
    expect(productRes.statusCode).toBe(201);
    const productId = (productRes.json() as { product: { id: string } }).product.id;

    const purchaseRes = await server.app.inject({
      method: 'POST',
      url: '/api/purchases',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        partyId: supplierId,
        docDate: '2026-06-12',
        items: [{ productId, qtyMilli: 5000, unitCostPaisa: 10_000 }],
      },
    });
    expect(purchaseRes.statusCode).toBe(201);
    const body = purchaseRes.json() as { purchase: { totalPaisa: number; docNo: string } };
    expect(body.purchase.totalPaisa).toBe(50_000);
    expect(body.purchase.docNo).toBe('PUR-000001');

    const list = await server.app.inject({
      method: 'GET',
      url: '/api/purchases',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { purchases: unknown[] }).purchases).toHaveLength(1);
  });

  it('lists party balances with ?withBalances (positive = owes us, negative = we owe)', async () => {
    // a customer who owes us 300.00 (opening receivable)
    const custRes = await server.app.inject({
      method: 'POST',
      url: '/api/parties',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Balance Customer', kind: 'customer', openingBalancePaisa: 30_000 },
    });
    const custId = (custRes.json() as { party: { id: string } }).party.id;

    const res = await server.app.inject({
      method: 'GET',
      url: '/api/parties?withBalances=1',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const parties = (res.json() as { parties: Array<{ id: string; name: string; balancePaisa: number }> })
      .parties;

    const cust = parties.find((p) => p.id === custId)!;
    expect(cust.balancePaisa).toBe(30_000); // Pabo

    // the supplier from the earlier credit purchase owes-side: we owe 500.00
    const supplier = parties.find((p) => p.name === 'API Supplier')!;
    expect(supplier.balancePaisa).toBe(-50_000); // Debo
  });

  it('viewer can read but cannot write (403)', async () => {
    const denied = await server.app.inject({
      method: 'POST',
      url: '/api/parties',
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { name: 'Nope', kind: 'customer' },
    });
    expect(denied.statusCode).toBe(403);

    const reading = await server.app.inject({
      method: 'GET',
      url: '/api/parties',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(reading.statusCode).toBe(200);
  });

  it('validation errors come back as 400 with issues', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/sales',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { docDate: 'not-a-date', items: [] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; issues: unknown[] } };
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.issues.length).toBeGreaterThan(0);
  });
});
