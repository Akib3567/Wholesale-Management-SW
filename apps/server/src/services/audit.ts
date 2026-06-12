import { newUlid } from '@leather-erp/core';
import { auditLog, type Db } from '@leather-erp/db';

export interface AuditRecord {
  userId?: string | null;
  action: string;
  tableName?: string;
  recordId?: string;
  detail?: unknown;
}

export function writeAudit(db: Db, record: AuditRecord): void {
  db.insert(auditLog)
    .values({
      id: newUlid(),
      userId: record.userId ?? null,
      action: record.action,
      tableName: record.tableName ?? null,
      recordId: record.recordId ?? null,
      detailJson: record.detail === undefined ? null : JSON.stringify(record.detail),
    })
    .run();
}
