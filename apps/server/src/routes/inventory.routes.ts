import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../server';
import { adjustStockSchema } from '../services/inventory.service';

function actor(req: FastifyRequest): string | null {
  return req.user?.id ?? null;
}

export function registerInventoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const read = { preHandler: app.requireAuth('viewer') };
  const write = { preHandler: app.requireAuth('operator') };

  app.get('/api/inventory', read, async (req) => {
    const q = z.object({ scope: z.string().max(20).optional() }).parse(req.query);
    return ctx.inventory.listStock(q.scope);
  });

  app.get('/api/inventory/:productId/moves', read, async (req) => {
    const { productId } = z.object({ productId: z.string().min(1) }).parse(req.params);
    const install = ctx.install.getInstall();
    return { moves: ctx.inventory.movesForProduct(install?.branchCode ?? '', productId) };
  });

  app.post('/api/inventory/adjust', write, async (req, reply) => {
    const result = ctx.inventory.adjustStock(adjustStockSchema.parse(req.body), actor(req));
    reply.code(201);
    return result;
  });
}
