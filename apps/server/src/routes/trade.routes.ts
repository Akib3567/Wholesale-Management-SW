import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { accounts } from '@leather-erp/db';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../server';
import { createPartySchema, updatePartySchema } from '../services/party.service';
import { createProductSchema, updateProductSchema } from '../services/product.service';
import { createPurchaseSchema } from '../services/purchase.service';
import { createSaleSchema } from '../services/sale.service';
import { createPaymentSchema } from '../services/payment.service';
import { createExpenseSchema } from '../services/expense.service';

const idParam = z.object({ id: z.string().min(1) });
const dateRange = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  partyId: z.string().optional(),
  branchCode: z.string().optional(),
});
const reverseBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().trim().max(200).optional(),
});

function actor(req: FastifyRequest): string | null {
  return req.user?.id ?? null;
}

export function registerTradeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const read = { preHandler: app.requireAuth('viewer') };
  const write = { preHandler: app.requireAuth('operator') };
  const manage = { preHandler: app.requireAuth('manager') };

  // ---- accounts (read-only reference) ----
  app.get('/api/accounts', read, async () => ({
    accounts: ctx.db.select().from(accounts).where(eq(accounts.isActive, true)).all(),
  }));

  // ---- parties ----
  app.get('/api/parties', read, async (req) => {
    const q = z
      .object({
        kind: z.enum(['customer', 'supplier', 'both']).optional(),
        q: z.string().optional(),
        includeInactive: z.coerce.boolean().optional(),
        withBalances: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const list = ctx.parties.list(q);
    if (q.withBalances) {
      const balances = ctx.parties.balancesByParty();
      return { parties: list.map((p) => ({ ...p, balancePaisa: balances.get(p.id) ?? 0 })) };
    }
    return { parties: list };
  });
  app.get('/api/parties/:id', read, async (req) => ({
    party: ctx.parties.get(idParam.parse(req.params).id),
  }));
  app.post('/api/parties', write, async (req, reply) => {
    const party = ctx.parties.create(createPartySchema.parse(req.body), actor(req));
    reply.code(201);
    return { party };
  });
  app.patch('/api/parties/:id', write, async (req) => ({
    party: ctx.parties.update(
      idParam.parse(req.params).id,
      updatePartySchema.parse(req.body),
      actor(req),
    ),
  }));
  app.delete('/api/parties/:id', manage, async (req) => {
    ctx.parties.softDelete(idParam.parse(req.params).id, actor(req));
    return { ok: true };
  });

  // ---- products ----
  app.get('/api/products', read, async (req) => {
    const q = z
      .object({ q: z.string().optional(), includeInactive: z.coerce.boolean().optional() })
      .parse(req.query);
    return { products: ctx.products.list(q) };
  });
  app.get('/api/products/:id', read, async (req) => {
    const { id } = idParam.parse(req.params);
    const product = ctx.products.get(id);
    const install = ctx.install.getInstall();
    const branchCode = install?.branchCode ?? '';
    return {
      product,
      stock: branchCode
        ? {
            qtyOnHandMilli: ctx.products.qtyOnHandMilli(branchCode, id),
            avgCostPaisa: ctx.products.avgCostPaisa(branchCode, id),
          }
        : null,
    };
  });
  app.post('/api/products', write, async (req, reply) => {
    const product = ctx.products.create(createProductSchema.parse(req.body), actor(req));
    reply.code(201);
    return { product };
  });
  app.patch('/api/products/:id', write, async (req) => ({
    product: ctx.products.update(
      idParam.parse(req.params).id,
      updateProductSchema.parse(req.body),
      actor(req),
    ),
  }));
  app.delete('/api/products/:id', manage, async (req) => {
    ctx.products.softDelete(idParam.parse(req.params).id, actor(req));
    return { ok: true };
  });

  // ---- purchases ----
  app.get('/api/purchases', read, async (req) => ({
    purchases: ctx.purchases.list(dateRange.parse(req.query)),
  }));
  app.get('/api/purchases/:id', read, async (req) =>
    ctx.purchases.get(idParam.parse(req.params).id),
  );
  app.post('/api/purchases', write, async (req, reply) => {
    const result = ctx.purchases.create(createPurchaseSchema.parse(req.body), actor(req));
    reply.code(201);
    return result;
  });
  app.post('/api/purchases/:id/reverse', manage, async (req) =>
    ctx.purchases.reverse(idParam.parse(req.params).id, reverseBody.parse(req.body ?? {}), actor(req)),
  );

  // ---- sales ----
  app.get('/api/sales', read, async (req) => ({
    sales: ctx.sales.list(dateRange.parse(req.query)),
  }));
  app.get('/api/sales/:id', read, async (req) => ctx.sales.get(idParam.parse(req.params).id));
  app.post('/api/sales', write, async (req, reply) => {
    const result = ctx.sales.create(createSaleSchema.parse(req.body), actor(req));
    reply.code(201);
    return result;
  });
  app.post('/api/sales/:id/reverse', manage, async (req) =>
    ctx.sales.reverse(idParam.parse(req.params).id, reverseBody.parse(req.body ?? {}), actor(req)),
  );

  // ---- payments ----
  app.get('/api/payments', read, async (req) => {
    const q = dateRange
      .extend({ direction: z.enum(['in', 'out']).optional() })
      .parse(req.query);
    return { payments: ctx.payments.list(q) };
  });
  app.post('/api/payments', write, async (req, reply) => {
    const payment = ctx.payments.create(createPaymentSchema.parse(req.body), actor(req));
    reply.code(201);
    return { payment };
  });

  // ---- expenses ----
  app.get('/api/expenses', read, async (req) => ({
    expenses: ctx.expenses.list(dateRange.parse(req.query)),
  }));
  app.post('/api/expenses', write, async (req, reply) => {
    const expense = ctx.expenses.create(createExpenseSchema.parse(req.body), actor(req));
    reply.code(201);
    return { expense };
  });
}
