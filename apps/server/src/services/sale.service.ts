import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import {
  asPaisa,
  costOfQty,
  formatQty,
  newUlid,
  subtractPaisa,
  sumPaisa,
} from '@leather-erp/core';
import {
  PAYMENT_METHODS,
  saleItems,
  sales,
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
import type { DocListFilter, ReverseDocOptions } from './purchase.service';

export const createSaleSchema = z.object({
  /** Optional: omit for a walk-in cash sale (then paid must equal total). */
  partyId: z.string().min(1).nullish(),
  docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  docNo: z.string().trim().min(1).max(30).optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        qtyMilli: z.number().int().positive(),
        unitPricePaisa: z.number().int().nonnegative(),
        /** Override COGS unit cost; defaults to the branch weighted-average cost. */
        unitCostPaisa: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1),
  discountPaisa: z.number().int().nonnegative().default(0),
  paidPaisa: z.number().int().nonnegative().default(0),
  paidMethod: z.enum(PAYMENT_METHODS).default('cash'),
  note: z.string().trim().max(300).nullish(),
});
export type CreateSaleInput = z.input<typeof createSaleSchema>;

export type Sale = typeof sales.$inferSelect;
export type SaleItem = typeof saleItems.$inferSelect;

export interface SaleWithItems {
  sale: Sale;
  items: SaleItem[];
}

