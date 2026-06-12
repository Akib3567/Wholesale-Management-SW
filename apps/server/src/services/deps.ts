import type { Db } from '@leather-erp/db';
import { InstallNotConfiguredError } from '../errors';
import type { Sqlite } from './change-seq';
import type { InstallService } from './install.service';
import type { LedgerService } from './ledger.service';
import type { InstallIdentity } from './ownership';

/** Constructor dependencies shared by every domain service. */
export interface ServiceDeps {
  sqlite: Sqlite;
  db: Db;
  install: InstallService;
  ledger: LedgerService;
}

/** This install's identity, or throw 409 if first-run setup hasn't happened. */
export function requireInstall(deps: ServiceDeps): InstallIdentity {
  const info = deps.install.getInstall();
  if (!info) throw new InstallNotConfiguredError();
  return { branchCode: info.branchCode, isHub: info.isHub };
}
