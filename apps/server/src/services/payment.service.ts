import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { asPaisa, newUlid } from '@leather-erp/core';
import {
  accounts,
  PAYMENT_DIRECTIONS,
  PAYMENT_METHODS,
  payments,
  SYSTEM_ACCOUNTS,
} from '@leather-erp/db';
import { BadRequestError, NotFoundError } from '../errors';
import { writeAudit } from './audit';
import { nextChangeSeq } from './change-seq';
import { requireInstall, type ServiceDeps } from './deps';
import type { PartyService } from './party.service';
import type { DocListFilter } from './purchase.service';

export const createPaymentSchema = z.object({
  partyId: z.string().min(1),
  /** 'out' = payment to supplier; 'in' = receipt from customer. */
  direction: z.enum(PAYMENT_DIRECTIONS),
  amountPaisa: z.number().int().positive(),
  method: z.enum(PAYMENT_METHODS),
  accountId: z.string().min(1).optional(),
  refNo: z.string().trim().max(40).nullish(),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(300).nullish(),
});
export type CreatePaymentInput = z.input<typeof createPaymentSchema>;

export type Payment = typeof payments.$inferSelect;

export class PaymentService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly parties: PartyService,
  ) {}

  list(filter: DocListFilter & { direction?: 'in' | 'out' | undefined } = {}): Payment[] {
    const where = [];
    if (filter.from) where.push(gte(payments.paidDate, filter.from));
    if (filter.to) where.push(lte(payments.paidDate, filter.to));
    if (filter.partyId) where.push(eq(payments.partyId, filter.partyId));
    if (filter.direction) where.push(eq(payments.direction, filter.direction));
    if (filter.branchCode) where.push(eq(payments.branchCode, filter.branchCode));
    return this.deps.db
      .select()
      .from(payments)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(payments.paidDate))
      .limit(500)
      .all();
  }

  get(id: string): Payment {
    const row = this.deps.db.select().from(payments).where(eq(payments.id, id)).get();
    if (!row) throw new NotFoundError('Payment not found');
    return row;
  }

  /**
   * Payment to supplier:    Dr Accounts Payable→party / Cr Cash|Bank
   * Receipt from customer:  Dr Cash|Bank / Cr Accounts Receivable→party
   * Corrections post an opposite-direction payment (financial rows are never deleted).
   */
  create(input: CreatePaymentInput, actorId: string | null): Payment {
    const parsed = createPaymentSchema.parse(input);
    const install = requireInstall(this.deps);
    const party = this.parties.get(parsed.partyId);
    const amount = asPaisa(parsed.amountPaisa);

    const accountId =
      parsed.accountId ?? (parsed.method === 'bank' ? SYSTEM_ACCOUNTS.BANK : SYSTEM_ACCOUNTS.CASH);
    const account = this.deps.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) throw new NotFoundError('Money account not found');
    if (parsed.method === 'cash' && !account.isCash) {
      throw new BadRequestError(`Account '${account.name}' is not a cash account`);
    }
    if (parsed.method === 'bank' && !account.isBank) {
      throw new BadRequestError(`Account '${account.name}' is not a bank account`);
    }

    return this.deps.sqlite.transaction(() => {
      const id = newUlid();
      const entry = this.deps.ledger.postEntry({
        entryDate: parsed.paidDate,
        narration:
          parsed.direction === 'out'
            ? `Payment to ${party.name}`
            : `Receipt from ${party.name}`,
        refType: parsed.direction === 'out' ? 'payment' : 'receipt',
        refId: id,
        createdBy: actorId,
        lines:
          parsed.direction === 'out'
            ? [
                { accountId: SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, partyId: party.id, debitPaisa: amount },
                { accountId: account.id, creditPaisa: amount },
              ]
            : [
                { accountId: account.id, debitPaisa: amount },
                { accountId: SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, partyId: party.id, creditPaisa: amount },
              ],
      });

      this.deps.db
        .insert(payments)
        .values({
          id,
          branchCode: install.branchCode,
          changeSeq: nextChangeSeq(this.deps.sqlite),
          partyId: party.id,
          direction: parsed.direction,
          amountPaisa: amount,
          method: parsed.method,
          accountId: account.id,
          refNo: parsed.refNo ?? null,
          paidDate: parsed.paidDate,
          journalEntryId: entry.id,
          note: parsed.note ?? null,
          createdBy: actorId,
        })
        .run();

      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'payment.create',
        tableName: 'payments',
        recordId: id,
        detail: { party: party.name, direction: parsed.direction, amountPaisa: amount },
      });
      return this.get(id);
    })();
  }
}