export class SaleService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly parties: PartyService,
    private readonly products: ProductService,
  ) {}

  list(filter: DocListFilter = {}): Sale[] {
    const where = [];
    if (filter.from) where.push(gte(sales.docDate, filter.from));
    if (filter.to) where.push(lte(sales.docDate, filter.to));
    if (filter.partyId) where.push(eq(sales.partyId, filter.partyId));
    if (filter.branchCode) where.push(eq(sales.branchCode, filter.branchCode));
    return this.deps.db
      .select()
      .from(sales)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(sales.docDate), desc(sales.docNo))
      .limit(500)
      .all();
  }

  get(id: string): SaleWithItems {
    const sale = this.deps.db.select().from(sales).where(eq(sales.id, id)).get();
    if (!sale) throw new NotFoundError('Sale not found');
    const items = this.deps.db
      .select()
      .from(saleItems)
      .where(eq(saleItems.saleId, id))
      .orderBy(saleItems.lineNo)
      .all();
    return { sale, items };
  }

  /**
   * Sale, atomically: document + items + stock OUT moves + ONE balanced entry:
   *   Dr Cash/Bank (paid now)  + Dr Accounts Receivable→party (the rest)
   *   Cr Sales Revenue (total, net of discount)
   *   Dr COGS / Cr Inventory (Σ qty × unit cost)   ← the perpetual-inventory leg
   * Stock is checked: selling more than on hand is rejected.
   */
  create(input: CreateSaleInput, actorId: string | null): SaleWithItems {
    const parsed = createSaleSchema.parse(input);
    const install = requireInstall(this.deps);

    const party = parsed.partyId ? this.parties.get(parsed.partyId) : null;
    if (party && party.kind === 'supplier') {
      throw new BadRequestError(`'${party.name}' is a supplier, not a customer`);
    }

    // Aggregate requested qty per product, then check stock once per product.
    const requested = new Map<string, number>();
    for (const item of parsed.items) {
      requested.set(item.productId, (requested.get(item.productId) ?? 0) + item.qtyMilli);
    }
    for (const [productId, qty] of requested) {
      const product = this.products.get(productId);
      if (!product.isActive) throw new BadRequestError(`Product '${product.name}' is archived`);
      const onHand = this.products.qtyOnHandMilli(install.branchCode, productId);
      if (onHand < qty) {
        throw new BadRequestError(
          `Insufficient stock for '${product.name}': on hand ${formatQty(onHand)}, requested ${formatQty(qty)}`,
        );
      }
    }

    const lines = parsed.items.map((item, i) => {
      const unitCost = asPaisa(
        item.unitCostPaisa ?? this.products.avgCostPaisa(install.branchCode, item.productId),
      );
      return {
        lineNo: i + 1,
        productId: item.productId,
        qtyMilli: item.qtyMilli,
        unitPricePaisa: asPaisa(item.unitPricePaisa),
        unitCostPaisa: unitCost,
        lineTotalPaisa: costOfQty(item.unitPricePaisa, item.qtyMilli),
        lineCostPaisa: costOfQty(unitCost, item.qtyMilli),
      };
    });

    const subtotal = sumPaisa(lines.map((l) => l.lineTotalPaisa));
    const discount = asPaisa(parsed.discountPaisa);
    if (discount > subtotal) throw new BadRequestError('Discount exceeds subtotal');
    const total = subtractPaisa(subtotal, discount);
    const paid = asPaisa(parsed.paidPaisa);
    if (paid > total) throw new BadRequestError('Paid amount exceeds total');
    const due = subtractPaisa(total, paid);
    if (!party && due > 0) {
      throw new BadRequestError('Walk-in sales (no customer) must be fully paid');
    }
    const totalCogs = sumPaisa(lines.map((l) => l.lineCostPaisa));
    const paidAccount =
      parsed.paidMethod === 'bank' ? SYSTEM_ACCOUNTS.BANK : SYSTEM_ACCOUNTS.CASH;

    return this.deps.sqlite.transaction(() => {
      const docNo = parsed.docNo ?? nextDocNo(this.deps.sqlite, 'sales', install.branchCode, 'SAL');
      const id = newUlid();
      const movedAt = nowIso();

      const entry = this.deps.ledger.postEntry({
        entryDate: parsed.docDate,
        narration: `Sale ${docNo}${party ? ` — ${party.name}` : ' — walk-in'}`,
        refType: 'sale',
        refId: id,
        createdBy: actorId,
        lines: [
          ...(paid > 0 ? [{ accountId: paidAccount, debitPaisa: paid }] : []),
          ...(due > 0 && party
            ? [{ accountId: SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, partyId: party.id, debitPaisa: due }]
            : []),
          { accountId: SYSTEM_ACCOUNTS.SALES_REVENUE, creditPaisa: total },
          ...(totalCogs > 0
            ? [
                { accountId: SYSTEM_ACCOUNTS.COGS, debitPaisa: totalCogs },
                { accountId: SYSTEM_ACCOUNTS.INVENTORY, creditPaisa: totalCogs },
              ]
            : []),
        ],
      });

      this.deps.db
        .insert(sales)
        .values({
          id,
          branchCode: install.branchCode,
          changeSeq: nextChangeSeq(this.deps.sqlite),
          partyId: party?.id ?? null,
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
          .insert(saleItems)
          .values({
            id: newUlid(),
            saleId: id,
            lineNo: line.lineNo,
            productId: line.productId,
            qtyMilli: line.qtyMilli,
            unitPricePaisa: line.unitPricePaisa,
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
            productId: line.productId,
            moveType: 'out',
            qtyMilli: -line.qtyMilli, // negative: out of stock
            unitCostPaisa: line.unitCostPaisa,
            refType: 'sale',
            refId: id,
            movedAt,
            createdBy: actorId,
          })
          .run();
      }

      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'sale.create',
        tableName: 'sales',
        recordId: id,
        detail: { docNo, party: party?.name ?? 'walk-in', totalPaisa: total },
      });
      return this.get(id);
    })();
  }

  /** Goods return from customer: reverse the journal, restock the items, flag the doc. */
  reverse(id: string, opts: ReverseDocOptions, actorId: string | null): SaleWithItems {
    const install = requireInstall(this.deps);
    return this.deps.sqlite.transaction(() => {
      const { sale, items } = this.get(id);
      assertCanEdit(install, sale.branchCode, `Sale ${sale.docNo}`);
      if (sale.status === 'reversed') throw new ConflictError('Sale is already reversed');
      if (!sale.journalEntryId) throw new ConflictError('Sale has no journal entry');

      const date = opts.date ?? nowIso().slice(0, 10);
      this.deps.ledger.reverseEntry(sale.journalEntryId, {
        entryDate: date,
        narration: `Goods return — ${sale.docNo}${opts.reason ? ` (${opts.reason})` : ''}`,
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
            qtyMilli: item.qtyMilli, // positive: back into stock
            unitCostPaisa: item.unitCostPaisa,
            refType: 'sale_return',
            refId: id,
            movedAt,
            createdBy: actorId,
          })
          .run();
      }

      this.deps.db
        .update(sales)
        .set({
          status: 'reversed',
          changeSeq: nextChangeSeq(this.deps.sqlite),
          updatedAt: nowIso(),
        })
        .where(eq(sales.id, id))
        .run();

      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'sale.reverse',
        tableName: 'sales',
        recordId: id,
        detail: { reason: opts.reason ?? null },
      });
      return this.get(id);
    })();
  }
}
