import type { FastifyInstance } from 'fastify';
import { UnauthorizedError } from '../errors';
import {
  changePasswordSchema,
  createUserSchema,
  loginSchema,
  updateUserSchema,
  type AuthService,
} from '../services/auth.service';

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  app.post('/api/auth/login', async (req) => {
    const result = await auth.login(loginSchema.parse(req.body));
    return result;
  });

  app.post('/api/auth/logout', { preHandler: app.requireAuth() }, async (req) => {
    if (req.sessionToken) auth.logout(req.sessionToken);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.user) throw new UnauthorizedError();
    return { user: req.user };
  });

  app.post('/api/auth/change-password', { preHandler: app.requireAuth() }, async (req) => {
    if (!req.user) throw new UnauthorizedError();
    await auth.changePassword(req.user.id, changePasswordSchema.parse(req.body));
    return { ok: true };
  });

  app.get('/api/users', { preHandler: app.requireAuth('admin') }, async () => {
    return { users: auth.listUsers() };
  });

  app.post('/api/users', { preHandler: app.requireAuth('admin') }, async (req, reply) => {
    if (!req.user) throw new UnauthorizedError();
    const user = await auth.createUser(createUserSchema.parse(req.body), req.user.id);
    reply.code(201);
    return { user };
  });

  app.patch('/api/users/:id', { preHandler: app.requireAuth('admin') }, async (req) => {
    if (!req.user) throw new UnauthorizedError();
    const { id } = req.params as { id: string };
    const user = await auth.updateUser(id, updateUserSchema.parse(req.body), req.user.id);
    return { user };
  });
}
