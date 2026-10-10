# Milestone 08 verification — snapshot write defense, transaction read boundary, and M07 evidence erratum (2026-10-10)

**Branch:** `arena/04ded918-kfin-know-your-money-keep-your`, based on `main` at `72340ce4830e037a6c5ec08e780ff24f402f6e62` (PR #7 merged)<br>
**Recorded:** 2026-10-10 (Asia/Saigon)<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2` (unchanged)<br>
**Production readiness:** Not claimed

> **Provenance warning — read first.** A previous session reported a Milestone 08 commit `c97bc892649a25caa44860c19290e52344afbea4` with tree `1e26cd31dc715d365cc2b85b023ea2cb604a896d` (7 files, 398 insertions / 10 deletions) and local results of "unit 305/305, PostgreSQL 60/60, mutation 9/9, ledger 6/6, evidence 13/16". That commit and that tree **do not exist** locally or on GitHub (`git cat-file` fatal; GitHub API `404` for both the tree and the commit; the tree is not the tree of any commit on any of the seven remote branches; no stash, no dangling object, no patch file anywhere in the workspace). **None of those numbers are reused, restated, or relied on as evidence in this record.** Milestone 08 was re-implemented from scratch against `main`, and every result below was produced by the commands shown, on this branch, on 2026-10-10.

## Scope statement

Four items, all confirmed against `main` before implementation. No feature work beyond them.

| # | Item | State at `main` before this milestone |
|---|---|---|
| 1 | CSRF defense on `POST /api/v1/financial-account/snapshots` | **Gap.** The route ran plain `preHandler: requireAuthentication` while `POST /api/v1/financial-account` (M05), `POST /api/v1/transactions` (M07) and all six savings mutations (M06) ran `onRequest: requireCsrfProtectedAuthentication`. M07 recorded this exact route as a deferred observation. |
| 2 | API read-boundary tests for transaction reads | **Gap.** `GET /api/v1/transactions` had **zero** API-level tests; `GET /api/v1/transactions/:id` had exactly one owner-scoping assertion. No query/path validation coverage existed anywhere in `apps/api/test`. |
| 3 | PostgreSQL integration tests for cursor pagination, filters, owner isolation | **Gap.** `listTransactions` was touched only incidentally, by one drilldown assertion inside `financial-corrections.integration.test.ts`. Pagination, filters and list-level owner isolation were untested against a real database. |
| 4 | M07 evidence erratum | **Necessary.** Four claims in the M07 record were contradicted by the code and by git history. See [Erratum applied](#erratum-applied-to-the-milestone-07-record). |

**No migration and no persisted-schema change.** `packages/database/migrations/` is byte-identical to `main` (6 files, `git status --porcelain packages/database/migrations/` empty). `package.json` and `pnpm-lock.yaml` are unchanged — the local PostgreSQL used for integration evidence was installed **outside** the repository, in `/home/user/.pgtool`, precisely so no manifest or lockfile would be edited to make the environment work.

## Environment

- Node.js `v22.22.3`, pnpm `10.34.6` via Corepack, `corepack pnpm install --frozen-lockfile`.
- **PostgreSQL 17.6** (`server_version = 17.6`), matching the CI service image `postgres:17.6-alpine` on major.minor.
- **Database target proven before every migration and test run**, by querying the server itself: `current_database = kfin_test`, `inet_server_addr = 127.0.0.1/32`, `inet_server_port = 5433`, `data_directory = /home/user/.pgtool/pgdata`, `encoding = UTF8`, `public tables = 0` (pristine before use). A second throwaway database `kfin_m08_ledger` was created fresh for the migration ledger gate.
- **No Supabase or production database was contacted.** No Supabase/production connection string exists anywhere in the repository or the environment (`grep` for `supabase|DATABASE_URL|postgres://` outside `TEST_DATABASE_URL`/`MIGRATION_DATABASE_URL` matches documentation prose only); there is no `.env` file; `DATABASE_URL` is unset in the shell. Both databases used are local, sandbox-private, bound to `127.0.0.1`, and disposable. Nothing was dropped, truncated or rewritten outside those two throwaway databases.
- Integration tests were **executed, not skipped**: `describe.skipIf` was satisfied by `TEST_DATABASE_URL` plus `KFIN_INTEGRATION_TARGET=non-production`, and the run reports `0 skipped`.

## What changed

1. **`apps/api/src/app.ts` (+8/−1).** `POST /api/v1/financial-account/snapshots` moved from `preHandler: requireAuthentication` to `onRequest: requireCsrfProtectedAuthentication`, and `403: errorResponseSchema` was added to its response contract. No handler logic changed. This is the same one-line guard convention M05/M06/M07 apply, so the route now rejects an unauthenticated caller with `401` and a cross-site or token-less caller with `403` **before content-type parsing** — an HTML form or malformed body is never interpreted. It fails closed when the session carries no `csrfDigest` or no CSRF verifier is configured.
2. **`apps/api/test/app.test.ts` (+4/−6).** One pre-existing test, "returns only stable safe errors and retry guidance", posted to the snapshot route without CSRF wiring and asserted `503`. Because the route is now guarded, that test would have received `403`. It was re-wired to the existing CSRF-protected app builder and the browser headers the guard requires. **Its intent is unchanged and its assertions were not weakened** — it still requires `503`, `Retry-After: 1`, and a body free of the injected `SQL` detail. The 11-test Milestone 07 regression block is untouched and still passes 22/22 in that file.
3. **`apps/api/test/financial-snapshots.test.ts` (new, 18 tests).** The snapshot defense matrix: authorized happy path with owner taken from the principal; same-site Fetch Metadata accepted without `Origin`; `401` before any CSRF or body handling, including an unauthenticated form POST; the six-case `403 AUTH_CSRF_FAILED` matrix (missing token, wrong token, foreign `Origin`, lookalike `Origin`, cross-site `Sec-Fetch-Site`, no markers); three cross-site content types rejected before body parsing; both fail-closed cases; owner-hint rejection; missing `Idempotency-Key`; and `403` published in the route's OpenAPI contract.
4. **`apps/api/test/transaction-reads.test.ts` (new, 37 tests).** The transaction read boundary in three groups — authentication (`401` with no principal, `401` for a malformed principal identifier, and no CSRF required on a safe method even from a cross-site `Origin`); owner scoping (owner taken only from the principal with the page default applied, `userId`/`ownerId`/`accountId`/`owner_user_id` query aliases rejected by the strict contract, header owner hints ignored, BOLA-resistant object lookup, and a stable `404` that leaks neither the owner identifier nor the injected cause); and validation (19 rejected query/path cases, both inclusive `limit` bounds accepted, full filter pass-through with absent filters omitted, opaque `nextCursor` serialization, malformed path identifier, and two strict-response-serialization cases).
5. **`packages/database/test/financial-transaction-reads.integration.test.ts` (new, 5 tests, real PostgreSQL).** A declarative 11-row dataset per owner — spanning two months, three expense categories plus income, and both balance effects — with **six rows sharing the local date 2026-10-08** so that page breaks fall inside a same-day group. Covers keyset pagination completeness (page-of-two walk must equal the unpaginated order exactly, with no repeats and the expected page count), the `occurred_on DESC, id DESC` ordering contract, `nextCursor` presence only when another page exists, every filter individually and composed with pagination, owner isolation across the page / the cursor / the object lookup (including a cursor keyed on another owner's row), and repository-boundary rejection of invalid limits and forged cursors.
6. **Docs.** The M07 erratum (below) and this record.

## Gates executed (commands and real results)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `corepack pnpm run typecheck` | **PASS** — clean, exit 0 |
| Evidence harness (static) | `corepack pnpm run evidence:check` | **PASS** — "Checked 25 JavaScript modules and 29 harness files.", exit 0 |
| Evidence harness (tests) | `corepack pnpm run evidence:test` | **PASS** — 16 pass, 0 fail, 0 skipped |
| Unit + API | `corepack pnpm run test:unit` | **PASS** — 21 files, **341 passed, 0 failed, 0 skipped** |
| Integration (real PG 17.6) | `TEST_DATABASE_URL='postgresql://…@127.0.0.1:5433/kfin_test' KFIN_INTEGRATION_TARGET='non-production' corepack pnpm run test:integration` | **PASS** — 7 files, **64 passed, 0 failed, 0 skipped** |
| Migration ledger (fresh DB) | `MIGRATION_DATABASE_URL='…/kfin_m08_ledger' DATABASE_SSL_MODE=disable corepack pnpm --filter @kfin/database run migrate` | **PASS** — "Applied 6 KFin migration(s)." |
| Migration ledger integrity | independent recompute of each file's sha256 vs `kfin_migrations.checksum` | **PASS** — 6 rows, all six checksums match; core tables present (`balance_snapshots`, `financial_accounts`, `idempotency_results`, `savings_goals`, `sessions`, `transactions`, `users`) |
| Migration idempotency | same command re-run on the migrated database | **PASS** — "Applied 0 KFin migration(s)." |
| Combined gate | `TEST_DATABASE_URL='…/kfin_test' KFIN_INTEGRATION_TARGET='non-production' corepack pnpm run check` | **PASS** — evidence static + 16 harness tests + clean typecheck + 28 test files, **405 passed, 0 failed, 0 skipped** (341 unit/API + 64 integration), exit 0 |

**Baseline vs. result.** Measured on `main` before any edit: typecheck clean, unit **286** passed / 19 files, integration **59** passed / 6 files (0 skipped), evidence 16/16. After Milestone 08: unit **341** / 21 files, integration **64** / 7 files. The deltas are exactly the 55 new unit/API tests and 5 new integration tests this milestone adds (286 + 55 = 341; 59 + 5 = 64). No previously passing test was removed, skipped, or weakened.

## Mutation check (executed, including one honest survivor)

Each mutation was applied to the working tree, the relevant suite re-run, and the file restored. Restorations were verified with `git status --porcelain`.

| Mutation | Change | Result |
|---|---|---|
| A | `listTransactions`: `WHERE txn.user_id = $1` → `WHERE $1::uuid IS NOT NULL` (owner scoping removed) | **KILLED** — 4 of 5 integration tests failed |
| B | `listTransactions`: `nextCursor` forced to `null` | **KILLED** — 3 of 5 failed |
| C | `listTransactions`: `ORDER BY txn.occurred_on DESC, id DESC` → `ORDER BY txn.occurred_on DESC` (tie-break dropped) | **SURVIVED** — 5 of 5 still passed. See below. |
| D | `listTransactions`: tie-break reversed to `txn.id ASC` | **KILLED** — 2 of 5 failed |
| E | `listTransactions`: `txn.occurred_on ASC` | **KILLED** — 3 of 5 failed |
| F | `POST /api/v1/financial-account/snapshots` guard reverted to plain `requireAuthentication` | **KILLED** — 12 tests failed, all confined to `financial-snapshots.test.ts`; `app.test.ts` stayed 22/22 green, so the failure set maps exactly to the removed behavior with no collateral |

**Mutation C is a real survivor and is reported as such, not as a pass.** The reason is a schema fact, verified on the migrated database:

```
transactions_activity_idx = CREATE INDEX transactions_activity_idx
  ON public.transactions USING btree (user_id, occurred_on DESC, id DESC)
```

That covering index already supplies `id DESC` within each `occurred_on` group, so removing the tie-break from the `ORDER BY` clause leaves the returned order observably unchanged on this schema and this plan. No black-box ordering assertion can distinguish the two. The initial version of this suite had only two same-day rows and survived mutation C for the same reason; the fixture was strengthened to six same-day rows with page breaks inside that group, which is what makes mutations D and E detectable — but C remains equivalent-by-index rather than killed. The `id DESC` in the query is therefore **defensive and explicit** rather than independently test-proven: it keeps the keyset predicate `(occurred_on, id) < (cursor)` correct if the index or the plan ever changes. Independent QA should treat the tie-break as index-dependent, not test-proven.

## Erratum applied to the Milestone 07 record

Verified against the code at `main` and against `git show 8765e6a9525fc612cdd085018a9d1e386c1b71a8`. Corrections were **appended** to `docs/evidence/2026-10-09-MILESTONE-07-VERIFICATION.md` as a marked Erratum section (E-1…E-4), with a pointer at the top of that record and in `docs/implementation/MILESTONE-07-TRANSACTION-WRITE-DEFENSE.md`. The original M07 wording was deliberately left intact for auditability.

| # | M07 claim | Verified correction |
|---|---|---|
| E-1 | `POST /api/v1/snapshots` | No such route exists. The route is `POST /api/v1/financial-account/snapshots`. |
| E-2 | "It accepts no client-controlled financial amounts (it seeds the account at onboarding)" | False, and it understated the risk. `createSnapshotBodySchema.amountMinor` is a client-supplied **signed** minor-unit amount, and committing it makes that amount the authoritative current balance — `financial-foundation.integration.test.ts` asserts `createSnapshot({ amountMinor: '500000' })` yields `currentBalanceMinor = '500000'`. Onboarding seeding is a different route (`POST /api/v1/financial-account`, `openingBalanceMinor`). |
| E-3 | "That route is the frozen Milestone 05 onboarding contract" | False. The route shipped in **Milestone 01**: it is present in `10e0e4e` ("feat: implement financial foundation milestone") and is listed in the `MILESTONE-01-FINANCIAL-FOUNDATION.md` route table. M05 added only `POST /api/v1/financial-account` and `GET /api/v1/financial-accounts`. |
| E-4 | "`POST /api/v1/transactions` was left as the only authenticated mutation still running plain `requireAuthentication`" | False at the M07 commit itself: eight other mutation routes ran plain `requireAuthentication` in `8765e6a`. The same document's "Explicit non-goals" contradicts the claim. |

The M07 record's per-file diff figures were also wrong (`app.ts` +13/−2 vs. actual +11/−2; `app.test.ts` +186/−34 vs. actual +178/−33; `financial-foundation.integration.test.ts` +3/−1 vs. actual +2/−1), while its **totals** of 193 insertions and 36 deletions across the four code/test files are correct.

Because of E-2, the snapshot route was a materially stronger CSRF exposure than the M07 record described: an unguarded cross-site write could have overwritten the victim's authoritative current balance with an attacker-chosen signed amount. Item 1 of this milestone closes it.

## Findings deliberately left open (not fixed here, out of confirmed scope)

- **E-4 is still open.** Seven mutation routes still run plain `requireAuthentication` at `main`: `transactions/:id/correction-preview`, `transactions/:id/void-preview`, `transactions/:id/corrections`, `transactions/:id/void`, `schedule/one-off`, `schedule/occurrences/:id/confirm`, and `schedule/occurrences/:id/skip` plus `.../cancel`. Extending the guard to them was **not** in the confirmed Milestone 08 scope, so it was not done. Recorded here so QA does not read the M07 wording as evidence that they are protected.
- **The snapshot route does not emit `Idempotency-Replayed`.** `PostgresFinancialRepository.createSnapshot` returns `{ snapshotId, financialStateVersion }` and drops the `replayed` marker its serializer envelope computes, unlike `createTransaction` and `openFinancialAccount`. Surfacing it would require a `CreateSnapshotResult` type change, which is beyond item 1 (CSRF defense) and was not made.
- No specification, SDD, ADR, roadmap, test-strategy, or governance document was created or modified. `docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md` does not track milestone evidence, so it was left untouched. No `SPEC-*` blocker is closed by this milestone, and `SPEC-FIN-02` closure evidence still requires a dedicated non-production Supabase project, which was not available here.

## Not claimed

No owner approval, ADR acceptance, blocker closure, production readiness, Supabase result, or `FIN-RACE` PASS is implied. The prior session's Milestone 08 numbers are disclaimed above and appear nowhere in this record as results.
