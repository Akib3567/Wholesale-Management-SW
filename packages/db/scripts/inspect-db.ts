/**
 * Inspect a database file: tables, row counts, integrity, chart of
 * accounts, users, branch identity.
 *
 *   npm run db:inspect -w @leather-erp/db -- [--path ./shop.sqlite]
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../src/client';

function getOption(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

const path = resolve(getOption('path') ?? './shop.sqlite');
if (!existsSync(path)) {
  console.error(`No database at ${path}`);
  process.exit(1);
}

const { sqlite } = openDatabase(path, { readonly: true });
try {
  console.log(`Database: ${path}\n`);

  const integrity = sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
  console.log(`integrity_check: ${integrity[0]?.integrity_check ?? '?'}`);
  const fkViolations = sqlite.pragma('foreign_key_check') as unknown[];
  console.log(`foreign_key_check: ${fkViolations.length === 0 ? 'ok' : `${fkViolations.length} VIOLATIONS`}\n`);

  const tables = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  console.log('Tables:');
  for (const { name } of tables) {
    const { c } = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number };
    console.log(`  ${name.padEnd(18)} ${c} rows`);
  }

  const install = sqlite.prepare('SELECT * FROM this_install').get() as
    | { branch_code: string; is_hub: number; next_change_seq: number }
    | undefined;
  console.log(
    `\nThis install: ${
      install
        ? `${install.branch_code}${install.is_hub ? ' (HUB)' : ''}, next_change_seq=${install.next_change_seq}`
        : 'branch not set yet'
    }`,
  );

  const branchRows = sqlite.prepare('SELECT code, name, is_hub FROM branches').all() as Array<{
    code: string;
    name: string;
    is_hub: number;
  }>;
  console.log(`Known branches: ${branchRows.map((b) => `${b.code}${b.is_hub ? '(hub)' : ''}`).join(', ') || 'none'}`);

  const userRows = sqlite
    .prepare('SELECT username, role, is_active FROM users ORDER BY username')
    .all() as Array<{ username: string; role: string; is_active: number }>;
  console.log(`Users: ${userRows.map((u) => `${u.username}[${u.role}${u.is_active ? '' : ',inactive'}]`).join(', ') || 'none'}`);

  console.log('\nChart of accounts:');
  const accountRows = sqlite
    .prepare('SELECT id, code, name, type, is_cash, is_bank, parent_id FROM accounts ORDER BY code')
    .all() as Array<{
    id: string;
    code: string;
    name: string;
    type: string;
    is_cash: number;
    is_bank: number;
    parent_id: string | null;
  }>;
  for (const a of accountRows) {
    const indent = a.parent_id ? '    ' : '  ';
    const flags = [a.is_cash ? 'cash' : '', a.is_bank ? 'bank' : ''].filter(Boolean).join(',');
    console.log(`${indent}${a.code}  ${a.name.padEnd(26)} ${a.type}${flags ? ` [${flags}]` : ''}`);
  }
} finally {
  sqlite.close();
}
