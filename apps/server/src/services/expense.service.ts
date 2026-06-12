import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { asPaisa, newUlid } from '@leather-erp/core';
import { accounts, expenses, SYSTEM_ACCOUNTS } from '@leather-erp/db';
import { BadRequestError, NotFoundError } from '../errors';
import { writeAudit } from './audit';
import { nextChangeSeq } from './change-seq';
import { requireInstall, type ServiceDeps } from './deps';

export const createExpenseSchema = z.object({
  expenseAccountId: z.string().min(1),
  amountPaisa: z.number().int().positive(),
  spentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(300).nullish(),
  /** Cash/bank account the money left from; defaults to Cash in Hand. */
  paidFromAccountId: z.string().min(1).optional(),
});
export type CreateExpenseInput = z.input<typeof createExpenseSchema>;

export type Expense = typeof expenses.$inferSelect;

export class ExpenseService {
  constructor(private readonly deps: ServiceDeps) {}

  list(
    filter: { from?: string | undefined; to?: string | undefined; branchCode?: string | undefined } = {},
  ): Expense[] {
    const where = [];
    if (filter.from) where.push(gte(expenses.spentDate, filter.from));
    if (filter.to) where.push(lte(expenses.spentDate, filter.to));
    if (filter.branchCode) where.push(eq(expenses.branchCode, filter.branchCode));
    return this.deps.db
      .select()
      .from(expenses)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(expenses.spentDate))
      .limit(500)
      .all();
  }

  get(id: string): Expense {
    const row = this.deps.db.select().from(expenses).where(eq(expenses.id, id)).get();
    if (!row) throw new NotFoundError('Expense not found');
    return row;
  }

  /** Petty expense: Dr expense account / Cr Cash (or chosen cash/bank account). */
  create(input: CreateExpenseInput, actorId: string | null): Expense {
    const parsed = createExpenseSchema.parse(input);
    const install = requireInstall(this.deps);
    const amount = asPaisa(parsed.amountPaisa);

    const expenseAccount = this.deps.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, parsed.expenseAccountId))
      .get();
    if (!expenseAccount) throw new NotFoundError('Expense account not found');
    if (expenseAccount.type !== 'expense' || expenseAccount.parentId === null) {
      throw new BadRequestError(
        `'${expenseAccount.name}' is not a postable expense account (pick a category under Expenses)`,
      );
    }

    const paidFromId = parsed.paidFromAccountId ?? SYSTEM_ACCOUNTS.CASH;
    const paidFrom = this.deps.db.select().from(accounts).where(eq(accounts.id, paidFromId)).get();
    if (!paidFrom) throw new NotFoundError('Paying account not found');
    if (!paidFrom.isCash && !paidFrom.isBank) {
      throw new BadRequestError(`'${paidFrom.name}' is not a cash or bank account`);
    }

    return this.deps.sqlite.transaction(() => {
      const id = newUlid();
      const entry = this.deps.ledger.postEntry({
        entryDate: parsed.spentDate,
        narration: parsed.note?.trim() ? parsed.note : `Expense — ${expenseAccount.name}`,
        refType: 'expense',
        refId: id,
        createdBy: actorId,
        lines: [
          { accountId: expenseAccount.id, debitPaisa: amount },
          { accountId: paidFrom.id, creditPaisa: amount },
        ],
      });

      this.deps.db
        .insert(expenses)
        .values({
          id,
          branchCode: install.branchCode,
          changeSeq: nextChangeSeq(this.deps.sqlite),
          expenseAccountId: expenseAccount.id,
          paidFromAccountId: paidFrom.id,
          amountPaisa: amount,
          note: parsed.note ?? null,
          spentDate: parsed.spentDate,
          journalEntryId: entry.id,
          createdBy: actorId,
        })
        .run();

      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'expense.create',
        tableName: 'expenses',
        recordId: id,
        detail: { account: expenseAccount.name, amountPaisa: amount },
      });
      return this.get(id);
    })();
  }
}
