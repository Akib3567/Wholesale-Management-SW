import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ADMIN } from '@leather-erp/db';
import { buildServer, type BuiltServer } from './server';

let tmpDir: string;
let server: BuiltServer;
let adminToken: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-server-'));
  server = await buildServer({ dbPath: join(tmpDir, 'test.sqlite') });
});

afterAll(async () => {
  await server.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('health & login', () => {
  it('reports healthy and unconfigured before setup', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, branchConfigured: false, restoreApplied: false });
  });

  it('rejects a wrong password', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: DEFAULT_ADMIN.username, password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logs in the seeded admin', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: DEFAULT_ADMIN.username, password: DEFAULT_ADMIN.password },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; user: { role: string } };
    expect(body.user.role).toBe('admin');
    adminToken = body.token;
  });

  it('serves /me with a token and 401 without', async () => {
    const anon = await server.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anon.statusCode).toBe(401);

    const me = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { username: string } }).user.username).toBe('admin');
  });
});

describe('branch bootstrap', () => {
  it('requires auth', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/install/bootstrap',
      payload: { branchCode: 'DHAKA', branchName: 'Dhaka', isHub: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects invalid branch codes', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/install/bootstrap',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { branchCode: 'shared!', branchName: 'X', isHub: false },
    });
    expect(res.statusCode).toBe(400);
  });

  it('sets the branch identity once, then 409s forever', async () => {
    const first = await server.app.inject({
      method: 'POST',
      url: '/api/install/bootstrap',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { branchCode: 'DHAKA', branchName: 'Dhaka Head Office', isHub: true },
    });
    expect(first.statusCode).toBe(201);
    const body = first.json() as { install: { branchCode: string; isHub: boolean } };
    expect(body.install.branchCode).toBe('DHAKA');
    expect(body.install.isHub).toBe(true);

    const second = await server.app.inject({
      method: 'POST',
      url: '/api/install/bootstrap',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { branchCode: 'CTG', branchName: 'Chittagong', isHub: false },
    });
    expect(second.statusCode).toBe(409);

    const health = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect((health.json() as { branchConfigured: boolean }).branchConfigured).toBe(true);
  });
});

describe('user management & roles', () => {
  let operatorToken: string;

  it('admin creates an operator', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username: 'kashem', password: 'secret1', fullName: 'Kashem Mia', role: 'operator' },
    });
    expect(res.statusCode).toBe(201);

    const login = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'kashem', password: 'secret1' },
    });
    expect(login.statusCode).toBe(200);
    operatorToken = (login.json() as { token: string }).token;
  });

  it('operator cannot manage users (403) but can read /api/install', async () => {
    const denied = await server.app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await server.app.inject({
      method: 'GET',
      url: '/api/install',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('refuses to demote or deactivate the last active admin', async () => {
    const usersRes = await server.app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const adminUser = (usersRes.json() as { users: Array<{ id: string; role: string }> }).users.find(
      (u) => u.role === 'admin',
    );
    expect(adminUser).toBeDefined();

    const demote = await server.app.inject({
      method: 'PATCH',
      url: `/api/users/${adminUser!.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'viewer' },
    });
    expect(demote.statusCode).toBe(409);
  });

  it('change-password works and old password stops working', async () => {
    const bad = await server.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { oldPassword: 'nope', newPassword: 'newsecret1' },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await server.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { oldPassword: 'secret1', newPassword: 'newsecret1' },
    });
    expect(ok.statusCode).toBe(200);

    const oldLogin = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'kashem', password: 'secret1' },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'kashem', password: 'newsecret1' },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('logout invalidates the session token', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(200);

    const me = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(me.statusCode).toBe(401);
  });
});
