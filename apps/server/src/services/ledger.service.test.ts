import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  runMigrations,
  seedDatabase,
  SYSTEM_ACCOUNTS,
  type OpenDatabaseResult,
} from '@leather-erp/db';
import { ZodError } from 'zod';
import { ForbiddenError, InstallNotConfiguredError, UnbalancedEntryError } from '../errors';
import { InstallService } from './install.service';
import { LedgerService } from './ledger.service';

let tmpDir: string;
let handle: OpenDatabaseResult;
let ledger: LedgerService;

function counts() {
  const entries = handle.sqlite.prepare('SELECT COUNT(*) c FROM journal_entries').get() as {
    c: number;
  };
  const lines = handle.sqlite.prepare('SELECT COUNT(*) c FROM journal_lines').get() as {
    c: number;
  };
  const seq = handle.sqlite
    .prepare('SELECT next_change_seq s FROM this_install WHERE id = 1')
    .get() as { s: number };
  return { entries: entries.c, lines: lines.c, seq: seq.s };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'leather-erp-ledger-'));
  handle = openDatabase(join(tmpDir, 'test.sqlite'));
  runMigrations(handle.db);
  await seedDatabase(handle.db);
  ledger = new LedgerService(handle.sqlite, handle.db);
});

afterAll(() => {
  handle.sqlite.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('postEntry before branch setup', () => {
  it('refuses to post when the install has no branch identity', () => {
    expect(() =>
      ledger.postEntry({
        entryDate: '2026-06-12',
        refType: 'adjustment',
        lines: [
          { accountId: SYSTEM_ACCOUNTS.CASH, debitPaisa: 1000 },
          { accountId: SYSTEM_ACCOUNTS.OTHER_INCOME, creditPaisa: 1000 },
        ],
      }),
    ).toThrow(InstallNotConfiguredError);
  });
});

describe('postEntry', () => {
  beforeAll(() => {
    new InstallService(handle.sqlite, handle.db).bootstrap(
      { branchCode: 'DHAKA', branchName: 'Dhaka Head Office', isHub: true },
      null,
    );
  });

  it('rejects an unbalanced entry and writes nothing', () => {
    const before = counts();
    expect(() =>
      ledger.postEntry({
        entryDate: '2026-06-12',
        refType: 'sale',
        lines: [
          { accountId: SYSTEM_ACCOUNTS.CASH, debitPaisa: 10_000 },
          { accountId: SYSTEM_ACCOUNTS.SALES_REVENUE, creditPaisa: 9_999 },
        ],
      }),
    ).toThrow(UnbalancedEntryError);
    expect(counts()).toEqual(before);
  });

  it('rejects malformed lines (both sides, zero, negative, floats, < 2 lines)', () => {
    const base = { entryDate: '2026-06-12', refType: 'adjustment' as const };
    const cash = SYSTEM_ACCOUNTS.CASH;
    const income = SYSTEM_ACCOUNTS.OTHER_INCOME;

    // a line with both debit and credit
    expect(() =>
      ledger.postEntry({
        ...base,
        lines: [
          { accountId: cash, debitPaisa: 100, creditPaisa: 100 },
          { accountId: income, creditPaisa: 0, debitPaisa: 0 },
        ],
      }),
    ).toThrow(ZodError);
    // negative amounts
    expect(() =>
      ledger.postEntry({
        ...base,
        lines: [
          { accountId: cash, debitPaisa: -100 },
          { accountId: income, creditPaisa: -100 },
        ],
      }),
    ).toThrow(ZodError);
    // float paisa
    expect(() =>
      ledger.postEntry({
        ...base,
        lines: [
          { accountId: cash, debitPaisa: 100.5 },
          { accountId: income, creditPaisa: 100.5 },
        ],
      }),
    ).toThrow(ZodError);
    // fewer than 2 lines
    expect(() =>
      ledger.postEntry({ ...base, lines: [{ accountId: cash, debitPaisa: 100 }] }),
    ).toThrow(ZodError);
  });

  it('commits a balanced entry atomically with branch stamp and change_seq', () => {
    const before = counts();
    const posted = ledger.postEntry({
      entryDate: '2026-06-12',
      narration: 'Cash sale',
      refType: 'sale',
      lines: [
        { accountId: SYSTEM_ACCOUNTS.CASH, debitPaisa: 50_000 },
        { accountId: SYSTEM_ACCOUNTS.SALES_REVENUE, creditPaisa: 50_000 },
      ],
    });

    expect(posted.branchCode).toBe('DHAKA');
    expect(posted.changeSeq).toBe(before.seq + 1);
    expect(posted.debitTotalPaisa).toBe(50_000);

    const { entry, lines } = ledger.getEntryWithLines(posted.id);
    expect(entry.branchCode).toBe('DHAKA');
    expect(entry.refType).toBe('sale');
    expect(lines).toHaveLength(2);
    const debit = lines.reduce((s, l) => s + l.debitPaisa, 0);
    const credit = lines.reduce((s, l) => s + l.creditPaisa, 0);
    expect(debit).toBe(credit);

    const after = counts();
    expect(after.entries).toBe(before.entries + 1);
    expect(after.lines).toBe(before.lines + 2);
  });

  it('rolls back EVERYTHING when a line fails mid-write (atomicity)', () => {
    const before = counts();
    expect(() =>
      ledger.postEntry({
        entryDate: '2026-06-12',
        refType: 'adjustment',
        lines: [
          { accountId: SYSTEM_ACCOUNTS.CASH, debitPaisa: 7_000 },
          { accountId: 'ACC-DOES-NOT-EXIST', creditPaisa: 7_000 }, // FK failure on line 2
        ],
      }),
    ).toThrow(/FOREIGN KEY/);
    // header, lines AND the change_seq counter all rolled back
    expect(counts()).toEqual(before);
  });

  it('gives consecutive change_seq values to consecutive postings', () => {
    const a = ledger.postEntry({
      entryDate: '2026-06-12',
      refType: 'expense',
      lines: [
        { accountId: 'ACC-5120', debitPaisa: 500 },
        { accountId: SYSTEM_ACCOUNTS.CASH, creditPaisa: 500 },
      ],
    });
    const b = ledger.postEntry({
      entryDate: '2026-06-12',
      refType: 'expense',
      lines: [
        { accountId: 'ACC-5130', debitPaisa: 300 },
        { accountId: SYSTEM_ACCOUNTS.CASH, creditPaisa: 300 },
      ],
    });
    expect(b.changeSeq).toBe(a.changeSeq + 1);
  });
});

describe('reverseEntry', () => {
  it('posts a mirror entry, links both, and refuses a second reversal', () => {
    const original = ledger.postEntry({
      entryDate: '2026-06-12',
      narration: 'Purchase on credit',
      refType: 'purchase',
      lines: [
        { accountId: SYSTEM_ACCOUNTS.INVENTORY, debitPaisa: 120_000 },
        { accountId: SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, creditPaisa: 120_000 },
      ],
    });

    const reversal = ledger.reverseEntry(original.id, {
      entryDate: '2026-06-13',
      refType: 'return',
    });

    const { entry: origEntry } = ledger.getEntryWithLines(original.id);
    expect(origEntry.isReversed).toBe(true);
    expect(origEntry.reversedByEntryId).toBe(reversal.id);

    const { lines: revLines } = ledger.getEntryWithLines(reversal.id);
    const inventoryLine = revLines.find((l) => l.accountId === SYSTEM_ACCOUNTS.INVENTORY);
    expect(inventoryLine?.creditPaisa).toBe(120_000); // swapped side
    expect(inventoryLine?.debitPaisa).toBe(0);

    expect(() => ledger.reverseEntry(original.id, { entryDate: '2026-06-13' })).toThrow(
      /already reversed/,
    );
  });

  it('refuses to reverse a foreign branch entry', () => {
    // simulate an imported CTG entry
    handle.sqlite
      .prepare(
        `INSERT INTO journal_entries (id, branch_code, change_seq, entry_date, ref_type)
         VALUES ('FOREIGNENTRY00000000000001', 'CTG', 1, '2026-06-10', 'sale')`,
      )
      .run();
    expect(() =>
      ledger.reverseEntry('FOREIGNENTRY00000000000001', { entryDate: '2026-06-12' }),
    ).toThrow(ForbiddenError);
  });
});
