import { and, eq, like, or, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { asPaisa, newUlid } from '@leather-erp/core';
import { products, PRODUCT_UNITS, SHARED_BRANCH, stockMoves } from '@leather-erp/db';
import { NotFoundError } from '../errors';
import { writeAudit } from './audit';
import { nextChangeSeq, nowIso } from './change-seq';
import { requireInstall, type ServiceDeps } from './deps';
import { assertCanEdit } from './ownership';

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sku: z.string().trim().max(40).nullish(),
  unit: z.enum(PRODUCT_UNITS),
  category: z.string().trim().max(60).nullish(),
  reorderLevelMilli: z.number().int().nonnegative().default(0),
});

export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    sku: z.string().trim().max(40).nullable(),
    category: z.string().trim().max(60).nullable(),
    reorderLevelMilli: z.number().int().nonnegative(),
    isActive: z.boolean(),
  })
  .partial();

export type Product = typeof products.$inferSelect;

export interface StockInfo {
  productId: string;
  qtyOnHandMilli: number;
  avgCostPaisa: number;
  valuePaisa: number;
}

export class ProductService {
  constructor(private readonly deps: ServiceDeps) {}

  list(filter: { q?: string | undefined; includeInactive?: boolean | undefined } = {}): Product[] {
    const where = [eq(products.isDeleted, false)];
    if (!filter.includeInactive) where.push(eq(products.isActive, true));
    if (filter.q) {
      const q = `%${filter.q}%`;
      where.push(or(like(products.name, q), like(products.sku, q), like(products.category, q))!);
    }
    return this.deps.db
      .select()
      .from(products)
      .where(and(...where))
      .orderBy(products.name)
      .limit(500)
      .all();
  }

  get(id: string): Product {
    const row = this.deps.db.select().from(products).where(eq(products.id, id)).get();
    if (!row || row.isDeleted) throw new NotFoundError('Product not found');
    return row;
  }

  /**
   * Hub installs create MASTER products (owner SHARED). Non-hub installs
   * create PROVISIONAL products owned by their branch — usable immediately,
   * merged into the master list by the hub later (Phase 5).
   */
  create(input: z.input<typeof createProductSchema>, actorId: string | null): Product {
    const parsed = createProductSchema.parse(input);
    const install = requireInstall(this.deps);
    const isProvisional = !install.isHub;

    return this.deps.sqlite.transaction(() => {
      const id = newUlid();
      this.deps.db
        .insert(products)
        .values({
          id,
          branchCode: isProvisional ? install.branchCode : SHARED_BRANCH,
          changeSeq: nextChangeSeq(this.deps.sqlite),
          name: parsed.name,
          sku: parsed.sku ?? null,
          unit: parsed.unit,
          category: parsed.category ?? null,
          reorderLevelMilli: parsed.reorderLevelMilli,
          isProvisional,
          provisionalOriginBranch: isProvisional ? install.branchCode : null,
          createdBy: actorId,
        })
        .run();
      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'product.create',
        tableName: 'products',
        recordId: id,
        detail: { name: parsed.name, provisional: isProvisional },
      });
      return this.get(id);
    })();
  }

  update(id: string, input: z.input<typeof updateProductSchema>, actorId: string | null): Product {
    const patch = updateProductSchema.parse(input);
    const install = requireInstall(this.deps);
    return this.deps.sqlite.transaction(() => {
      const row = this.get(id);
      assertCanEdit(install, row.branchCode, `Product '${row.name}'`);
      this.deps.db
        .update(products)
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.sku !== undefined && { sku: patch.sku }),
          ...(patch.category !== undefined && { category: patch.category }),
          ...(patch.reorderLevelMilli !== undefined && {
            reorderLevelMilli: patch.reorderLevelMilli,
          }),
          ...(patch.isActive !== undefined && { isActive: patch.isActive }),
          changeSeq: nextChangeSeq(this.deps.sqlite),
          updatedAt: nowIso(),
        })
        .where(eq(products.id, id))
        .run();
      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'product.update',
        tableName: 'products',
        recordId: id,
        detail: patch,
      });
      return this.get(id);
    })();
  }

  softDelete(id: string, actorId: string | null): void {
    const install = requireInstall(this.deps);
    this.deps.sqlite.transaction(() => {
      const row = this.get(id);
      assertCanEdit(install, row.branchCode, `Product '${row.name}'`);
      this.deps.db
        .update(products)
        .set({
          isDeleted: true,
          isActive: false,
          changeSeq: nextChangeSeq(this.deps.sqlite),
          updatedAt: nowIso(),
        })
        .where(eq(products.id, id))
        .run();
      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'product.delete',
        tableName: 'products',
        recordId: id,
      });
    })();
  }

  /** Stock on hand for one product in one branch: SUM of signed move deltas. */
  qtyOnHandMilli(branchCode: string, productId: string): number {
    const row = this.deps.db
      .select({ qty: sql<number>`COALESCE(SUM(${stockMoves.qtyMilli}), 0)` })
      .from(stockMoves)
      .where(and(eq(stockMoves.branchCode, branchCode), eq(stockMoves.productId, productId)))
      .get();
    return row?.qty ?? 0;
  }

  /**
   * Weighted-average unit cost from all INFLOW moves (purchases, returns-in,
   * positive adjustments) for this branch+product. Sales post COGS at this
   * cost. Returns 0 when there are no inflows yet.
   */
  avgCostPaisa(branchCode: string, productId: string): number {
    const row = this.deps.sqlite
      .prepare(
        `SELECT COALESCE(SUM(qty_milli), 0) AS qty,
                COALESCE(SUM(qty_milli * unit_cost_paisa), 0) AS value_milli_paisa
         FROM stock_moves
         WHERE branch_code = ? AND product_id = ? AND qty_milli > 0`,
      )
      .get(branchCode, productId) as { qty: number; value_milli_paisa: number };
    if (row.qty <= 0) return 0;
    // (Σ qty×cost) / Σ qty = paisa per unit — decimal.js division, half-up
    return asPaisa(
      new Decimal(row.value_milli_paisa).dividedBy(row.qty).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber(),
    );
  }
}
