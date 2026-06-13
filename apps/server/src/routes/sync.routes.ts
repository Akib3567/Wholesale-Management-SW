import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../server';
import { z } from 'zod';
import {
  exportSchema,
  importSchema,
  mergeProductSchema,
  passphraseSchema,
  uploadSchema,
} from '../services/sync.service';

function actor(req: FastifyRequest): string | null {
  return req.user?.id ?? null;
}

export function registerSyncRoutes(app: FastifyInstance, ctx: AppContext): void {
  const read = { preHandler: app.requireAuth('viewer') };
  const manage = { preHandler: app.requireAuth('manager') };
  const admin = { preHandler: app.requireAuth('admin') };

  app.get('/api/sync/status', read, async () => ctx.sync.status());

  app.post('/api/sync/passphrase', admin, async (req) => {
    ctx.sync.setPassphrase(passphraseSchema.parse(req.body), actor(req));
    return { ok: true };
  });

  app.post('/api/sync/export', manage, async (req) => {
    return ctx.sync.exportPacket(exportSchema.parse(req.body ?? {}), actor(req));
  });

  app.post('/api/sync/combined', manage, async (req) => {
    const body = (req.body ?? {}) as { outDir?: string };
    return ctx.sync.buildCombinedPacket({ outDir: body.outDir }, actor(req));
  });

  app.post('/api/sync/import', manage, async (req) => {
    return ctx.sync.importPacketFile(importSchema.parse(req.body), actor(req));
  });

  // Browser file-picker import: packet bytes uploaded as base64.
  app.post('/api/sync/import-upload', manage, async (req) => {
    return ctx.sync.importPacketBytes(uploadSchema.parse(req.body), actor(req));
  });

  // Download a previously-exported packet (to copy onto a pendrive).
  app.get('/api/sync/download', manage, async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.query);
    const { fileName, buffer } = ctx.sync.readPacketForDownload(name);
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${fileName}"`);
    return reply.send(buffer);
  });

  app.post('/api/sync/merge-product', manage, async (req) => {
    return ctx.sync.mergeProvisionalProduct(mergeProductSchema.parse(req.body), actor(req));
  });
}
