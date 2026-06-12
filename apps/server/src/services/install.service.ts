import { z } from 'zod';
import { branches, thisInstall, SHARED_BRANCH, type Db } from '@leather-erp/db';
import { ConflictError } from '../errors';
import { writeAudit } from './audit';
import type { Sqlite } from './change-seq';

export const branchCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,11}$/, 'Branch code must be 2-12 chars: A-Z, 0-9, _ (starts with a letter)')
  .refine((code) => code !== SHARED_BRANCH, `${SHARED_BRANCH} is reserved`);

export const bootstrapSchema = z.object({
  branchCode: branchCodeSchema,
  branchName: z.string().trim().min(1).max(80),
  isHub: z.boolean(),
});
export type BootstrapInput = z.infer<typeof bootstrapSchema>;

export interface InstallInfo {
  branchCode: string;
  isHub: boolean;
  nextChangeSeq: number;
  installedAt: string;
}

export interface BranchInfo {
  code: string;
  name: string;
  isHub: boolean;
}

export class InstallService {
  constructor(
    private readonly sqlite: Sqlite,
    private readonly db: Db,
  ) {}

  getInstall(): InstallInfo | null {
    const row = this.db.select().from(thisInstall).get();
    if (!row) return null;
    return {
      branchCode: row.branchCode,
      isHub: row.isHub,
      nextChangeSeq: row.nextChangeSeq,
      installedAt: row.installedAt,
    };
  }

  listBranches(): BranchInfo[] {
    return this.db
      .select()
      .from(branches)
      .all()
      .map((b) => ({ code: b.code, name: b.name, isHub: b.isHub }));
  }

  /**
   * One-time branch identity setup. The branch code is immutable afterwards —
   * every owned record will be stamped with it forever, so changing it would
   * orphan history and break sync ownership.
   */
  bootstrap(input: BootstrapInput, actorId: string | null): InstallInfo {
    const parsed = bootstrapSchema.parse(input);
    return this.sqlite.transaction(() => {
      if (this.getInstall()) {
        throw new ConflictError('This install already has a branch identity; it cannot be changed');
      }
      this.db
        .insert(branches)
        .values({ code: parsed.branchCode, name: parsed.branchName, isHub: parsed.isHub })
        .onConflictDoNothing()
        .run();
      this.db
        .insert(thisInstall)
        .values({ id: 1, branchCode: parsed.branchCode, isHub: parsed.isHub })
        .run();
      writeAudit(this.db, {
        userId: actorId,
        action: 'install.bootstrap',
        tableName: 'this_install',
        detail: parsed,
      });
      const info = this.getInstall();
      if (!info) throw new Error('bootstrap failed to persist');
      return info;
    })();
  }
}
