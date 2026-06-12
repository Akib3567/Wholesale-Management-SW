import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { asPaisa, costOfQty, newUlid, subtractPaisa, sumPaisa } from '@leather-erp/core';
import {
  PAYMENT_METHODS,
  purchaseItems,
  purchases,
  stockMoves,
  SYSTEM_ACCOUNTS,
} from '@leather-erp/db';
import { BadRequestError, ConflictError, NotFoundError } from '../errors';
import { writeAudit } from './audit';
import { nextChangeSeq, nowIso } from './change-seq';
import { requireInstall, type ServiceDeps } from './deps';
import { nextDocNo } from './doc-no';
import { assertCanEdit } from './ownership';
import type { PartyService } from './party.service';
import type { ProductService } from './product.service';

export const createPurchaseSchema = z.object({
  partyId: z.string().min(1),
  docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  docNo: z.string().trim().min(1).max(30).optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        qtyMilli: z.number().int().positive(),
        unitCostPaisa: z.number().int().nonnegative(),
      }),
    )
    .min(1),
  discountPaisa: z.number().int().nonnegative().default(0),
  paidPaisa: z.number().int().nonnegative().default(0),
  paidMethod: z.enum(PAYMENT_METHODS).default('cash'),
  note: z.string().trim().max(300).nullish(),
});
export type CreatePurchaseInput = z.input<typeof createPurchaseSchema>;

/** Optional members allow explicit undefined: route handlers pass Zod-parsed optionals. */
export interface DocListFilter {
  from?: string | undefined;
  to?: string | undefined;
  partyId?: string | undefined;
  branchCode?: string | undefined;
}

export interface ReverseDocOptions {
  date?: string | undefined;
  reason?: string | undefined;
}

export type Purchase = typeof purchases.$inferSelect;
export type PurchaseItem = typeof purchaseItems.$inferSelect;

export interface PurchaseWithItems {
  purchase: Purchase;
  items: PurchaseItem[];
}

