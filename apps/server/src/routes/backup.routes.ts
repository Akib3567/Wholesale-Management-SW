import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../server';
import { backupPassphraseSchema } from '../services/backup.service';

function actor(req: FastifyRequest): string | null {
  return req.user?.id ?? null;
}

const KINDS = ['manual', 'daily', 'weekly', 'monthly', 'yearly', 'on_close'] as const;

export function registerBackupRoutes(app: FastifyInstance, ctx: AppContext): void {
  const read = { preHandler: app.requireAuth('viewer') };
  const manage = { preHandler: app.requireAuth('manager') };
  const admin = { preHandler: app.requireAuth('admin') };

  app.get('/api/backups', read, async () => ({
    passphraseSet: ctx.backup.isPassphraseSet(),
    backups: ctx.backup.list(),
  }));

  app.post('/api/backups/passphrase', admin, async (req) => {
    ctx.backup.setPassphrase(backupPassphraseSchema.parse(req.body), actor(req));
    return { ok: true };
  });

  app.post('/api/backups', manage, async (req, reply) => {
    const { kind } = z.object({ kind: z.enum(KINDS).default('manual') }).parse(req.body ?? {});
    const record = ctx.backup.createBackup(kind, actor(req));
    reply.code(201);
    return { backup: record };
  });

  app.post('/api/backups/:id/verify', read, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return ctx.backup.verify(id);
  });

  // Restoring is destructive and admin-only; it stages the snapshot for next launch.
  app.post('/api/backups/:id/restore', admin, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return ctx.backup.restore(id, actor(req));
  });
}
