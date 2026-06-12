import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { asPaisa, newUlid, sumPaisa } from '@leather-erp/core';
import {
  journalEntries,
  journalLines,
  JOURNAL_REF_TYPES,
  type Db,
  type JournalRefType,
} from '@leather-erp/db';
import {
  BadRequestError,
  ForbiddenError,
  InstallNotConfiguredError,
  NotFoundError,
  UnbalancedEntryError,
} from '../errors';
import { nextChangeSeq, nowIso, type Sqlite } from './change-seq';

const lineSchema = z
  .object({
    accountId: z.string().min(1),
    partyId: z.string().min(1).nullish(),
    debitPaisa: z.number().int().nonnegative().default(0),
    creditPaisa: z.number().int().nonnegative().default(0),
    lineNote: z.string().max(200).nullish(),
  })
  .refine((l) => (l.debitPaisa > 0) !== (l.creditPaisa > 0), {
    message: 'Each line must be exactly one side: debit XOR credit, > 0',
  });

export const postEntrySchema = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'entryDate must be YYYY-MM-DD'),
  narration: z.string().max(500).default(''),
  refType: z.enum(JOURNAL_REF_TYPES),
  refId: z.string().nullish(),
  lines: z.array(lineSchema).min(2, 'A journal entry needs at least 2 lines'),
  createdBy: z.string().nullish(),
});
export type PostEntryInput = z.input<typeof postEntrySchema>;

export interface PostedEntry {
  id: string;
  branchCode: string;
  changeSeq: number;
  debitTotalPaisa: number;
  creditTotalPaisa: number;
}

export interface EntryWithLines {
  entry: typeof journalEntries.$inferSelect;
  lines: Array<typeof journalLines.$inferSelect>;
}

/**
 * The ONLY way any business event reaches the books. Validates the entry,
 * proves Σdebit = Σcredit, and writes header + lines in one transaction
 * stamped with this install's branch and next change_seq. Throws — writing
 * nothing — on any violation.
 */
export class LedgerService {
  constructor(
    private readonly sqlite: Sqlite,
    private readonly db: Db,
  ) {}

  postEntry(input: PostEntryInput): PostedEntry {
    const parsed = postEntrySchema.parse(input);

    const debitTotal = sumPaisa(parsed.lines.map((l) => asPaisa(l.debitPaisa)));
    const creditTotal = sumPaisa(parsed.lines.map((l) => asPaisa(l.creditPaisa)));
    if (debitTotal !== creditTotal) {
      throw new UnbalancedEntryError(debitTotal, creditTotal);
    }

    return this.sqlite.transaction(() => {
      const install = this.getInstallRow();
      const changeSeq = nextChangeSeq(this.sqlite);
      const entryId = newUlid();

      this.db
        .insert(journalEntries)
        .values({
          id: entryId,
          branchCode: install.branch_code,
          changeSeq,
          entryDate: parsed.entryDate,
          narration: parsed.narration,
          refType: parsed.refType,
          refId: parsed.refId ?? null,
          createdBy: parsed.createdBy ?? null,
        })
        .run();

      parsed.lines.forEach((line, i) => {
        this.db
          .insert(journalLines)
          .values({
            id: newUlid(),
            entryId,
            lineNo: i + 1,
            accountId: line.accountId,
            partyId: line.partyId ?? null,
            debitPaisa: line.debitPaisa,
            creditPaisa: line.creditPaisa,
            lineNote: line.lineNote ?? null,
          })
          .run();
      });

      return {
        id: entryId,
        branchCode: install.branch_code,
        changeSeq,
        debitTotalPaisa: debitTotal,
        creditTotalPaisa: creditTotal,
      };
    })();
  }

  /**
   * Corrections never delete: post a mirror-image entry and link the two.
   * Only own-branch entries can be reversed, and only once.
   */
  reverseEntry(
    entryId: string,
    opts: { entryDate: string; narration?: string; refType?: JournalRefType; createdBy?: string | null },
  ): PostedEntry {
    return this.sqlite.transaction(() => {
      const install = this.getInstallRow();
      const original = this.db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.id, entryId))
        .get();
      if (!original) throw new NotFoundError('Journal entry not found');
      if (original.branchCode !== install.branch_code) {
        throw new ForbiddenError(
          `Entry belongs to branch ${original.branchCode}; this install (${install.branch_code}) cannot modify it`,
        );
      }
      if (original.isReversed) {
        throw new BadRequestError('Entry is already reversed');
      }
      const originalLines = this.db
        .select()
        .from(journalLines)
        .where(eq(journalLines.entryId, entryId))
        .all();

      const reversal = this.postEntry({
        entryDate: opts.entryDate,
        narration: opts.narration ?? `Reversal of ${entryId}`,
        refType: opts.refType ?? 'adjustment',
        refId: entryId,
        createdBy: opts.createdBy ?? null,
        lines: originalLines.map((l) => ({
          accountId: l.accountId,
          partyId: l.partyId,
          debitPaisa: l.creditPaisa, // swapped
          creditPaisa: l.debitPaisa,
          lineNote: l.lineNote,
        })),
      });

      // Flag the original (own-branch metadata update → bumps its change_seq).
      this.db
        .update(journalEntries)
        .set({
          isReversed: true,
          reversedByEntryId: reversal.id,
          changeSeq: nextChangeSeq(this.sqlite),
          updatedAt: nowIso(),
        })
        .where(eq(journalEntries.id, entryId))
        .run();

      return reversal;
    })();
  }

  getEntryWithLines(entryId: string): EntryWithLines {
    const entry = this.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, entryId))
      .get();
    if (!entry) throw new NotFoundError('Journal entry not found');
    const lines = this.db
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, entryId))
      .all();
    return { entry, lines };
  }

  private getInstallRow(): { branch_code: string } {
    const row = this.sqlite
      .prepare('SELECT branch_code FROM this_install WHERE id = 1')
      .get() as { branch_code: string } | undefined;
    if (!row) throw new InstallNotConfiguredError();
    return row;
  }
}
