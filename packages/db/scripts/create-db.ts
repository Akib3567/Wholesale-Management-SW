/**
 * Create a fresh database file, migrated + seeded.
 *
 *   npm run db:create -w @leather-erp/db -- [--path ./shop.sqlite] [--force]
 *                                            [--branch DHAKA [--hub] [--name "Dhaka Head Office"]]
 *
 * --branch/--hub also write the branches + this_install rows (dev
 * convenience — in the real app first-launch setup does this, Phase 3).
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase } from '../src/client';
import { runMigrations } from '../src/migrate';
import { seedDatabase, DEFAULT_ADMIN } from '../src/seed';
import { branches, thisInstall } from '../src/schema/index';

function getFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function getOption(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

const path = resolve(getOption('path') ?? './shop.sqlite');
const force = getFlag('force');
const branchCode = getOption('branch')?.toUpperCase();
const isHub = getFlag('hub');
const branchName = getOption('name') ?? branchCode ?? '';

if (branchCode === 'SHARED') {
  console.error('Branch code SHARED is reserved.');
  process.exit(1);
}

if (existsSync(path)) {
  if (!force) {
    console.error(`Refusing to overwrite existing ${path} (use --force).`);
    process.exit(1);
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}
mkdirSync(dirname(path), { recursive: true });

const { sqlite, db } = openDatabase(path);
try {
  runMigrations(db);
  const seeded = await seedDatabase(db);

  if (branchCode) {
    db.insert(branches).values({ code: branchCode, name: branchName, isHub }).run();
    db.insert(thisInstall).values({ id: 1, branchCode, isHub }).run();
  }

  console.log(`Created ${path}`);
  console.log(
    `  accounts seeded: ${seeded.accountsInserted}, admin created: ${seeded.adminCreated}`,
  );
  if (seeded.adminCreated) {
    console.log(
      `  login: ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}  (change immediately)`,
    );
  }
  console.log(
    branchCode
      ? `  branch identity: ${branchCode}${isHub ? ' (HUB)' : ''}`
      : '  branch identity: not set (first-launch setup will set it)',
  );
} finally {
  sqlite.close();
}
