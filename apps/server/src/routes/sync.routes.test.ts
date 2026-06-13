import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ADMIN } from '@leather-erp/db';
import { buildServer, type BuiltServer } from '../server';

const PASS = 'company-sync-secret';
let tmpDir: string;
let dhaka: BuiltServer;
let ctg: BuiltServer;
let dhakaToken: string;
let ctgToken: string;

async function login(server: BuiltServer, username = DEFAULT_ADMIN.username, password = DEFAULT_ADMIN.password) {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  return (res.json() as { token: string }).token;
}
function authed(server: BuiltServer, token: string) {
  return async <T>(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: T }> => {
    const res = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: res.statusCode, body: res.json() as T };
  };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-syncroutes-'));
  dhaka = await buildServer({ dbPath: join(tmpDir, 'dhaka.sqlite') });
  ctg = await buildServer({ dbPath: join(tmpDir, 'ctg.sqlite') });
  dhakaToken = await login(dhaka);
  ctgToken = await login(ctg);

  const d = authed(dhaka, dhakaToken);
  const c = authed(ctg, ctgToken);
  await d('POST', '/api/install/bootstrap', { branchCode: 'DHAKA', branchName: 'Dhaka', isHub: true });
  await c('POST', '/api/install/bootstrap', { branchCode: 'CTG', branchName: 'Chittagong', isHub: false });
  await d('POST', '/api/sync/passphrase', { passphrase: PASS });
  await c('POST', '/api/sync/passphrase', { passphrase: PASS });
  // CTG creates a party so its packet has content
  await c('POST', '/api/parties', { name: 'Agrabad Supplier', kind: 'supplier' });
});

afterAll(async () => {
  await dhaka.app.close();
  await ctg.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('sync HTTP: upload import + download', () => {
  it('imports a CTG packet uploaded as base64 into DHAKA', async () => {
    const c = authed(ctg, ctgToken);
    const exp = await c<{ filePath: string }>('POST', '/api/sync/export', {});
    expect(exp.status).toBe(200);
    const fileBase64 = readFileSync(exp.body.filePath).toString('base64');

    const d = authed(dhaka, dhakaToken);
    const imp = await d<{ senderBranch: string; counts: { inserted: number } }>(
      'POST',
      '/api/sync/import-upload',
      { fileName: 'ctg.packet', fileBase64 },
    );
    expect(imp.status).toBe(200);
    expect(imp.body.senderBranch).toBe('CTG');
    expect(imp.body.counts.inserted).toBeGreaterThan(0);
  });

  it('downloads a previously-exported packet and rejects path traversal', async () => {
    const d = authed(dhaka, dhakaToken);
    const exp = await d<{ filePath: string }>('POST', '/api/sync/export', {});
    const name = exp.body.filePath.replace(/^.*[\\/]/, '');

    const ok = await dhaka.app.inject({
      method: 'GET',
      url: `/api/sync/download?name=${encodeURIComponent(name)}`,
      headers: { authorization: `Bearer ${dhakaToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('application/octet-stream');
    expect(ok.rawPayload.length).toBeGreaterThan(0);

    for (const bad of ['../../etc/passwd', 'secrets.txt', '..\\db.sqlite']) {
      const res = await dhaka.app.inject({
        method: 'GET',
        url: `/api/sync/download?name=${encodeURIComponent(bad)}`,
        headers: { authorization: `Bearer ${dhakaToken}` },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  it('upload import requires manager role (viewer is 403)', async () => {
    await authed(dhaka, dhakaToken)('POST', '/api/users', {
      username: 'peeker',
      password: 'view123',
      fullName: 'Peeker',
      role: 'viewer',
    });
    const viewerToken = await login(dhaka, 'peeker', 'view123');
    const res = await dhaka.app.inject({
      method: 'POST',
      url: '/api/sync/import-upload',
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { fileBase64: 'AAAA' },
    });
    expect(res.statusCode).toBe(403);
  });
});
