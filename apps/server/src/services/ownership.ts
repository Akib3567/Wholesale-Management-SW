import { SHARED_BRANCH } from '@leather-erp/db';
import { ForbiddenError } from '../errors';

export interface InstallIdentity {
  branchCode: string;
  isHub: boolean;
}

/**
 * THE branch-ownership rule (non-negotiable rule 3): a PC may edit only rows
 * whose branch_code equals its own branch. SHARED rows (master products,
 * shared parties) are mastered at the hub — only a hub install edits them.
 * Everything else arrived via sync and is read-only here.
 */
export function canEdit(install: InstallIdentity, rowBranchCode: string): boolean {
  if (rowBranchCode === SHARED_BRANCH) return install.isHub;
  return rowBranchCode === install.branchCode;
}

export function assertCanEdit(
  install: InstallIdentity,
  rowBranchCode: string,
  what: string,
): void {
  if (!canEdit(install, rowBranchCode)) {
    throw new ForbiddenError(
      `${what} belongs to ${rowBranchCode} and is read-only on this ${install.branchCode} install`,
    );
  }
}
