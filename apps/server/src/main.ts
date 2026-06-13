/** Dev/standalone runner. In production Electron launches buildServer() in-process. */
import { resolve } from 'node:path';
import { buildServer } from './server';
import { BackupScheduler } from './services/backup-schedule';

const dbPath = resolve(process.env['ERP_DB_PATH'] ?? './shop.sqlite');
const port = Number(process.env['ERP_PORT'] ?? 3001);

const { app, ctx } = await buildServer({ dbPath, logger: true });

// Scheduled backups (daily/weekly/monthly/yearly) run only in the live app.
const scheduler = new BackupScheduler(ctx.backup);
scheduler.start();

try {
  // 127.0.0.1 only: the ERP must never be reachable from the network.
  await app.listen({ host: '127.0.0.1', port });
} catch (error) {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${port} is already in use — another instance of the dev server is probably running.\n` +
        `Stop it first (Ctrl+C in its terminal), or find it with:\n` +
        `  Get-NetTCPConnection -LocalPort ${port} | Select OwningProcess\n` +
        `  taskkill /PID <pid> /T /F\n`,
    );
    process.exit(1);
  }
  throw error;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    scheduler.stop();
    void app.close().then(() => process.exit(0));
  });
}
