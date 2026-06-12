import type { FastifyInstance } from 'fastify';
import { UnauthorizedError } from '../errors';
import { bootstrapSchema, type InstallService } from '../services/install.service';

export function registerInstallRoutes(app: FastifyInstance, install: InstallService): void {
  app.get('/api/install', { preHandler: app.requireAuth() }, async () => {
    return {
      install: install.getInstall(),
      branches: install.listBranches(),
    };
  });

  app.post('/api/install/bootstrap', { preHandler: app.requireAuth('admin') }, async (req, reply) => {
    if (!req.user) throw new UnauthorizedError();
    const info = install.bootstrap(bootstrapSchema.parse(req.body), req.user.id);
    reply.code(201);
    return { install: info };
  });
}
