import { InstallNotConfiguredError } from '../errors';
import type { AppContext } from '../server';

export interface AsOfBranch {
  code: string;
  name: string;
  lastImportAt: string | null;
}

export interface ScopeInfo {
  /** null = whole company. */
  branch: string | null;
  myBranch: string;
  /**
   * Foreign branches whose data is included in this scope, with the time of
   * the last packet import — file-carried sync is never real-time, so every
   * report discloses "BranchX data as of <date>".
   */
  asOf: AsOfBranch[];
}

/** Resolve ?scope=THIS|ALL|<code> and collect the as-of disclosure list. */
export function resolveScope(ctx: AppContext, raw: string | undefined): ScopeInfo {
  const install = ctx.install.getInstall();
  if (!install) throw new InstallNotConfiguredError();
  const scope = (raw ?? 'THIS').toUpperCase();
  const branch = scope === 'ALL' ? null : scope === 'THIS' ? install.branchCode : scope;

  let asOf: AsOfBranch[] = [];
  if (branch !== install.branchCode) {
    const rows = ctx.sqlite
      .prepare(
        `SELECT b.code, b.name, s.last_import_at AS lastImportAt
         FROM branches b LEFT JOIN sync_state s ON s.peer_branch = b.code
         WHERE b.code <> ? ${branch ? 'AND b.code = ?' : ''} ORDER BY b.code`,
      )
      .all(...(branch ? [install.branchCode, branch] : [install.branchCode])) as AsOfBranch[];
    asOf = rows;
  }
  return { branch, myBranch: install.branchCode, asOf };
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
