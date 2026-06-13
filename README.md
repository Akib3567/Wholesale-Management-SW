# NSK Enterprise

Local-first, fully **offline** desktop ERP for a wholesale leather-products business with
multiple independent branch PCs that sync by **carrying a file** between them
(pendrive / file share). No live network between branches.

> Internal monorepo packages keep the `@leather-erp/*` scope as the product's code-level
> identifier; the application brand shown to users is **NSK Enterprise**.

## Core guarantees

1. **Money is never a JavaScript `number`.** Stored as INTEGER paisa (taka × 100),
   all non-integer arithmetic via `decimal.js`. See `packages/core/src/money.ts`.
2. **Double-entry accounting.** Every business event posts a balanced journal entry
   (Σdebit = Σcredit) in one transaction. Financial rows are never hard-deleted.
3. **Branch-ownership sync.** Every syncable record has a global ULID id, an owner
   `branch_code`, and a `change_seq`. A PC edits only its own branch's rows and imports
   other branches' rows read-only. Imports are idempotent.
4. **TypeScript strict** everywhere; all inputs validated with Zod.

## Layout

```
apps/
  desktop/   Electron shell (main + preload)          [phase 10]
  ui/        React + Vite + Tailwind + shadcn/ui      [phase 6+]
  server/    Fastify + Drizzle + better-sqlite3,
             runs in-process on the same PC           [phase 3+]
packages/
  core/      money (decimal.js, integer paisa), ULID  [phase 1 ✓]
  db/        Drizzle schema + migrations + seed       [phase 2]
  sync/      sync-packet export/import, signing,
             AES-256-GCM encryption                   [phase 5]
```

## Commands

```bash
npm install          # install all workspaces
npm test             # run all workspace tests
npm run typecheck    # tsc --noEmit in all workspaces
npm run lint         # eslint
npm run format       # prettier --write
```

## Requirements

Node.js >= 20.
