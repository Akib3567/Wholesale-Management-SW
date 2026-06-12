import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@leather-erp/db';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { ROLE_RANK, type AuthService, type PublicUser } from '../services/auth.service';

declare module 'fastify' {
  interface FastifyRequest {
    user: PublicUser | null;
    sessionToken: string | null;
  }
  interface FastifyInstance {
    /** preHandler: require a logged-in user with at least this role. */
    requireAuth(minRole?: UserRole): (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthPluginOptions {
  authService: AuthService;
}

/** Resolves the Bearer token on every request and exposes requireAuth(). */
export const authPlugin = fp<AuthPluginOptions>(
  async (app, opts) => {
    app.decorateRequest('user', null);
    app.decorateRequest('sessionToken', null);

    app.addHook('onRequest', async (req) => {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        const token = header.slice('Bearer '.length).trim();
        req.sessionToken = token;
        req.user = opts.authService.resolveSession(token);
      }
    });

    app.decorate('requireAuth', (minRole: UserRole = 'viewer') => {
      return async (req: FastifyRequest) => {
        if (!req.user) throw new UnauthorizedError();
        if (ROLE_RANK[req.user.role] < ROLE_RANK[minRole]) {
          throw new ForbiddenError(`Requires ${minRole} role or higher`);
        }
      };
    });
  },
  { name: 'auth-plugin' },
);
