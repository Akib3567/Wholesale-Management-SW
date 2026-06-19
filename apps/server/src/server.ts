import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import {
  applyPendingRestore,
  openDatabase,
  runMigrations,
  seedDatabase,
  type Db,
} from '@leather-erp/db';
import { AppError } from './errors';
import { authPlugin } from './plugins/auth';
import { registerAuthRoutes } from './routes/auth.routes';
import { registerInstallRoutes } from './routes/install.routes';
import { registerTradeRoutes } from './routes/trade.routes';
import { registerSyncRoutes } from './routes/sync.routes';
import { registerDashboardRoutes } from './routes/dashboard.routes';
import { registerAccountingRoutes } from './routes/accounting.routes';
import { registerReportRoutes } from './routes/reports.routes';
import { registerInventoryRoutes } from './routes/inventory.routes';
import { registerBackupRoutes } from './routes/backup.routes';
import { registerExportRoutes } from './routes/export.routes';
import { AuthService } from './services/auth.service';
import { SyncService } from './services/sync.service';
import { BackupService } from './services/backup.service';
import { ExpenseService } from './services/expense.service';
import { InstallService } from './services/install.service';
import { LedgerService } from './services/ledger.service';
import { InventoryService } from './services/inventory.service';
import { PartyService } from './services/party.service';
import { PaymentService } from './services/payment.service';
import { ProductService } from './services/product.service';
import { PurchaseService } from './services/purchase.service';
import { SaleService } from './services/sale.service';
import type { ServiceDeps } from './services/deps';
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
  parties: PartyService;
  products: ProductService;
  purchases: PurchaseService;
  sales: SaleService;
  payments: PaymentService;
  expenses: ExpenseService;
  inventory: InventoryService;
  sync: SyncService;
  backup: BackupService;
  /** True when a staged restore was applied during this startup. */
  restoreApplied: boolean;
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
  // A staged restore must be swapped in BEFORE the DB is opened.
  const restoreApplied = applyPendingRestore(options.dbPath);
  const { sqlite, db } = openDatabase(options.dbPath);
  runMigrations(db);
  await seedDatabase(db);

  const install = new InstallService(sqlite, db);
  const ledger = new LedgerService(sqlite, db);
  const deps: ServiceDeps = { sqlite, db, install, ledger };
  const parties = new PartyService(deps);
  const products = new ProductService(deps);

  const ctx: AppContext = {
    sqlite,
    db,
    auth: new AuthService(db),
    install,
    ledger,
    parties,
    products,
    purchases: new PurchaseService(deps, parties, products),
    sales: new SaleService(deps, parties, products),
    payments: new PaymentService(deps, parties),
    expenses: new ExpenseService(deps),
    inventory: new InventoryService(deps, products),
    sync: new SyncService(deps, options.dbPath),
    backup: new BackupService(deps, options.dbPath),
    restoreApplied,
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
    restoreApplied: ctx.restoreApplied,
  }));

  registerAuthRoutes(app, ctx.auth);
  registerInstallRoutes(app, ctx.install);
  registerTradeRoutes(app, ctx);
  registerSyncRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerAccountingRoutes(app, ctx);
  registerReportRoutes(app, ctx);
  registerInventoryRoutes(app, ctx);
  registerBackupRoutes(app, ctx);
  registerExportRoutes(app, ctx);

  app.addHook('onClose', async () => {
    // Best-effort snapshot on shutdown (no-op unless a backup passphrase is set).
    ctx.backup.backupOnClose();
    ctx.sqlite.close();
  });

  return { app, ctx };
}
