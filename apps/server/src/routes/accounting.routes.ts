import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../errors';
import type { AppContext } from '../server';
import { DATE_RE, resolveScope } from './scope';

const rangeSchema = z.object({
  from: z.string().regex(DATE_RE),
  to: z.string().regex(DATE_RE),
  scope: z.string().max(20).optional(),
});

interface LedgerRow {
  date: string;
  entryId: string;
  branchCode: string;
  refType: string;
  narration: string;
  accountName?: string;
  partyName: string | null;
  debitPaisa: number;
  creditPaisa: number;
  balancePaisa: number;
}

/**
 * Every figure here is derived from journal_lines, so per-branch and
 * whole-company views balance by construction (reversals net out).
 */
export function registerAccountingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const read = { preHandler: app.requireAuth('viewer') };

  // ---- Journal: entries with lines, newest first ----
  app.get('/api/accounting/journal', read, async (req) => {
    const q = rangeSchema.parse(req.query);
    const scope = resolveScope(ctx, q.scope);
    const filter = scope.branch ? 'AND e.branch_code = @branch' : '';
    const params = { from: q.from, to: q.to, ...(scope.branch ? { branch: scope.branch } : {}) };

    const entries = ctx.sqlite
      .prepare(
        `SELECT e.id, e.entry_date AS date, e.narration, e.ref_type AS refType,
                e.branch_code AS branchCode, e.is_reversed AS isReversed
         FROM journal_entries e
         WHERE e.entry_date BETWEEN @from AND @to ${filter}
         ORDER BY e.entry_date DESC, e.id DESC LIMIT 300`,
      )
      .all(params) as Array<Record<string, unknown> & { id: string }>;

    const lineStmt = ctx.sqlite.prepare(
      `SELECT l.line_no AS lineNo, l.debit_paisa AS debitPaisa, l.credit_paisa AS creditPaisa,
              l.line_note AS lineNote, a.code AS accountCode, a.name AS accountName,
              p.name AS partyName
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN parties p ON p.id = l.party_id
       WHERE l.entry_id = ? ORDER BY l.line_no`,
    );
    return {
      scope: scope.branch ?? 'ALL',
      asOf: scope.asOf,
      entries: entries.map((e) => ({ ...e, isReversed: e['isReversed'] === 1, lines: lineStmt.all(e.id) })),
    };
  });

  // ---- Ledger: one account, opening + running balance ----
  app.get('/api/accounting/ledger', read, async (req) => {
    const q = rangeSchema.extend({ accountId: z.string().min(1) }).parse(req.query);
    const scope = resolveScope(ctx, q.scope);
    const account = ctx.sqlite
      .prepare(`SELECT id, code, name, type FROM accounts WHERE id = ?`)
      .get(q.accountId) as { id: string; code: string; name: string; type: string } | undefined;
    if (!account) throw new NotFoundError('Account not found');

    const filter = scope.branch ? 'AND e.branch_code = @branch' : '';
    const params = {
      from: q.from,
      to: q.to,
      accountId: q.accountId,
      ...(scope.branch ? { branch: scope.branch } : {}),
    };

    const opening = (
      ctx.sqlite
        .prepare(
          `SELECT COALESCE(SUM(l.debit_paisa - l.credit_paisa), 0) v
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
           WHERE l.account_id = @accountId AND e.entry_date < @from ${filter}`,
        )
        .get(params) as { v: number }
    ).v;

    const raw = ctx.sqlite
      .prepare(
        `SELECT e.entry_date AS date, e.id AS entryId, e.branch_code AS branchCode,
                e.ref_type AS refType, e.narration, p.name AS partyName,
                l.debit_paisa AS debitPaisa, l.credit_paisa AS creditPaisa
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         LEFT JOIN parties p ON p.id = l.party_id
         WHERE l.account_id = @accountId AND e.entry_date BETWEEN @from AND @to ${filter}
         ORDER BY e.entry_date, e.id, l.line_no LIMIT 1000`,
      )
      .all(params) as Array<Omit<LedgerRow, 'balancePaisa'>>;

    let balance = opening;
    const rows: LedgerRow[] = raw.map((r) => {
      balance += r.debitPaisa - r.creditPaisa;
      return { ...r, balancePaisa: balance };
    });

    return {
      scope: scope.branch ?? 'ALL',
      asOf: scope.asOf,
      account,
      openingPaisa: opening,
      closingPaisa: balance,
      rows,
    };
  });

  // ---- Cash book / Bank book: all is_cash (or is_bank) accounts combined ----
  app.get('/api/accounting/cash-book', read, async (req) => {
    const q = rangeSchema.extend({ kind: z.enum(['cash', 'bank']).default('cash') }).parse(req.query);
    const scope = resolveScope(ctx, q.scope);
    const flag = q.kind === 'cash' ? 'a.is_cash = 1' : 'a.is_bank = 1';
    const filter = scope.branch ? 'AND e.branch_code = @branch' : '';
    const params = { from: q.from, to: q.to, ...(scope.branch ? { branch: scope.branch } : {}) };

    const opening = (
      ctx.sqlite
        .prepare(
          `SELECT COALESCE(SUM(l.debit_paisa - l.credit_paisa), 0) v
           FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND ${flag}
           JOIN journal_entries e ON e.id = l.entry_id
           WHERE e.entry_date < @from ${filter}`,
        )
        .get(params) as { v: number }
    ).v;

    const raw = ctx.sqlite
      .prepare(
        `SELECT e.entry_date AS date, e.id AS entryId, e.branch_code AS branchCode,
                e.ref_type AS refType, e.narration, a.name AS accountName, p.name AS partyName,
                l.debit_paisa AS debitPaisa, l.credit_paisa AS creditPaisa
         FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id AND ${flag}
         JOIN journal_entries e ON e.id = l.entry_id
         LEFT JOIN parties p ON p.id = l.party_id
         WHERE e.entry_date BETWEEN @from AND @to ${filter}
         ORDER BY e.entry_date, e.id, l.line_no LIMIT 1000`,
      )
      .all(params) as Array<Omit<LedgerRow, 'balancePaisa'>>;

    let balance = opening;
    const rows: LedgerRow[] = raw.map((r) => {
      balance += r.debitPaisa - r.creditPaisa;
      return { ...r, balancePaisa: balance };
    });
    const totalIn = rows.reduce((s, r) => s + r.debitPaisa, 0);
    const totalOut = rows.reduce((s, r) => s + r.creditPaisa, 0);

    return {
      scope: scope.branch ?? 'ALL',
      asOf: scope.asOf,
      kind: q.kind,
      openingPaisa: opening,
      closingPaisa: balance,
      totalInPaisa: totalIn,
      totalOutPaisa: totalOut,
      rows,
    };
  });

  // ---- Trial balance: per-account Dr/Cr as of a date; must always balance ----
  app.get('/api/accounting/trial-balance', read, async (req) => {
    const q = z
      .object({ asOf: z.string().regex(DATE_RE), scope: z.string().max(20).optional() })
      .parse(req.query);
    const scope = resolveScope(ctx, q.scope);
    const filter = scope.branch ? 'AND e.branch_code = @branch' : '';
    const params = { asOf: q.asOf, ...(scope.branch ? { branch: scope.branch } : {}) };

    const rows = ctx.sqlite
      .prepare(
        `SELECT a.id, a.code, a.name, a.type,
                COALESCE(SUM(l.debit_paisa), 0) AS totalDebitPaisa,
                COALESCE(SUM(l.credit_paisa), 0) AS totalCreditPaisa
         FROM accounts a
         JOIN journal_lines l ON l.account_id = a.id
         JOIN journal_entries e ON e.id = l.entry_id
         WHERE e.entry_date <= @asOf ${filter}
         GROUP BY a.id HAVING totalDebitPaisa <> 0 OR totalCreditPaisa <> 0
         ORDER BY a.code`,
      )
      .all(params) as Array<{
      id: string;
      code: string;
      name: string;
      type: string;
      totalDebitPaisa: number;
      totalCreditPaisa: number;
    }>;

    const accounts = rows.map((r) => {
      const net = r.totalDebitPaisa - r.totalCreditPaisa;
      return {
        ...r,
        debitBalancePaisa: net > 0 ? net : 0,
        creditBalancePaisa: net < 0 ? -net : 0,
      };
    });
    const totalDebit = accounts.reduce((s, r) => s + r.debitBalancePaisa, 0);
    const totalCredit = accounts.reduce((s, r) => s + r.creditBalancePaisa, 0);

    return {
      scope: scope.branch ?? 'ALL',
      asOfDate: q.asOf,
      asOf: scope.asOf,
      accounts,
      totalDebitPaisa: totalDebit,
      totalCreditPaisa: totalCredit,
      balanced: totalDebit === totalCredit,
    };
  });
}
