# Leather Wholesale ERP — Build Plan & Spec (Multi-Branch, File-Carried Sync)

A local-first desktop application for a wholesale leather-products business with **multiple
independent branch PCs** that are each fully offline and sync by **carrying a file** between
them (pendrive / file-sharing). Built to be resold to multiple similar companies.

**Stack:** Electron + React + TypeScript (UI) · Node + Fastify + TypeScript (local server) ·
SQLite via better-sqlite3 + Drizzle ORM · decimal.js for money.

---

## 0. The two rules that protect the books

1. **Money is never a JavaScript `number`.** Stored in SQLite as **INTEGER paisa**
   (taka × 100), converted to `decimal.js` on read, back to integer paisa on write. The UI
   only displays strings the server computed. This is what makes accounting correctness real.

2. **Every record carries a branch and a globally-unique key.** No sequential IDs that
   collide across branches. This is what makes file-carried sync safe.

---

## 1. The sync model (the heart of this build)

### Branch-ownership ("partitioned ownership") sync

- The company has several branches: e.g. `DHAKA`, `CTG`, plus more later. Each runs the
  **same software on one offline PC** and is assigned a permanent **branch code** at install.
- A branch **owns and may edit only its own** purchases, sales, payments, and expenses.
- A branch **receives the other branches' records as read-only** when it imports a sync file.
- Result: each PC holds **the whole company picture** (its own editable data + every other
  branch's read-only data) and can run **combined reports and company-wide P&L** — yet no PC
  ever writes another branch's records. **There are no conflicts to resolve, by design.**

This is the safest possible sync model: because ownership is partitioned, an import can only
ever *add or update foreign-branch rows*, never touch local ones. Re-importing the same file
twice does nothing (idempotent).

### Topology: hub mode (recommended for 5-6+ branches)

With 6 branches, branch-to-branch carrying explodes to ~30 file trips per full round. Instead,
designate **one hub PC** (head office, or Dhaka):

```
  DHAKA ─┐                       ┌─► every branch's packet imported
  CTG  ──┤  export packets  ───► │   at the HUB, then HUB exports one
  SYLHET─┤  (pendrive/share)     │   combined "all-branches" packet
  ...  ──┘                       └─► back out to each branch
```

- Each branch exports its **changes-only packet** and gets it to the hub.
- The hub imports all branch packets, then exports **one combined packet** containing every
  branch's latest data.
- Each branch imports that combined packet and now sees the whole company.

The software supports **both** direct branch-to-branch and hub mode; the client's standard
operating procedure should be hub mode. This is a procedure choice, not a code limitation.

### What the transferable file is (changes-only, not whole DB)

A **sync packet** = a single signed + encrypted file containing:
- sender branch code,
- an export watermark (a per-branch monotonic counter / "change sequence"),
- all of that sender's new-or-changed records since its last export to this destination,
- a manifest with counts + a SHA-256 hash.

**Why changes-only instead of whole-database:** if staff ever import the wrong file, a
whole-DB import could clobber the receiver's own branch data. A changes-only packet only
carries *foreign-branch* rows and the importer is built to **never modify the local branch's
rows**, so even a mistaken or duplicate import is harmless. It's also far smaller on a pendrive.

### Import safety checklist (built into the importer)

1. Verify signature + SHA-256; reject tampered/corrupt files.
2. Confirm the packet's branch ≠ this PC's own branch (never import your own branch as foreign).
3. Upsert foreign-branch records **by their global keys** (idempotent).
4. Record the import in a `sync_log` with timestamp, source branch, and counts.
5. Stamp imported data so reports can show **"BranchX data as of <last import date>"** — the
   honest time-lag disclosure, since file-carried sync is never real-time.

### Shared product list & shared parties

- The **product list is shared** and **mastered at the hub**. Branches pull the authoritative
  list via the combined packet.
- A branch that must sell a brand-new product before the next sync can create a **provisional
  local product** (keyed by its own branch, so no collision). The hub later **merges** it into
  the master list and maps the provisional key to the master key on the next combined packet.
- **Customers/suppliers may be shared or branch-specific.** Each party carries an `owner_branch`
  (or `SHARED`, mastered at the hub). Branch-specific parties sync like any other owned record.

---

## 2. Architecture

```
React UI  ──►  Fastify routes  ──►  Domain services  ──►  Repositories  ──►  SQLite
(no math)      (validate, auth,      (LedgerService,       (SQL, txns)        (one file
                role checks)          SyncService, …)                          per install)
                                          │
                              SyncService: export packet / import packet
                                          ▼
                              Sync packet file (signed + encrypted)  ⇄  pendrive / share
```

- **One install per branch PC.** Single-PC, so the bundled Fastify server runs on the same
  machine the UI runs on (no LAN server needed — that was the previous, different requirement).
- **UI** collects input and renders; never computes money.
- **Services** hold business rules. Two are central:
  - `LedgerService.postEntry()` — turns every event into a **balanced double-entry** journal
    posting inside one transaction (Σdebit = Σcredit, or it throws).
  - `SyncService` — exports/imports sync packets with the safety checklist above.

### Double-entry under a simple UI

Every business event posts a balanced journal entry, so trial balance / cash book / P&L fall
out automatically and always balance — per branch *and* combined. Mapping the client's familiar
terms (UI shows clean English labels):

| Old term | Meaning | Journal posting |
|---|---|---|
| Purchase (credit) | Bought goods on credit | Dr Inventory · Cr Accounts Payable (supplier) |
| PORESOD (to supplier) | Paid a supplier | Dr Accounts Payable · Cr Cash/Bank |
| SALE / SALES | Sold goods | Dr Cash or A/R · Cr Sales Revenue; **and** Dr COGS · Cr Inventory |
| Cash Receive (from customer) | Customer paid due | Dr Cash/Bank · Cr Accounts Receivable |
| MAL FAROT (Goods Return) | Goods returned | Reversing entry of the original |
| BAKE (Due) | Running balance owed | Sub-ledger balance of that party |
| Cha Nasta / Gari Bhara | Petty expenses | Dr Expense · Cr Cash |

Every journal entry also carries `branch_code`, so reports can filter **This Branch / a chosen
branch / Whole Company**.

---

## 3. Database design (SQLite via Drizzle ORM)

Principles: money columns are **INTEGER paisa**; every record has a **global key** (ULID) +
`branch_code` (or `SHARED`); a per-branch **`change_seq`** counter drives changes-only export;
financial rows are **never hard-deleted** (a reversing entry is posted; corrections stay in
history); every table has `created_at, updated_at, created_by`.

### Identity & sync columns (on every syncable table)
`id TEXT` (ULID, globally unique) · `branch_code TEXT` · `change_seq INTEGER` (bumped on every
insert/update of that row, per branch) · `is_deleted INTEGER` (soft-delete flag for
non-financial rows like products) · `row_hash TEXT` (optional integrity check).

### Tables

**branches** — known branch codes and display names; marks which install is the hub.
`code (PK, e.g. DHAKA), name, is_hub, created_at`

**this_install** — single row: this PC's own `branch_code`, set once at first launch, immutable.

**users** — local auth per install
`id, username, password_hash (argon2), full_name, role (admin|manager|operator|viewer),
is_active, created_at`

**accounts** — chart of accounts (shared/identical structure across branches)
`id, code, name, type (asset|liability|equity|income|expense), is_cash, is_bank, parent_id,
is_system`

**parties** — customers/suppliers
`id (ULID), branch_code (owner branch, or SHARED), code, name, kind (customer|supplier|both),
phone, address, opening_balance_paisa, is_active`

**products** — shared list, mastered at hub
`id (ULID), name, sku, unit (pcs|sqft|kg), category, reorder_level, is_provisional,
provisional_origin_branch, master_id (set when hub merges a provisional into master), is_active`

**stock_moves** — stock in/out per branch (each branch tracks its own stock)
`id, branch_code, product_id, move_type (in|out|adjust|return), qty, unit_cost_paisa,
ref_type, ref_id, moved_at, created_by`

**journal_entries** — one per event (header)
`id, branch_code, entry_date, narration, ref_type
(purchase|sale|payment|receipt|expense|return|opening|adjustment), ref_id, posted_by,
is_reversed, reversed_by_entry_id, change_seq`

**journal_lines** — debit/credit lines (sum to zero per entry)
`id, entry_id, account_id, party_id (nullable), debit_paisa, credit_paisa, line_note`

**purchases / purchase_items** — purchase docs (owned by the entering branch)
`purchases: id, branch_code, party_id, doc_no, doc_date, subtotal_paisa, discount_paisa,
total_paisa, paid_paisa, journal_entry_id, status, change_seq`

**sales / sale_items** — sales docs (mirror of purchases)

**payments** — money in/out vs a party (PORESOD / Cash Receive)
`id, branch_code, party_id, direction (in|out), amount_paisa, method (cash|bank), account_id,
ref_no, paid_date, journal_entry_id, change_seq`

**expenses** — daily petty costs
`id, branch_code, expense_account_id, amount_paisa, note, spent_date, journal_entry_id,
change_seq`

**daily_closing** — per-day cash snapshot per branch (mirrors old "B/F")
`id, branch_code, close_date, opening_cash_paisa, closing_cash_paisa, closed_by, closed_at`

**sync_state** — per destination branch: last `change_seq` exported and last imported.
`peer_branch, last_export_seq, last_import_seq, last_export_at, last_import_at`

**sync_log** — every export/import packet
`id, direction (export|import), peer_branch, packet_sha256, record_count, status, at`

**backups** — local backup log
`id, kind (manual|daily|weekly|monthly|yearly), file_path, size_bytes, sha256, taken_at, status`

**settings** — business profile, fiscal-year start, this branch's display name, backup config,
sync encryption passphrase / signing key.

**audit_log** — `id, user_id, action, table_name, record_id, detail_json, at`

### Derived (computed) reports — all filterable by branch or whole-company
Trial balance · party statements with running balance · cash book / bank book · P&L over a
date range · stock on hand & valuation (per branch and combined).

---

## 4. Local backup system (separate from sync)

Backups protect a single PC against loss; **sync** shares data between PCs. They are different
features and must not be confused.

- **Snapshot safely:** better-sqlite3 online backup or `VACUUM INTO` (never a raw file copy of
  a live DB).
- **Encrypt** (AES-256-GCM, key from a Settings passphrase), hash (SHA-256), write to local
  `backups/`, log in `backups` table.
- **Schedule** (`node-cron`): Daily (keep 14) · Weekly (keep 8) · Monthly (keep 12) · Yearly
  (keep all) · plus on app close.
- **Restore:** pick a snapshot → verify hash → take a pre-restore safety backup → swap in.
- Optional cloud upload (B2 / R2) when internet is available — off by default since the client
  works fully offline.

---

## 5. VS Code environment setup (do once)

### 5.1 Install
1. **Node.js LTS v20+** — verify `node -v`, `npm -v`.
2. **Git** — `git --version`; set `user.name` and `user.email`.
3. **VS Code** + extensions: ESLint, Prettier, Tailwind CSS IntelliSense, SQLite Viewer,
   Error Lens, Claude Code.
4. **GitHub** account + an empty **private** repo `leather-erp`.

### 5.2 Create project
```bash
mkdir leather-erp && cd leather-erp
git init
code .
```

### 5.3 Run Claude Code in the integrated terminal and paste the Part 6 prompt. Approve writes
phase by phase.

### 5.4 Layout Claude Code will create
```
leather-erp/
├─ package.json                 # npm workspaces
├─ apps/
│  ├─ desktop/                  # Electron shell (main + preload)
│  ├─ ui/                       # React + Vite + Tailwind + shadcn/ui
│  └─ server/                   # Fastify + Drizzle + better-sqlite3 (runs in-process)
├─ packages/
│  ├─ core/                     # money (decimal.js), domain types, ledger rules
│  ├─ db/                       # Drizzle schema + migrations + seed
│  └─ sync/                     # sync-packet export/import, signing, encryption
├─ .gitignore                   # node_modules, dist, *.sqlite, .env, backups/, *.packet
├─ .env.example
└─ README.md
```

### 5.5 First commit & push
```bash
git add .
git commit -m "chore: scaffold leather-erp"
git branch -M main
git remote add origin https://github.com/<you>/leather-erp.git
git push -u origin main
```

### 5.6 Git workflow
Feature branches (`feature/sync-export`), Conventional Commits (`feat:`, `fix:`, `chore:`),
PRs on GitHub, tag releases (`git tag v0.1.0 && git push --tags`). Never commit `.sqlite`,
`.env`, `.packet`, or backup files.

---

## 6. The full prompt for Claude Code

Paste the block below. It builds in safe, reviewable phases. After each phase, run, verify,
commit, then say "continue".

> ⚠️ Build phase by phase. Do not generate the whole app at once.

```text
You are helping me build a local-first, OFFLINE desktop ERP for a wholesale leather-products
company that operates SEVERAL BRANCHES, each on its own single PC, that sync by CARRYING A
FILE between them (pendrive / file-sharing) — there is no live network between branches. Read
this whole brief, then build in the numbered phases. STOP after each phase, summarize, and
wait for me to test and say "continue".

=== NON-NEGOTIABLE RULES ===
1. MONEY is never a JavaScript number. Store money as INTEGER paisa (taka×100); convert to
   decimal.js on read and back on write. No component does arithmetic on a raw number that is
   money. Put money helpers in packages/core with unit tests.
2. DOUBLE-ENTRY accounting. Every business event posts a journal entry where Σdebit=Σcredit,
   inside ONE transaction, via LedgerService.postEntry() which throws if unbalanced. Financial
   rows are never hard-deleted; corrections post a reversing entry.
3. BRANCH-OWNERSHIP SYNC. Every syncable record has: a global ULID id, a branch_code (owner),
   and a per-branch change_seq counter. A PC may EDIT only records whose branch_code == its own
   branch; it receives other branches' records as READ-ONLY via import. Imports may only
   add/update FOREIGN-branch rows and must NEVER modify this PC's own-branch rows. Imports are
   idempotent (re-importing the same packet changes nothing).
4. TypeScript strict everywhere; validate all inputs with Zod.

=== STACK ===
Monorepo (npm workspaces): apps/desktop (Electron), apps/ui (React+Vite+Tailwind+shadcn/ui),
apps/server (Fastify, runs IN-PROCESS on the same single PC), packages/core (money+domain),
packages/db (Drizzle over better-sqlite3), packages/sync (packet export/import + signing +
AES-256-GCM encryption). Auth: argon2 + session tokens + roles admin|manager|operator|viewer.
This is single-PC per install (no LAN server). Local backups via better-sqlite3 online backup /
VACUUM INTO, encrypted, scheduled with node-cron (daily/weekly/monthly/yearly + on close),
restore with hash verify + pre-restore safety backup.

=== SYNC DESIGN (packages/sync + SyncService in apps/server) ===
- On first launch, the install is assigned an immutable branch_code (e.g. DHAKA) stored in a
  this_install row, plus whether it is the HUB.
- EXPORT: produce a "sync packet" = signed + encrypted file containing the sender branch_code,
  the export watermark (last change_seq exported to that destination), and all of this branch's
  records with change_seq greater than the watermark, plus a manifest (counts + SHA-256).
- IMPORT: verify signature + SHA-256; reject if the packet's branch == this PC's own branch;
  upsert foreign-branch rows by ULID (idempotent); update sync_state and sync_log; stamp the
  import time so reports can show "BranchX data as of <date>".
- HUB MODE: the hub imports packets from all branches, then exports ONE combined packet
  containing every branch's latest data; branches import that to see the whole company.
- SHARED PRODUCTS: product list is mastered at the hub. A branch may create a PROVISIONAL local
  product (keyed by its own branch, no collision); the hub can MERGE a provisional into the
  master list and map provisional_id -> master_id, propagated on the next combined packet.
- PARTIES carry owner branch_code or SHARED (shared parties mastered at hub).

=== DATA MODEL (Drizzle, packages/db) ===
branches; this_install; users; accounts (chart of accounts); parties (owner branch_code or
SHARED); products (shared, is_provisional, master_id); stock_moves (per branch); journal_entries
(+ branch_code) + journal_lines (sum to zero); purchases + purchase_items; sales + sale_items;
payments (in/out); expenses; daily_closing (per branch); sync_state; sync_log; backups; settings;
audit_log. Money columns INTEGER paisa. Syncable tables include id(ULID), branch_code, change_seq,
is_deleted, created_at/updated_at/created_by. Seed: standard chart of accounts + one admin user.

=== DOMAIN EVENTS (each posts one balanced journal entry, stamped with this branch_code) ===
Purchase on credit: Dr Inventory, Cr Accounts Payable(party) + stock_move IN.
Payment to supplier: Dr Accounts Payable(party), Cr Cash/Bank.
Sale: Dr Cash or Accounts Receivable(party), Cr Sales Revenue; AND Dr COGS, Cr Inventory;
  + stock_move OUT at cost.
Receipt from customer: Dr Cash/Bank, Cr Accounts Receivable(party).
Goods return: reversing entry of the original.
Expense: Dr Expense, Cr Cash. UI labels are clean English (Due, Payment, Goods Return, Sale,
Purchase) — not the old transliterated terms.

=== FEATURES / SCREENS ===
Auth (first run creates admin; login/logout; manage users admin-only).
Branch setup on first launch (choose branch_code, hub or not).
Dashboard: today's sales/purchases/expenses, cash in hand, receivables, payables, low-stock;
  30-day sales-vs-purchases chart; branch filter (this/other/whole company); shows last sync
  date per branch.
Purchases: list + entry form (own branch only editable); supplier statement.
Sales: list + entry form mirroring purchases; customer statement.
Daily: day view combining the day's purchases, sales, expenses + cash balance-forward.
Accounting: Journal, Ledger, Cash Book, Bank Book, Trial Balance — derived from journal_lines,
  always balancing, filterable per branch or whole company.
Reports: Daily Sales, Daily Purchase, Customer/Supplier Statement, P&L over a date range, each
  with This-Branch / chosen-branch / Whole-Company scope and an "as-of last sync" note;
  printable to PDF + export CSV.
Inventory: products CRUD (provisional vs master), stock on hand, valuation, low-stock, manual
  adjustments — stock is per branch.
Sync Center: Export packet (to file), Import packet (from file), view sync_log and per-branch
  last-sync timestamps; hub-only "build combined packet" and "merge provisional products".
Settings: business profile, fiscal-year start, this branch identity, users, backup config,
  manual backup, restore, sync encryption passphrase / signing key.

=== BUILD PHASES (STOP after each) ===
Phase 1  Monorepo scaffold; TS strict; ESLint/Prettier; .gitignore; README; packages/core
         money helpers WITH UNIT TESTS (0.1+0.2 exact, paisa round-trips). Add a ULID helper.
Phase 2  packages/db: full Drizzle schema incl. branch_code/change_seq/ULID columns; migrations;
         seed (chart of accounts + admin). Script to create a fresh shop.sqlite and inspect it.
Phase 3  apps/server: Fastify in-process; better-sqlite3 in WAL mode; auth (argon2 + sessions +
         roles); this_install/branch bootstrap; LedgerService.postEntry() with tests rejecting
         unbalanced entries and committing balanced ones atomically.
Phase 4  Domain services + REST routes for parties, products, purchases, sales, payments,
         expenses — each via LedgerService, each stamping this branch_code and bumping change_seq.
         A guard that blocks edits to foreign-branch rows. Zod validation. Tests for sale and
         purchase postings (verify ledger balances + stock).
Phase 5  packages/sync + SyncService: export packet, import packet, signing, AES-256-GCM
         encryption, idempotency, sync_state/sync_log. TESTS: round-trip a packet between two
         temp DBs (DHAKA -> CTG), assert CTG gains DHAKA's read-only rows, own rows untouched,
         re-import is a no-op, and combined P&L sums both. Hub combined-packet build + provisional
         product merge with tests.
Phase 6  apps/ui shell (React+Vite+Tailwind+shadcn/ui), routing, auth + first-run branch setup,
         API client. Dashboard, Purchases, Sales screens.
Phase 7  Accounting screens (Journal, Ledger, Cash/Bank Book, Trial Balance) and Reports (Daily
         Sales/Purchase, Statements, P&L) with branch/company scope, "as-of sync" notes, PDF+CSV.
Phase 8  Inventory screens; Daily day-view with cash balance-forward; Sync Center UI (export/
         import/log, hub tools).
Phase 9  Local backup system (snapshot+encrypt+schedule+prune+restore) and Backups screen.
Phase 10 Electron shell: first-run branch/hub selector, launch server in-process, package a
         Windows installer (electron-builder .msi/.exe). Smoke-test a full install + a real
         DHAKA->CTG file sync end to end.

For each phase: write code, add the stated tests, run them, show me how to verify, list exact
git commit commands, then STOP. Keep components small. Ask before adding any dependency not
implied above.
```

---

## 7. Build order for you (the human)

1. Do Part 5 setup; push the empty repo.
2. Run the Part 6 prompt; finish **Phase 1** and confirm money tests pass (foundation proof).
3. Phase by phase, commit + push after each. Pay special attention to **Phase 5's sync tests** —
   that DHAKA→CTG round-trip test is your proof the sync is safe before any UI exists.
4. Tag `v0.1.0` after Phase 6 (first usable), `v1.0.0` after Phase 10.
5. Pilot: enter one month of real data on two PCs, sync via pendrive, and reconcile each
   branch's trial balance and the combined company P&L against reality before cutover.

## 8. Open questions to refine later
- **BDT-only** assumed for v1 — confirm no multi-currency.
- Any **VAT/tax** on invoices?
- Do invoices/statements need a **specific print layout / letterhead**?
- **License key** per install to stop unpaid copying (you're reselling — worth adding early).
- Should the **hub be fixed** (always head office) or movable? (Fixed is simpler and safer.)
- Provisional products: is the hub the **only** place allowed to create permanent master
  products, or can a designated branch also do it? (Single master source is safest.)
- Should combined reports **block** if a branch's data is older than N days (stale-sync guard)?
