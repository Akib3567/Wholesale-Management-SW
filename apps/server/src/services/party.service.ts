import { and, eq, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { newUlid } from '@leather-erp/core';
import { parties, PARTY_KINDS, SHARED_BRANCH, SYSTEM_ACCOUNTS } from '@leather-erp/db';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors';
import { writeAudit } from './audit';
import { nextChangeSeq, nowIso } from './change-seq';
import { requireInstall, type ServiceDeps } from './deps';
import { assertCanEdit } from './ownership';

export const createPartySchema = z.object({
  code: z.string().trim().min(1).max(20).optional(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(PARTY_KINDS),
  phone: z.string().trim().max(30).nullish(),
  address: z.string().trim().max(300).nullish(),
  /** Signed: positive = party owes us (receivable), negative = we owe party. */
  openingBalancePaisa: z.number().int().default(0),
  /** Hub only: create as a SHARED (company-wide) party. */
  shared: z.boolean().default(false),
});

export const updatePartySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(PARTY_KINDS),
    phone: z.string().trim().max(30).nullable(),
    address: z.string().trim().max(300).nullable(),
    isActive: z.boolean(),
  })
  .partial();

export type Party = typeof parties.$inferSelect;

const CODE_PREFIX: Record<(typeof PARTY_KINDS)[number], string> = {
  customer: 'C',
  supplier: 'S',
  both: 'P',
};

export class PartyService {
  constructor(private readonly deps: ServiceDeps) {}

  list(
    filter: {
      kind?: 'customer' | 'supplier' | 'both' | undefined;
      q?: string | undefined;
      includeInactive?: boolean | undefined;
    } = {},
  ): Party[] {
    const where = [eq(parties.isDeleted, false)];
    if (!filter.includeInactive) where.push(eq(parties.isActive, true));
    if (filter.kind === 'customer' || filter.kind === 'supplier') {
      // 'both' parties act as customer AND supplier
      where.push(or(eq(parties.kind, filter.kind), eq(parties.kind, 'both'))!);
    }
    if (filter.q) {
      const q = `%${filter.q}%`;
      where.push(or(like(parties.name, q), like(parties.code, q), like(parties.phone, q))!);
    }
    return this.deps.db
      .select()
      .from(parties)
      .where(and(...where))
      .orderBy(parties.name)
      .limit(500)
      .all();
  }

  get(id: string): Party {
    const row = this.deps.db.select().from(parties).where(eq(parties.id, id)).get();
    if (!row || row.isDeleted) throw new NotFoundError('Party not found');
    return row;
  }

  /**
   * Net outstanding balance per party from AR/AP journal lines (includes the
   * opening balance, since that was posted as a journal entry). Positive =
   * the party owes us (receivable, "Pabo"); negative = we owe them (payable,
   * "Debo"). Computed across all journal lines on this install.
   */
  balancesByParty(): Map<string, number> {
    const rows = this.deps.sqlite
      .prepare(
        `SELECT party_id AS partyId, COALESCE(SUM(debit_paisa - credit_paisa), 0) AS balancePaisa
         FROM journal_lines
         WHERE party_id IS NOT NULL AND account_id IN (?, ?)
         GROUP BY party_id`,
      )
      .all(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE) as Array<{
      partyId: string;
      balancePaisa: number;
    }>;
    return new Map(rows.map((r) => [r.partyId, r.balancePaisa]));
  }

  create(input: z.input<typeof createPartySchema>, actorId: string | null): Party {
    const parsed = createPartySchema.parse(input);
    const install = requireInstall(this.deps);
    if (parsed.shared && !install.isHub) {
      throw new ForbiddenError('Only the hub can create SHARED parties');
    }
    const ownerBranch = parsed.shared ? SHARED_BRANCH : install.branchCode;

    return this.deps.sqlite.transaction(() => {
      const code = parsed.code ?? this.nextPartyCode(ownerBranch, parsed.kind);
      const dup = this.deps.db
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.branchCode, ownerBranch), eq(parties.code, code)))
        .get();
      if (dup) throw new ConflictError(`Party code '${code}' already exists for ${ownerBranch}`);

