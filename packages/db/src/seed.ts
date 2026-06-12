import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { newUlid } from '@leather-erp/core';
import type { Db } from './client';
import { accounts, settings, users, type AccountType } from './schema/index';

/**
 * Well-known account ids the domain services post against. Deterministic
 * ('ACC-<code>') and identical on every install, so journal lines written
 * on one branch resolve to the same accounts everywhere after sync.
 */
export const SYSTEM_ACCOUNTS = {
  CASH: 'ACC-1010',
  BANK: 'ACC-1020',
  ACCOUNTS_RECEIVABLE: 'ACC-1100',
  INVENTORY: 'ACC-1200',
  ACCOUNTS_PAYABLE: 'ACC-2100',
  OWNER_CAPITAL: 'ACC-3100',
  OPENING_BALANCE_EQUITY: 'ACC-3900',
  SALES_REVENUE: 'ACC-4010',
  OTHER_INCOME: 'ACC-4900',
  COGS: 'ACC-5010',
} as const;

interface AccountSeed {
  code: string;
  name: string;
  type: AccountType;
  parentCode?: string;
  isCash?: boolean;
  isBank?: boolean;
  isSystem?: boolean;
}

export const CHART_OF_ACCOUNTS: AccountSeed[] = [
  { code: '1000', name: 'Assets', type: 'asset', isSystem: true },
  { code: '1010', name: 'Cash in Hand', type: 'asset', parentCode: '1000', isCash: true, isSystem: true },
  { code: '1020', name: 'Bank', type: 'asset', parentCode: '1000', isBank: true, isSystem: true },
  { code: '1100', name: 'Accounts Receivable', type: 'asset', parentCode: '1000', isSystem: true },
  { code: '1200', name: 'Inventory', type: 'asset', parentCode: '1000', isSystem: true },
  { code: '2000', name: 'Liabilities', type: 'liability', isSystem: true },
  { code: '2100', name: 'Accounts Payable', type: 'liability', parentCode: '2000', isSystem: true },
  { code: '3000', name: 'Equity', type: 'equity', isSystem: true },
  { code: '3100', name: 'Owner Capital', type: 'equity', parentCode: '3000', isSystem: true },
  { code: '3900', name: 'Opening Balance Equity', type: 'equity', parentCode: '3000', isSystem: true },
  { code: '4000', name: 'Income', type: 'income', isSystem: true },
  { code: '4010', name: 'Sales Revenue', type: 'income', parentCode: '4000', isSystem: true },
  { code: '4900', name: 'Other Income', type: 'income', parentCode: '4000', isSystem: true },
  { code: '5000', name: 'Expenses', type: 'expense', isSystem: true },
  { code: '5010', name: 'Cost of Goods Sold', type: 'expense', parentCode: '5000', isSystem: true },
  { code: '5100', name: 'Salaries', type: 'expense', parentCode: '5000' },
  { code: '5110', name: 'Rent', type: 'expense', parentCode: '5000' },
  { code: '5120', name: 'Transport', type: 'expense', parentCode: '5000' },
  { code: '5130', name: 'Refreshments', type: 'expense', parentCode: '5000' },
  { code: '5140', name: 'Utilities', type: 'expense', parentCode: '5000' },
  { code: '5150', name: 'Repairs & Maintenance', type: 'expense', parentCode: '5000' },
  { code: '5900', name: 'Miscellaneous Expense', type: 'expense', parentCode: '5000' },
];

export function accountIdForCode(code: string): string {
  return `ACC-${code}`;
}

/**
 * Default admin credentials created by seed. The UI forces a password
 * change on first login (later phase); for now: change it immediately.
 */
export const DEFAULT_ADMIN = {
  username: 'admin',
  password: 'admin123',
  fullName: 'Administrator',
} as const;

export interface SeedResult {
  accountsInserted: number;
  adminCreated: boolean;
  settingsInserted: number;
}

const DEFAULT_SETTINGS: Record<string, unknown> = {
  business_profile: { name: '', address: '', phone: '' },
  fiscal_year_start: '07-01', // MM-DD, Bangladesh fiscal year
};

/** Idempotent: safe to run on every startup; only fills in what's missing. */
export async function seedDatabase(db: Db): Promise<SeedResult> {
  let accountsInserted = 0;
  for (const acc of CHART_OF_ACCOUNTS) {
    const result = db
      .insert(accounts)
      .values({
        id: accountIdForCode(acc.code),
        code: acc.code,
        name: acc.name,
        type: acc.type,
        parentId: acc.parentCode ? accountIdForCode(acc.parentCode) : null,
        isCash: acc.isCash ?? false,
        isBank: acc.isBank ?? false,
        isSystem: acc.isSystem ?? false,
      })
      .onConflictDoNothing()
      .run();
    accountsInserted += result.changes;
  }

  let adminCreated = false;
  const existingAdmin = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, DEFAULT_ADMIN.username))
    .get();
  if (!existingAdmin) {
    const passwordHash = await argon2.hash(DEFAULT_ADMIN.password);
    db.insert(users)
      .values({
        id: newUlid(),
        username: DEFAULT_ADMIN.username,
        passwordHash,
        fullName: DEFAULT_ADMIN.fullName,
        role: 'admin',
      })
      .run();
    adminCreated = true;
  }

  let settingsInserted = 0;
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const result = db
      .insert(settings)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoNothing()
      .run();
    settingsInserted += result.changes;
  }

  return { accountsInserted, adminCreated, settingsInserted };
}
