import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { asPaisa, costOfQty, newUlid } from '@leather-erp/core';
import { products, stockMoves, SYSTEM_ACCOUNTS } from '@leather-erp/db';
import { BadRequestError, NotFoundError } from '../errors';
import { writeAudit } from './audit';
import { nextChangeSeq, nowIso } from './change-seq';
import { requireInstall, type ServiceDeps } from './deps';
import type { ProductService } from './product.service';

export const adjustStockSchema = z.object({
  productId: z.string().min(1),
  /** The physically counted quantity; the system posts the difference vs current on-hand. */
  countedQtyMilli: z.number().int().nonnegative(),
  /** Unit cost for an INCREASE; defaults to the branch weighted-average (or required if none). */
  unitCostPaisa: z.number().int().nonnegative().optional(),
  note: z.string().trim().max(300).nullish(),
});
export type AdjustStockInput = z.input<typeof adjustStockSchema>;

export interface StockRow {
  productId: string;
  name: string;
  sku: string | null;
  unit: string;
  category: string | null;
  branchCode: string;
  isProvisional: boolean;
  qtyOnHandMilli: number;
  avgCostPaisa: number;
  valuePaisa: number;
  reorderLevelMilli: number;
  isLow: boolean;
}

export interface StockListResult {
  branch: string;
  rows: StockRow[];
  totalValuePaisa: number;
  lowStockCount: number;
}

