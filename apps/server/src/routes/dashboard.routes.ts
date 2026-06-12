import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InstallNotConfiguredError } from '../errors';
import type { AppContext } from '../server';

const querySchema = z.object({
  /** 'THIS' (default) | 'ALL' | a branch code. */
  scope: z.string().trim().max(20).optional(),
});

/** Local calendar date YYYY-MM-DD (doc dates are local business dates). */
function localDate(daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString('en-CA');
}

/**
 * All dashboard figures are computed HERE, in SQL over integer paisa —
 * the UI only formats what it receives (non-negotiable rule 1).
 */
export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/dashboard', { preHandler: app.requireAuth('viewer') }, async (req) => {
    const install = ctx.install.getInstall();
    if (!install) throw new InstallNotConfiguredError();

    const q = querySchema.parse(req.query);
    const scopeRaw = (q.scope ?? 'THIS').toUpperCase();
    /** null = whole company */
    const branch =
      scopeRaw === 'ALL' ? null : scopeRaw === 'THIS' ? install.branchCode : scopeRaw;

    const today = localDate();
    const from = localDate(29);
    const docFilter = branch ? 'AND branch_code = @branch' : '';
    const entryFilter = branch ? 'AND e.branch_code = @branch' : '';
    const params = branch ? { branch, today, from } : { today, from };

    const sum = (sql: string): number =>
      (ctx.sqlite.prepare(sql).get(params) as { v: number }).v;

    const todaySalesPaisa = sum(
      `SELECT COALESCE(SUM(total_paisa),0) v FROM sales WHERE status='posted' AND doc_date=@today ${docFilter}`,
    );
    const todayPurchasesPaisa = sum(
      `SELECT COALESCE(SUM(total_paisa),0) v FROM purchases WHERE status='posted' AND doc_date=@today ${docFilter}`,
    );
    const todayExpensesPaisa = sum(
      `SELECT COALESCE(SUM(amount_paisa),0) v FROM expenses WHERE spent_date=@today ${docFilter}`,
    );

    const cashPaisa = sum(
      `SELECT COALESCE(SUM(l.debit_paisa - l.credit_paisa),0) v FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id AND a.is_cash = 1
       JOIN journal_entries e ON e.id = l.entry_id WHERE 1=1 ${entryFilter}`,
    );
    const bankPaisa = sum(
      `SELECT COALESCE(SUM(l.debit_paisa - l.credit_paisa),0) v FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id AND a.is_bank = 1
       JOIN journal_entries e ON e.id = l.entry_id WHERE 1=1 ${entryFilter}`,
    );
    const receivablesPaisa = sum(
      `SELECT COALESCE(SUM(l.debit_paisa - l.credit_paisa),0) v FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = 'ACC-1100' ${entryFilter}`,
    );
    const payablesPaisa = sum(
      `SELECT COALESCE(SUM(l.credit_paisa - l.debit_paisa),0) v FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = 'ACC-2100' ${entryFilter}`,
    );

    // Low stock is inherently per-branch; for ALL scope we report this branch.
    const stockBranch = branch ?? install.branchCode;
    const lowStockCount = (
      ctx.sqlite
        .prepare(
          `SELECT COUNT(*) v FROM (
             SELECT p.id, COALESCE(SUM(m.qty_milli), 0) AS on_hand
             FROM products p
             LEFT JOIN stock_moves m ON m.product_id = p.id AND m.branch_code = ?
             WHERE p.is_deleted = 0 AND p.is_active = 1 AND p.reorder_level_milli > 0
             GROUP BY p.id
             HAVING on_hand <= p.reorder_level_milli)`,
        )
        .get(stockBranch) as { v: number }
    ).v;

    const salesByDay = ctx.sqlite
      .prepare(
        `SELECT doc_date d, COALESCE(SUM(total_paisa),0) v FROM sales
         WHERE status='posted' AND doc_date >= @from ${docFilter} GROUP BY doc_date`,
      )
      .all(params) as Array<{ d: string; v: number }>;
    const purchasesByDay = ctx.sqlite
      .prepare(
        `SELECT doc_date d, COALESCE(SUM(total_paisa),0) v FROM purchases
         WHERE status='posted' AND doc_date >= @from ${docFilter} GROUP BY doc_date`,
      )
      .all(params) as Array<{ d: string; v: number }>;
    const salesMap = new Map(salesByDay.map((r) => [r.d, r.v]));
    const purchasesMap = new Map(purchasesByDay.map((r) => [r.d, r.v]));
    const series = Array.from({ length: 30 }, (_, i) => {
      const date = localDate(29 - i);
      return {
        date,
        salesPaisa: salesMap.get(date) ?? 0,
        purchasesPaisa: purchasesMap.get(date) ?? 0,
      };
    });

    const branchRows = ctx.sqlite
      .prepare(
        `SELECT b.code, b.name, b.is_hub AS isHub, s.last_import_at AS lastImportAt
         FROM branches b LEFT JOIN sync_state s ON s.peer_branch = b.code ORDER BY b.code`,
      )
      .all() as Array<{ code: string; name: string; isHub: number; lastImportAt: string | null }>;

    return {
      scope: branch ?? 'ALL',
      branchCode: install.branchCode,
      isHub: install.isHub,
      today: {
        salesPaisa: todaySalesPaisa,
        purchasesPaisa: todayPurchasesPaisa,
        expensesPaisa: todayExpensesPaisa,
      },
      cashPaisa,
      bankPaisa,
      receivablesPaisa,
      payablesPaisa,
      lowStockCount,
      lowStockBranch: stockBranch,
      series,
      branches: branchRows.map((b) => ({
        code: b.code,
        name: b.name,
        isHub: b.isHub === 1,
        isSelf: b.code === install.branchCode,
        lastImportAt: b.lastImportAt,
      })),
    };
  });
}