      const id = newUlid();
      this.deps.db
        .insert(parties)
        .values({
          id,
          branchCode: ownerBranch,
          changeSeq: nextChangeSeq(this.deps.sqlite),
          code,
          name: parsed.name,
          kind: parsed.kind,
          phone: parsed.phone ?? null,
          address: parsed.address ?? null,
          openingBalancePaisa: parsed.openingBalancePaisa,
          createdBy: actorId,
        })
        .run();

      if (parsed.openingBalancePaisa !== 0) {
        const amount = Math.abs(parsed.openingBalancePaisa);
        const owesUs = parsed.openingBalancePaisa > 0;
        this.deps.ledger.postEntry({
          entryDate: nowIso().slice(0, 10),
          narration: `Opening balance — ${parsed.name}`,
          refType: 'opening',
          refId: id,
          createdBy: actorId,
          lines: owesUs
            ? [
                { accountId: SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, partyId: id, debitPaisa: amount },
                { accountId: SYSTEM_ACCOUNTS.OPENING_BALANCE_EQUITY, creditPaisa: amount },
              ]
            : [
                { accountId: SYSTEM_ACCOUNTS.OPENING_BALANCE_EQUITY, debitPaisa: amount },
                { accountId: SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, partyId: id, creditPaisa: amount },
              ],
        });
      }

      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'party.create',
        tableName: 'parties',
        recordId: id,
        detail: { code, name: parsed.name, kind: parsed.kind, branch: ownerBranch },
      });
      return this.get(id);
    })();
  }

  update(id: string, input: z.input<typeof updatePartySchema>, actorId: string | null): Party {
    const patch = updatePartySchema.parse(input);
    const install = requireInstall(this.deps);
    return this.deps.sqlite.transaction(() => {
      const row = this.get(id);
      assertCanEdit(install, row.branchCode, `Party '${row.name}'`);
      this.deps.db
        .update(parties)
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.kind !== undefined && { kind: patch.kind }),
          ...(patch.phone !== undefined && { phone: patch.phone }),
          ...(patch.address !== undefined && { address: patch.address }),
          ...(patch.isActive !== undefined && { isActive: patch.isActive }),
          changeSeq: nextChangeSeq(this.deps.sqlite),
          updatedAt: nowIso(),
        })
        .where(eq(parties.id, id))
        .run();
      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'party.update',
        tableName: 'parties',
        recordId: id,
        detail: patch,
      });
      return this.get(id);
    })();
  }

  softDelete(id: string, actorId: string | null): void {
    const install = requireInstall(this.deps);
    this.deps.sqlite.transaction(() => {
      const row = this.get(id);
      assertCanEdit(install, row.branchCode, `Party '${row.name}'`);
      this.deps.db
        .update(parties)
        .set({
          isDeleted: true,
          isActive: false,
          changeSeq: nextChangeSeq(this.deps.sqlite),
          updatedAt: nowIso(),
        })
        .where(eq(parties.id, id))
        .run();
      writeAudit(this.deps.db, {
        userId: actorId,
        action: 'party.delete',
        tableName: 'parties',
        recordId: id,
      });
    })();
  }

  private nextPartyCode(branchCode: string, kind: (typeof PARTY_KINDS)[number]): string {
    const prefix = CODE_PREFIX[kind];
    const row = this.deps.db
      .select({ code: parties.code })
      .from(parties)
      .where(and(eq(parties.branchCode, branchCode), like(parties.code, `${prefix}-%`)))
      .orderBy(sql`${parties.code} DESC`)
      .limit(1)
      .get();
    const last = row ? Number.parseInt(row.code.slice(prefix.length + 1), 10) : 0;
    return `${prefix}-${String(last + 1).padStart(4, '0')}`;
  }
}
