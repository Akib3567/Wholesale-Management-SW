import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../server';
import { DATE_RE, resolveScope } from './scope';

/**
 * Read-only CSV-data export for a date range. Unlike the list endpoints
 * (capped at 500 rows for screen display), these queries are bounded only by
 * the date range so an exported "backup" of a busy period is never silently
 * truncated. Names are resolved server-side; the UI builds the CSV files.
 */
export function registerExportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const read = { preHandler: app.requireAuth('viewer') };

  app.get('/api/export/data', read, async (req) => {
    const q = z
      .object({
        from: z.string().regex(DATE_RE),
        to: z.string().regex(DATE_RE),
        scope: z.string().max(20).optional(),
      })
      .parse(req.query);
    const scope = resolveScope(ctx, q.scope);
    const bd = scope.branch ? 'AND d.branch_code = @branch' : '';
    const params = { from: q.from, to: q.to, ...(scope.branch ? { branch: scope.branch } : {}) };
    const LIMIT = 100_000;

    const docSql = (table: 'sales' | 'purchases') => `
      SELECT d.doc_date AS date, d.doc_no AS docNo, d.branch_code AS branchCode, p.name AS partyName,
             d.subtotal_paisa AS subtotalPaisa, d.discount_paisa AS discountPaisa,
             d.total_paisa AS totalPaisa, d.paid_paisa AS paidPaisa, d.status, d.note
      FROM ${table} d LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.doc_date BETWEEN @from AND @to ${bd}
      ORDER BY d.doc_date, d.doc_no LIMIT ${LIMIT}`;

    const sales = ctx.sqlite.prepare(docSql('sales')).all(params);
    const purchases = ctx.sqlite.prepare(docSql('purchases')).all(params);

    const payments = ctx.sqlite
      .prepare(
        `SELECT d.paid_date AS date, p.name AS partyName, d.direction, d.method, d.ref_no AS refNo,
                d.amount_paisa AS amountPaisa, d.branch_code AS branchCode, d.note
         FROM payments d LEFT JOIN parties p ON p.id = d.party_id
         WHERE d.paid_date BETWEEN @from AND @to ${bd}
         ORDER BY d.paid_date LIMIT ${LIMIT}`,
      )
      .all(params);

    const expenses = ctx.sqlite
      .prepare(
        `SELECT d.spent_date AS date, ea.name AS accountName, pf.name AS paidFromName,
                d.amount_paisa AS amountPaisa, d.branch_code AS branchCode, d.note
         FROM expenses d
         JOIN accounts ea ON ea.id = d.expense_account_id
         LEFT JOIN accounts pf ON pf.id = d.paid_from_account_id
         WHERE d.spent_date BETWEEN @from AND @to ${bd}
         ORDER BY d.spent_date LIMIT ${LIMIT}`,
      )
      .all(params);

    return {
      from: q.from,
      to: q.to,
      scope: scope.branch ?? 'ALL',
      asOf: scope.asOf,
      sales,
      purchases,
      payments,
      expenses,
    };
  });
}
