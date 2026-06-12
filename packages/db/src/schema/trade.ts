import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { syncColumns } from './columns';
import { accounts } from './accounting';

/**
 * Quantities are stored as INTEGER milli-units (qty × 1000, 3 decimal
 * places) for the same reason money is integer paisa: pcs/sqft/kg
 * quantities must round-trip exactly and valuations (qty × unit cost) are
 * computed through decimal.js, never float.
 */

export const PARTY_KINDS = ['customer', 'supplier', 'both'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

/** Customers/suppliers. branch_code = owner branch, or 'SHARED' (hub-mastered). */
export const parties = sqliteTable(
  'parties',
  {
    ...syncColumns,
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: PARTY_KINDS }).notNull(),
    phone: text('phone'),
    address: text('address'),
    openingBalancePaisa: integer('opening_balance_paisa').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    uniqueIndex('parties_branch_code_uq').on(t.branchCode, t.code),
    index('parties_kind_idx').on(t.kind),
    index('parties_branch_seq_idx').on(t.branchCode, t.changeSeq),
  ],
);

export const PRODUCT_UNITS = ['pcs', 'sqft', 'kg'] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

/**
 * Shared product list, mastered at the hub: master products have
 * branch_code='SHARED'; a provisional product carries the creating branch's
 * code (no collision) until the hub merges it and sets master_id on it.
 */
