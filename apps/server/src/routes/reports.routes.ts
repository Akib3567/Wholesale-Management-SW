import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../errors';
import type { AppContext } from '../server';
import { DATE_RE, resolveScope } from './scope';

const AR = 'ACC-1100';
const AP = 'ACC-2100';
const COGS = 'ACC-5010';

export function registerReportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const read = { preHandler: app.requireAuth('viewer') };

  // ---- Daily Sales / Daily Purchases: one day's documents + totals ----
  for (const kind of ['sales', 'purchases'] as const) {
    app.get(`/api/reports/daily-${kind}`, read, async (req) => {
      const q = z
        .object({ date: z.string().regex(DATE_RE), scope: z.string().max(20).optional() })
        .parse(req.query);
      const scope = resolveScope(ctx, q.scope);
      const filter = scope.branch ? 'AND d.branch_code = @branch' : '';
      const params = { date: q.date, ...(scope.branch ? { branch: scope.branch } : {}) };

      const rows = ctx.sqlite
        .prepare(
          `SELECT d.id, d.doc_no AS docNo, d.branch_code AS branchCode, p.name AS partyName,
                  d.subtotal_paisa AS subtotalPaisa, d.discount_paisa AS discountPaisa,
                  d.total_paisa AS totalPaisa, d.paid_paisa AS paidPaisa,
                  (d.total_paisa - d.paid_paisa) AS duePaisa
           FROM ${kind} d LEFT JOIN parties p ON p.id = d.party_id
           WHERE d.doc_date = @date AND d.status = 'posted' ${filter}
           ORDER BY d.branch_code, d.doc_no`,
        )
        .all(params) as Array<{ totalPaisa: number; paidPaisa: number; duePaisa: number }>;

      return {
        scope: scope.branch ?? 'ALL',
        asOf: scope.asOf,
        date: q.date,
        rows,
        totals: {
          count: rows.length,
          totalPaisa: rows.reduce((s, r) => s + r.totalPaisa, 0),
          paidPaisa: rows.reduce((s, r) => s + r.paidPaisa, 0),
          duePaisa: rows.reduce((s, r) => s + r.duePaisa, 0),
        },
      };
    });
  }

  // ---- Party statement: AR/AP movements with running balance ----
  // Sign convention: positive balance = party owes us; negative = we owe party.
  app.get('/api/reports/statement', read, async (req) => {
    const q = z
      .object({
        partyId: z.string().min(1),
        from: z.string().regex(DATE_RE),
        to: z.string().regex(DATE_RE),
        scope: z.string().max(20).optional(),
      })
      .parse(req.query);
    const scope = resolveScope(ctx, q.scope);
    const party = ctx.sqlite
      .prepare(`SELECT id, code, name, kind, phone, branch_code AS branchCode FROM parties WHERE id = ?`)
      .get(q.partyId) as { id: string; name: string } | undefined;
    if (!party) throw new NotFoundError('Party not found');

    const filter = scope.branch ? 'AND e.branch_code = @branch' : '';
    const params = {
      partyId: q.partyId,
      from: q.from,
      to: q.to,
      ar: AR,
      ap: AP,
      ...(scope.branch ? { branch: scope.branch } : {}),
    };

    const opening = (
      ctx.sqlite
        .prepare(
          `SELECT COALESCE(SUM(l.debit_paisa - l.credit_paisa), 0) v
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
           WHERE l.party_id = @partyId AND l.account_id IN (@ar, @ap)
             AND e.entry_date < @from ${filter}`,
        )
        .get(params) as { v: number }
    ).v;

    const raw = ctx.sqlite
      .prepare(
        `SELECT e.entry_date AS date, e.id AS entryId, e.branch_code AS branchCode,
                e.ref_type AS refType, e.narration,
                l.debit_paisa AS debitPaisa, l.credit_paisa AS creditPaisa
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE l.party_id = @partyId AND l.account_id IN (@ar, @ap)
           AND e.entry_date BETWEEN @from AND @to ${filter}
         ORDER BY e.entry_date, e.id LIMIT 1000`,
      )
      .all(params) as Array<{
      date: string;
      entryId: string;
      branchCode: string;
      refType: string;
      narration: string;
      debitPaisa: number;
      creditPaisa: number;
    }>;

    let balance = opening;
    const rows = raw.map((r) => {
      balance += r.debitPaisa - r.creditPaisa;
      return { ...r, balancePaisa: balance };
    });

    return {
      scope: scope.branch ?? 'ALL',
      asOf: scope.asOf,
      party,
      openingPaisa: opening,
      closingPaisa: balance,
      rows,
    };
  });

  // ---- P&L over a date range ----
  app.get('/api/reports/pnl', read, async (req) => {
    const q = z
      .object({
        from: z.string().regex(DATE_RE),
        to: z.string().regex(DATE_RE),
        scope: z.string().max(20).optional(),
      })
      .parse(req.query);
    const scope = resolveScope(ctx, q.scope);
    const filter = scope.branch ? 'AND e.branch_code = @branch' : '';
    const params = { from: q.from, to: q.to, ...(scope.branch ? { branch: scope.branch } : {}) };

    const grouped = (type: 'income' | 'expense', signed: string) =>
      ctx.sqlite
        .prepare(
          `SELECT a.id, a.code, a.name, COALESCE(SUM(${signed}), 0) AS amountPaisa
           FROM accounts a
           JOIN journal_lines l ON l.account_id = a.id
           JOIN journal_entries e ON e.id = l.entry_id
           WHERE a.type = '${type}' AND e.entry_date BETWEEN @from AND @to ${filter}
           GROUP BY a.id HAVING amountPaisa <> 0 ORDER BY a.code`,
        )
        .all(params) as Array<{ id: string; code: string; name: string; amountPaisa: number }>;

    const income = grouped('income', 'l.credit_paisa - l.debit_paisa');
    const expense = grouped('expense', 'l.debit_paisa - l.credit_paisa');

    const cogsRow = expense.find((r) => r.id === COGS);
    const operatingExpenses = expense.filter((r) => r.id !== COGS);
    const revenuePaisa = income.reduce((s, r) => s + r.amountPaisa, 0);
    const cogsPaisa = cogsRow?.amountPaisa ?? 0;
    const grossProfitPaisa = revenuePaisa - cogsPaisa;
    const expensesPaisa = operatingExpenses.reduce((s, r) => s + r.amountPaisa, 0);

    return {
      scope: scope.branch ?? 'ALL',
      asOf: scope.asOf,
      from: q.from,
      to: q.to,
      income,
      cogsPaisa,
      grossProfitPaisa,
      operatingExpenses,
      expensesPaisa,
      netProfitPaisa: grossProfitPaisa - expensesPaisa,
    };
  });
}
