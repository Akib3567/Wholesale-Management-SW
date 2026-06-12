import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import { openDatabase, type OpenDatabaseResult } from './client';
import { runMigrations } from './migrate';
import { seedDatabase, CHART_OF_ACCOUNTS, DEFAULT_ADMIN, SYSTEM_ACCOUNTS } from './seed';

let tmpDir: string;
let handle: OpenDatabaseResult;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-db-'));
  handle = openDatabase(join(tmpDir, 'test.sqlite'));
  runMigrations(handle.db);
  await seedDatabase(handle.db);
});

afterAll(() => {
  handle.sqlite.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const EXPECTED_TABLES = [
  'branches',
  'this_install',
  'users',
  'settings',
  'audit_log',
  'accounts',
  'journal_entries',
  'journal_lines',
  'parties',
  'products',
  'product_merges',
  'stock_moves',
  'purchases',
  'purchase_items',
  'sales',
  'sale_items',
  'payments',
  'expenses',
  'daily_closing',
  'sync_state',
  'sync_log',
  'backups',
];

describe('migrations', () => {
  it('create every table in the data model', () => {
    const rows = handle.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    for (const table of EXPECTED_TABLES) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it('run with WAL mode and foreign keys ON', () => {
    expect(handle.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('seed', () => {
  it('creates the full chart of accounts with deterministic ids', () => {
    const { c } = handle.sqlite.prepare('SELECT COUNT(*) AS c FROM accounts').get() as {
      c: number;
    };
    expect(c).toBe(CHART_OF_ACCOUNTS.length);

    const cash = handle.sqlite
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(SYSTEM_ACCOUNTS.CASH) as { code: string; is_cash: number; type: string };
    expect(cash.code).toBe('1010');
    expect(cash.is_cash).toBe(1);
    expect(cash.type).toBe('asset');
  });

  it('creates the admin user with a verifiable argon2 hash', async () => {
    const admin = handle.sqlite
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(DEFAULT_ADMIN.username) as { password_hash: string; role: string };
    expect(admin.role).toBe('admin');
    expect(admin.password_hash.startsWith('$argon2')).toBe(true);
    expect(await argon2.verify(admin.password_hash, DEFAULT_ADMIN.password)).toBe(true);
  });

  it('is idempotent — running twice adds nothing', async () => {
    const result = await seedDatabase(handle.db);
    expect(result.accountsInserted).toBe(0);
    expect(result.adminCreated).toBe(false);
    expect(result.settingsInserted).toBe(0);
  });
});

describe('database constraints', () => {
  it('this_install only accepts the single row id=1', () => {
    expect(() =>
      handle.sqlite
        .prepare(`INSERT INTO this_install (id, branch_code) VALUES (2, 'CTG')`)
        .run(),
    ).toThrow(/CHECK/);
  });

  it('journal_lines rejects a line that is both debit and credit, or neither', () => {
    handle.sqlite
      .prepare(
        `INSERT INTO journal_entries (id, branch_code, change_seq, entry_date, ref_type)
         VALUES ('TESTENTRY0000000000000001', 'DHAKA', 1, '2026-06-12', 'adjustment')`,
      )
      .run();

    const insertLine = handle.sqlite.prepare(
      `INSERT INTO journal_lines (id, entry_id, line_no, account_id, debit_paisa, credit_paisa)
       VALUES (?, 'TESTENTRY0000000000000001', 1, ?, ?, ?)`,
    );
    // both sides positive
    expect(() => insertLine.run('L1', SYSTEM_ACCOUNTS.CASH, 100, 100)).toThrow(/CHECK/);
    // zero line
    expect(() => insertLine.run('L2', SYSTEM_ACCOUNTS.CASH, 0, 0)).toThrow(/CHECK/);
    // negative
    expect(() => insertLine.run('L3', SYSTEM_ACCOUNTS.CASH, -100, 0)).toThrow(/CHECK/);
    // valid balanced pair inserts fine
    insertLine.run('L4', SYSTEM_ACCOUNTS.CASH, 100, 0);
    insertLine.run('L5', SYSTEM_ACCOUNTS.SALES_REVENUE, 0, 100);
  });

  it('enforces foreign keys (line pointing at a missing entry fails)', () => {
    expect(() =>
      handle.sqlite
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_no, account_id, debit_paisa, credit_paisa)
           VALUES ('LX', 'NOSUCHENTRY', 1, '${SYSTEM_ACCOUNTS.CASH}', 100, 0)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('doc_no is unique per branch (purchases)', () => {
    const insert = handle.sqlite.prepare(
      `INSERT INTO purchases (id, branch_code, change_seq, party_id, doc_no, doc_date)
       VALUES (?, ?, 1, 'PARTY1', ?, '2026-06-12')`,
    );
    insert.run('P1', 'DHAKA', 'PUR-0001');
    insert.run('P2', 'CTG', 'PUR-0001'); // same doc_no, other branch: fine
    expect(() => insert.run('P3', 'DHAKA', 'PUR-0001')).toThrow(/UNIQUE/);
  });
});