export class PurchaseService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly parties: PartyService,
    private readonly products: ProductService,
  ) {}

  list(filter: DocListFilter = {}): Purchase[] {
    const where = [];
    if (filter.from) where.push(gte(purchases.docDate, filter.from));
    if (filter.to) where.push(lte(purchases.docDate, filter.to));
    if (filter.partyId) where.push(eq(purchases.partyId, filter.partyId));
    if (filter.branchCode) where.push(eq(purchases.branchCode, filter.branchCode));
    return this.deps.db
      .select()
      .from(purchases)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(purchases.docDate), desc(purchases.docNo))
      .limit(500)
      .all();
  }

  get(id: string): PurchaseWithItems {
    const purchase = this.deps.db.select().from(purchases).where(eq(purchases.id, id)).get();
    if (!purchase) throw new NotFoundError('Purchase not found');
    const items = this.deps.db
      .select()
      .from(purchaseItems)
      .where(eq(purchaseItems.purchaseId, id))
      .orderBy(purchaseItems.lineNo)
      .all();
    return { purchase, items };
  }

  /**
   * Purchase from a supplier, atomically: document + items + stock IN moves
   * + ONE balanced journal entry:
   *   Dr Inventory (Σ line totals)
   *   Cr Other Income (discount received, if any)
   *   Cr Cash/Bank (paid now, if any)
   *   Cr Accounts Payable→party (the rest)
   */
  create(input: CreatePurchaseInput, actorId: string | null): PurchaseWithItems {
    const parsed = createPurchaseSchema.parse(input);
    const install = requireInstall(this.deps);

    const party = this.parties.get(parsed.partyId);
    if (party.kind === 'customer') {
      throw new BadRequestError(`'${party.name}' is a customer, not a supplier`);
    }

    const lines = parsed.items.map((item, i) => {
      const product = this.products.get(item.productId);
      if (!product.isActive) throw new BadRequestError(`Product '${product.name}' is archived`);
      return {
        lineNo: i + 1,
        product,
        qtyMilli: item.qtyMilli,
        unitCostPaisa: asPaisa(item.unitCostPaisa),
        lineTotalPaisa: costOfQty(item.unitCostPaisa, item.qtyMilli),
      };
    });

    const subtotal = sumPaisa(lines.map((l) => l.lineTotalPaisa));
    const discount = asPaisa(parsed.discountPaisa);
    if (discount > subtotal) throw new BadRequestError('Discount exceeds subtotal');
    const total = subtractPaisa(subtotal, discount);
    const paid = asPaisa(parsed.paidPaisa);
    if (paid > total) throw new BadRequestError('Paid amount exceeds total');
    const due = subtractPaisa(total, paid);
    const paidAccount =
      parsed.paidMethod === 'bank' ? SYSTEM_ACCOUNTS.BANK : SYSTEM_ACCOUNTS.CASH;

    return this.deps.sqlite.transaction(() => {
      const docNo = parsed.docNo ?? nextDocNo(this.deps.sqlite, 'purchases', install.branchCode, 'PUR');
      const id = newUlid();
      const movedAt = nowIso();

      const entry = this.deps.ledger.postEntry({
        entryDate: parsed.docDate,
        narration: `Purchase ${docNo} — ${party.name}`,
        refType: 'purchase',
        refId: id,
        createdBy: actorId,
        lines: [
          { accountId: SYSTEM_ACCOUNTS.INVENTORY, debitPaisa: subtotal },
          ...(discount > 0
            ? [{ accountId: SYSTEM_ACCOUNTS.OTHER_INCOME, creditPaisa: discount, lineNote: 'Discount received' }]
            : []),
          ...(paid > 0 ? [{ accountId: paidAccount, creditPaisa: paid }] : []),
          ...(due > 0
            ? [{ accountId: SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, partyId: party.id, creditPaisa: due }]
            : []),
        ],
      });

      this.deps.db
        .insert(purchases)
        .values({
          id,
          branchCode: install.branchCode,
          changeSeq: nextChangeSeq(this.deps.sqlite),
          partyId: party.id,
          docNo,
          docDate: parsed.docDate,
          subtotalPaisa: subtotal,
          discountPaisa: discount,
          totalPaisa: total,
          paidPaisa: paid,
          journalEntryId: entry.id,
          note: parsed.note ?? null,
          createdBy: actorId,
        })
        .run();

      for (const line of lines) {
        this.deps.db
          .insert(purchaseItems)
          .values({
            id: newUlid(),
            purchaseId: id,
            lineNo: line.lineNo,
            productId: line.product.id,
            qtyMilli: line.qtyMilli,
            unitCostPaisa: line.unitCostPaisa,
            lineTotalPaisa: line.lineTotalPaisa,
          })
          .run();
        this.deps.db
          .insert(stockMoves)
          .values({
            id: newUlid(),
            branchCode: install.branchCode,
            changeSeq: nextChangeSeq(this.deps.sqlite),
            productId: line.product.id,
            moveType: 'in',
            qtyMilli: line.qtyMilli, // positive: into stock
            unitCostPaisa: line.unitCostPaisa,
            refType: 'purchase',
            refId: id,
            movedAt,
            createdBy: actorId,
          })
          .run();
      }

      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'purchase.create',
        tableName: 'purchases',
        recordId: id,
        detail: { docNo, party: party.name, totalPaisa: total },
      });
      return this.get(id);
    })();
  }

  /** Goods return / correction: reverse the journal, restock-out the items, flag the doc. */
  reverse(id: string, opts: ReverseDocOptions, actorId: string | null): PurchaseWithItems {
    const install = requireInstall(this.deps);
    return this.deps.sqlite.transaction(() => {
      const { purchase, items } = this.get(id);
      assertCanEdit(install, purchase.branchCode, `Purchase ${purchase.docNo}`);
      if (purchase.status === 'reversed') throw new ConflictError('Purchase is already reversed');
      if (!purchase.journalEntryId) throw new ConflictError('Purchase has no journal entry');

      const date = opts.date ?? nowIso().slice(0, 10);
      this.deps.ledger.reverseEntry(purchase.journalEntryId, {
        entryDate: date,
        narration: `Goods return — ${purchase.docNo}${opts.reason ? ` (${opts.reason})` : ''}`,
        refType: 'return',
        createdBy: actorId,
      });

      const movedAt = nowIso();
      for (const item of items) {
        this.deps.db
          .insert(stockMoves)
          .values({
            id: newUlid(),
            branchCode: install.branchCode,
            changeSeq: nextChangeSeq(this.deps.sqlite),
            productId: item.productId,
            moveType: 'return',
            qtyMilli: -item.qtyMilli, // back out of stock
            unitCostPaisa: item.unitCostPaisa,
            refType: 'purchase_return',
            refId: id,
            movedAt,
            createdBy: actorId,
          })
          .run();
      }

      this.deps.db
        .update(purchases)
        .set({
          status: 'reversed',
          changeSeq: nextChangeSeq(this.deps.sqlite),
          updatedAt: nowIso(),
        })
        .where(eq(purchases.id, id))
        .run();

      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'purchase.reverse',
        tableName: 'purchases',
        recordId: id,
        detail: { reason: opts.reason ?? null },
      });
      return this.get(id);
    })();
  }
}