export class InventoryService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly productService: ProductService,
  ) {}

  /**
   * Stock on hand + valuation for a branch (or 'ALL' = summed across branches).
   * Valuation uses weighted-average cost of inflows, computed via decimal.js.
   */
  listStock(branchScope?: string | undefined): StockListResult {
    const install = requireInstall(this.deps);
    const scope = (branchScope ?? install.branchCode).toUpperCase();
    const branch = scope === 'ALL' ? null : scope;
    const filter = branch ? 'AND m.branch_code = @branch' : '';
    const params = branch ? { branch } : {};

    const rows = this.deps.sqlite
      .prepare(
        `SELECT p.id AS productId, p.name, p.sku, p.unit, p.category, p.branch_code AS branchCode,
                p.is_provisional AS isProvisional, p.reorder_level_milli AS reorderLevelMilli,
                COALESCE(SUM(m.qty_milli), 0) AS qtyOnHandMilli,
                COALESCE(SUM(CASE WHEN m.qty_milli > 0 THEN m.qty_milli ELSE 0 END), 0) AS inQtyMilli,
                COALESCE(SUM(CASE WHEN m.qty_milli > 0 THEN m.qty_milli * m.unit_cost_paisa ELSE 0 END), 0) AS inValueMilliPaisa
         FROM products p
         LEFT JOIN stock_moves m ON m.product_id = p.id ${filter}
         WHERE p.is_deleted = 0 AND p.is_active = 1
         GROUP BY p.id ORDER BY p.name`,
      )
      .all(params) as Array<{
      productId: string;
      name: string;
      sku: string | null;
      unit: string;
      category: string | null;
      branchCode: string;
      isProvisional: number;
      reorderLevelMilli: number;
      qtyOnHandMilli: number;
      inQtyMilli: number;
      inValueMilliPaisa: number;
    }>;

    let totalValuePaisa = 0;
    let lowStockCount = 0;
    const out: StockRow[] = rows.map((r) => {
      const avgCostPaisa =
        r.inQtyMilli > 0
          ? asPaisa(
              new Decimal(r.inValueMilliPaisa)
                .dividedBy(r.inQtyMilli)
                .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
                .toNumber(),
            )
          : 0;
      const valuePaisa = r.qtyOnHandMilli > 0 ? costOfQty(avgCostPaisa, r.qtyOnHandMilli) : 0;
      totalValuePaisa += valuePaisa;
      const isLow = r.reorderLevelMilli > 0 && r.qtyOnHandMilli <= r.reorderLevelMilli;
      if (isLow) lowStockCount += 1;
      return {
        productId: r.productId,
        name: r.name,
        sku: r.sku,
        unit: r.unit,
        category: r.category,
        branchCode: r.branchCode,
        isProvisional: r.isProvisional === 1,
        qtyOnHandMilli: r.qtyOnHandMilli,
        avgCostPaisa,
        valuePaisa,
        reorderLevelMilli: r.reorderLevelMilli,
        isLow,
      };
    });

    return { branch: branch ?? 'ALL', rows: out, totalValuePaisa, lowStockCount };
  }

  /**
   * Manual stock adjustment (stock-take correction). Posts a stock_move of
   * the difference AND a balanced journal entry so the Inventory GL stays
   * reconciled with physical stock:
   *   increase: Dr Inventory / Cr Inventory Adjustment (found stock / gain)
   *   decrease: Dr Inventory Adjustment / Cr Inventory (loss / shrinkage)
   * Adjusts only this branch's own stock.
   */
  adjustStock(input: AdjustStockInput, actorId: string | null): { moveId: string; deltaMilli: number } {
    const parsed = adjustStockSchema.parse(input);
    const install = requireInstall(this.deps);
    const product = this.productService.get(parsed.productId);

    const current = this.productService.qtyOnHandMilli(install.branchCode, parsed.productId);
    const deltaMilli = parsed.countedQtyMilli - current;
    if (deltaMilli === 0) {
      throw new BadRequestError('Counted quantity equals current stock — nothing to adjust');
    }

    const avgCost = this.productService.avgCostPaisa(install.branchCode, parsed.productId);
    const unitCost = asPaisa(deltaMilli > 0 ? (parsed.unitCostPaisa ?? avgCost) : avgCost);
    if (deltaMilli > 0 && unitCost === 0) {
      throw new BadRequestError(
        'No known cost for this product — provide a unit cost for the increase',
      );
    }
    const valuePaisa = costOfQty(unitCost, Math.abs(deltaMilli));
    if (valuePaisa === 0) {
      throw new BadRequestError('Adjustment value is zero (cost unknown)');
    }

    return this.deps.sqlite.transaction(() => {
      const moveId = newUlid();
      this.deps.ledger.postEntry({
        entryDate: nowIso().slice(0, 10),
        narration: `Stock adjustment — ${product.name}${parsed.note ? ` (${parsed.note})` : ''}`,
        refType: 'adjustment',
        refId: moveId,
        createdBy: actorId,
        lines:
          deltaMilli > 0
            ? [
                { accountId: SYSTEM_ACCOUNTS.INVENTORY, debitPaisa: valuePaisa },
                { accountId: SYSTEM_ACCOUNTS.INVENTORY_ADJUSTMENT, creditPaisa: valuePaisa },
              ]
            : [
                { accountId: SYSTEM_ACCOUNTS.INVENTORY_ADJUSTMENT, debitPaisa: valuePaisa },
                { accountId: SYSTEM_ACCOUNTS.INVENTORY, creditPaisa: valuePaisa },
              ],
      });

      this.deps.db
        .insert(stockMoves)
        .values({
          id: moveId,
          branchCode: install.branchCode,
          changeSeq: nextChangeSeq(this.deps.sqlite),
          productId: parsed.productId,
          moveType: 'adjust',
          qtyMilli: deltaMilli,
          unitCostPaisa: unitCost,
          refType: 'adjustment',
          refId: moveId,
          movedAt: nowIso(),
          createdBy: actorId,
        })
        .run();

      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'inventory.adjust',
        tableName: 'stock_moves',
        recordId: moveId,
        detail: { product: product.name, deltaMilli, valuePaisa },
      });
      return { moveId, deltaMilli };
    })();
  }

  /** Per-branch stock ledger for one product (audit trail of every move). */
  movesForProduct(branchCode: string, productId: string) {
    const product = this.deps.db.select().from(products).where(eq(products.id, productId)).get();
    if (!product) throw new NotFoundError('Product not found');
    return this.deps.db
      .select()
      .from(stockMoves)
      .where(eq(stockMoves.productId, productId))
      .all()
      .filter((m) => m.branchCode === branchCode)
      .sort((a, b) => a.movedAt.localeCompare(b.movedAt));
  }
}