export const products = sqliteTable(
  'products',
  {
    ...syncColumns,
    sku: text('sku'),
    name: text('name').notNull(),
    unit: text('unit', { enum: PRODUCT_UNITS }).notNull(),
    category: text('category'),
    reorderLevelMilli: integer('reorder_level_milli').notNull().default(0),
    isProvisional: integer('is_provisional', { mode: 'boolean' }).notNull().default(false),
    provisionalOriginBranch: text('provisional_origin_branch'),
    masterId: text('master_id'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    index('products_name_idx').on(t.name),
    index('products_master_idx').on(t.masterId),
    index('products_branch_seq_idx').on(t.branchCode, t.changeSeq),
  ],
);

export const STOCK_MOVE_TYPES = ['in', 'out', 'adjust', 'return'] as const;
export type StockMoveType = (typeof STOCK_MOVE_TYPES)[number];

/**
 * Stock ledger per branch. qty_milli is a SIGNED delta: purchases/returns-in
 * positive, sales/returns-out negative, adjustments either sign — so stock
 * on hand is simply SUM(qty_milli) per (branch, product).
 */
export const stockMoves = sqliteTable(
  'stock_moves',
  {
    ...syncColumns,
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    moveType: text('move_type', { enum: STOCK_MOVE_TYPES }).notNull(),
    qtyMilli: integer('qty_milli').notNull(),
    unitCostPaisa: integer('unit_cost_paisa').notNull().default(0),
    refType: text('ref_type'),
    refId: text('ref_id'),
    movedAt: text('moved_at').notNull(),
  },
  (t) => [
    index('sm_branch_product_idx').on(t.branchCode, t.productId),
    index('sm_branch_seq_idx').on(t.branchCode, t.changeSeq),
    index('sm_ref_idx').on(t.refType, t.refId),
  ],
);

export const DOC_STATUSES = ['posted', 'reversed'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const purchases = sqliteTable(
  'purchases',
  {
    ...syncColumns,
    partyId: text('party_id').notNull(),
    docNo: text('doc_no').notNull(),
    docDate: text('doc_date').notNull(), // YYYY-MM-DD
    subtotalPaisa: integer('subtotal_paisa').notNull().default(0),
    discountPaisa: integer('discount_paisa').notNull().default(0),
    totalPaisa: integer('total_paisa').notNull().default(0),
    paidPaisa: integer('paid_paisa').notNull().default(0),
    journalEntryId: text('journal_entry_id'),
    status: text('status', { enum: DOC_STATUSES }).notNull().default('posted'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('purchases_branch_docno_uq').on(t.branchCode, t.docNo),
    index('purchases_branch_date_idx').on(t.branchCode, t.docDate),
    index('purchases_party_idx').on(t.partyId),
    index('purchases_branch_seq_idx').on(t.branchCode, t.changeSeq),
  ],
);

export const purchaseItems = sqliteTable(
  'purchase_items',
  {
    id: text('id').primaryKey(),
    purchaseId: text('purchase_id')
      .notNull()
      .references(() => purchases.id),
    lineNo: integer('line_no').notNull(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    qtyMilli: integer('qty_milli').notNull(),
    unitCostPaisa: integer('unit_cost_paisa').notNull(),
    lineTotalPaisa: integer('line_total_paisa').notNull(),
  },
  (t) => [index('pi_purchase_idx').on(t.purchaseId), index('pi_product_idx').on(t.productId)],
);

export const sales = sqliteTable(
  'sales',
  {
    ...syncColumns,
    partyId: text('party_id'), // nullable: cash sale to walk-in customer
    docNo: text('doc_no').notNull(),
    docDate: text('doc_date').notNull(),
    subtotalPaisa: integer('subtotal_paisa').notNull().default(0),
    discountPaisa: integer('discount_paisa').notNull().default(0),
    totalPaisa: integer('total_paisa').notNull().default(0),
    paidPaisa: integer('paid_paisa').notNull().default(0),
    journalEntryId: text('journal_entry_id'),
    status: text('status', { enum: DOC_STATUSES }).notNull().default('posted'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('sales_branch_docno_uq').on(t.branchCode, t.docNo),
    index('sales_branch_date_idx').on(t.branchCode, t.docDate),
    index('sales_party_idx').on(t.partyId),
    index('sales_branch_seq_idx').on(t.branchCode, t.changeSeq),
  ],
);

export const saleItems = sqliteTable(
  'sale_items',
  {
    id: text('id').primaryKey(),
    saleId: text('sale_id')
      .notNull()
      .references(() => sales.id),
    lineNo: integer('line_no').notNull(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    qtyMilli: integer('qty_milli').notNull(),
    unitPricePaisa: integer('unit_price_paisa').notNull(),
    /** Unit cost captured at sale time — drives the COGS posting. */
    unitCostPaisa: integer('unit_cost_paisa').notNull(),
    lineTotalPaisa: integer('line_total_paisa').notNull(),
  },
  (t) => [index('si_sale_idx').on(t.saleId), index('si_product_idx').on(t.productId)],
);

export const PAYMENT_DIRECTIONS = ['in', 'out'] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];
export const PAYMENT_METHODS = ['cash', 'bank'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Money in from customers (receipt) / out to suppliers (payment). */
export const payments = sqliteTable(
  'payments',
  {
    ...syncColumns,
    partyId: text('party_id').notNull(),
    direction: text('direction', { enum: PAYMENT_DIRECTIONS }).notNull(),
    amountPaisa: integer('amount_paisa').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    refNo: text('ref_no'),
    paidDate: text('paid_date').notNull(), // YYYY-MM-DD
    journalEntryId: text('journal_entry_id'),
    note: text('note'),
  },
  (t) => [
    index('payments_branch_date_idx').on(t.branchCode, t.paidDate),
    index('payments_party_idx').on(t.partyId),
    index('payments_branch_seq_idx').on(t.branchCode, t.changeSeq),
  ],
);

export const expenses = sqliteTable(
  'expenses',
  {
    ...syncColumns,
    expenseAccountId: text('expense_account_id')
      .notNull()
      .references(() => accounts.id),
    paidFromAccountId: text('paid_from_account_id').references(() => accounts.id),
    amountPaisa: integer('amount_paisa').notNull(),
    note: text('note'),
    spentDate: text('spent_date').notNull(), // YYYY-MM-DD
    journalEntryId: text('journal_entry_id'),
  },
  (t) => [
    index('expenses_branch_date_idx').on(t.branchCode, t.spentDate),
    index('expenses_branch_seq_idx').on(t.branchCode, t.changeSeq),
  ],
);

/** Per-day cash snapshot per branch (the old "balance forward"). */
export const dailyClosing = sqliteTable(
  'daily_closing',
  {
    ...syncColumns,
    closeDate: text('close_date').notNull(), // YYYY-MM-DD
    openingCashPaisa: integer('opening_cash_paisa').notNull().default(0),
    closingCashPaisa: integer('closing_cash_paisa').notNull().default(0),
    closedBy: text('closed_by'),
    closedAt: text('closed_at'),
  },
  (t) => [uniqueIndex('daily_closing_branch_date_uq').on(t.branchCode, t.closeDate)],
);
