import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { openDatabase, runMigrations, seedDatabase, type Db } from '@leather-erp/db';
import { AppError } from './errors';
import { authPlugin } from './plugins/auth';
import { registerAuthRoutes } from './routes/auth.routes';
import { registerInstallRoutes } from './routes/install.routes';
import { AuthService } from './services/auth.service';
import { InstallService } from './services/install.service';
import { LedgerService } from './services/ledger.service';
import type { Sqlite } from './services/change-seq';

export interface BuildServerOptions {
  dbPath: string;
  logger?: boolean;
}

export interface AppContext {
  sqlite: Sqlite;
  db: Db;
  auth: AuthService;
  install: InstallService;
  ledger: LedgerService;
}

export interface BuiltServer {
  app: FastifyInstance;
  ctx: AppContext;
}

/**
 * Build the in-process API server: open/migrate/seed the database, wire
 * services and routes. Call `app.listen({ host: '127.0.0.1' })` to serve —
 * this app is strictly local, never bound to a network interface.
 */
export async function buildServer(options: BuildServerOptions): Promise<BuiltServer> {
  const { sqlite, db } = openDatabase(options.dbPath);
  runMigrations(db);
  await seedDatabase(db);

  const ctx: AppContext = {
    sqlite,
    db,
    auth: new AuthService(db),
    install: new InstallService(sqlite, db),
    ledger: new LedgerService(sqlite, db),
  };

  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION',
          message: 'Invalid input',
          issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    app.log.error(error);
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const message =
      statusCode < 500 && error instanceof Error ? error.message : 'Internal server error';
    return reply.code(statusCode).send({
      error: { code: 'INTERNAL', message },
    });
  });

  await app.register(authPlugin, { authService: ctx.auth });

  app.get('/api/health', async () => ({
    ok: true,
    branchConfigured: ctx.install.getInstall() !== null,
  }));

  registerAuthRoutes(app, ctx.auth);
  registerInstallRoutes(app, ctx.install);

  app.addHook('onClose', async () => {
    ctx.sqlite.close();
  });

  return { app, ctx };
}
