import cron, { type ScheduledTask } from 'node-cron';
import type { BackupService } from './backup.service';

/**
 * Registers the scheduled backups from the brief. Jobs are best-effort: a
 * failing backup (e.g. no passphrase yet) is swallowed so the timer survives.
 * Not started in tests — call start()/stop() from the app entry point only.
 */
export class BackupScheduler {
  private tasks: ScheduledTask[] = [];

  constructor(private readonly backup: BackupService) {}

  start(): void {
    if (this.tasks.length > 0) return;
    const safe = (kind: 'daily' | 'weekly' | 'monthly' | 'yearly') => () => {
      try {
        if (this.backup.isPassphraseSet()) this.backup.createBackup(kind, null);
      } catch {
        // never let a scheduled backup crash the app
      }
    };
    this.tasks = [
      cron.schedule('0 2 * * *', safe('daily')), // every day 02:00
      cron.schedule('0 3 * * 0', safe('weekly')), // Sundays 03:00
      cron.schedule('0 4 1 * *', safe('monthly')), // 1st of month 04:00
      cron.schedule('0 5 1 1 *', safe('yearly')), // Jan 1 05:00
    ];
  }

  stop(): void {
    for (const t of this.tasks) t.stop();
    this.tasks = [];
  }
}
