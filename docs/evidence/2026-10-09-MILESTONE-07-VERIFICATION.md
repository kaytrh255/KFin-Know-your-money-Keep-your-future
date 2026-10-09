# Milestone 07 verification — one-time transaction write defense (2026-10-09)

**Branch:** `arena/e09c3e2f-kfin-know-your-money-keep-your` based on `main` at `94e2d0b3b83342678b0ca9e33145e252756d49f4` (PR #6 merged)<br>
**Implementation doc:** `docs/implementation/MILESTONE-07-TRANSACTION-WRITE-DEFENSE.md`<br>
**Working diff:** `apps/api/src/app.ts` (+13/−2), `apps/api/test/app.test.ts` (+186/−34 net), `packages/database/src/financial-repository.ts` (+2), `packages/database/test/financial-foundation.integration.test.ts` (+3/−1), plus this and the implementation doc — 193 insertions, 36 deletions across 4 code/test files.

## Scope statement

Milestones 01–02 already shipped create/list of manual one-time transactions with idempotency, validation, owner scoping, snapshot anchoring, and historical-only invariants. This milestone verified those behaviors against the brief's acceptance criteria (they pass) and closed the single remaining defense gap: `POST /api/v1/transactions` was the one authenticated mutation still on plain `requireAuthentication`, predating the Milestone 04 browser defense that M04/M05/M06 apply to every other mutation. The replay marker computed by the persistence layer is now also exposed to clients as `Idempotency-Replayed: true`.

## Gates executed (commands and real results)

Run from the repository root against the uncommitted working tree on 2026-10-09 (Asia/Saigon):

| Gate | Command | Result |
|---|---|---|
| Typecheck | `corepack pnpm run typecheck` | clean, exit 0 |
| Evidence + unit | `corepack pnpm run check` | evidence gate: "Checked 25 JavaScript modules and 29 harness files", 16 harness checks pass, 0 fail; tests: 19 passed, 6 skipped files; **286 passed, 59 skipped, 0 failed** |
| Integration (real PG) | `TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:5444/postgres' KFIN_INTEGRATION_TARGET='non-production' corepack pnpm run test:integration` | 6 files, **59/59 passed** (PostgreSQL 16.2, pgserver bundle) |
| Fresh-schema ledger | `pnpm --filter @kfin/database run migrate` with `MIGRATION_DATABASE_URL=…/kfin_m07_ledger` (fresh database) | "Applied 6 KFin migration(s)"; `kfin_migrations` rows `0001`–`0006` each with a recorded sha256 checksum; core tables `transactions`, `idempotency_results`, `savings_goals` present. **M07 adds no migration.** |
| Targeted API suite | `vitest run apps/api/test/app.test.ts` | 22/22 passed, including the 11-test Milestone 07 regression block |

### Mutation check (practical, executed)

`git stash push -- apps/api/src/app.ts` (removing the guard upgrade, replay header wiring, and explicit send) then re-running `apps/api/test/app.test.ts` produced **exactly 11 failures and no collateral damage**: the six-case `403` defense matrix (missing token, wrong token, foreign Origin, lookalike Origin, cross-site `Sec-Fetch-Site`, no markers), the cross-site `text/plain` rejection-before-parsing case, both fail-closed cases (session without `csrfDigest`; auth service without a verifier), the replay-vs-original `Idempotency-Replayed` header assertions, and the owner-scope happy path (the pre-M07 handler forwarded the raw repository result, which — now carrying `replayed` — no longer satisfies the strict response schema and 500s). The `401`-unauthenticated test stayed green under the mutation, confirming the failure set maps to the removed behavior. `git stash pop` restored the change (diff intact) and the suite returned to 22/22 green. The guard change is test-killed; the tests are not tautological.

### Integration catch made during this verification

The first integration run failed one assertion: `financial-foundation.integration.test.ts` compared a replay result for deep equality with the original, and the original now truthfully reports `replayed: false` vs the replay's `replayed: true`. The assertion was **strengthened**, not weakened: it now requires the original to carry `replayed: false`, the replay to return identical identifiers with `replayed: true`, and the stored `idempotency_results` receipt to remain `{ transactionId, financialStateVersion }` only. After re-run: 59/59.

## Acceptance criteria traceability (brief)

| Criterion | Status | Where proven |
|---|---|---|
| Create via authenticated API with lifecycle fields | Pass (pre-existing, re-verified) | `app.test.ts` happy-path 201 with bearer session; integration `financial-foundation` test |
| Owner from session, never client body; cross-user access impossible | Pass (pre-existing + regression) | strict schema strips `userId`; `getTransaction` owner check → `FINANCIAL_RESOURCE_UNAVAILABLE` (unit + integration) |
| Deterministic failures: invalid amounts/classifications/dates/currency/malformed body | Pass (pre-existing, re-run) | M01/M02 matrices in `app.test.ts`, `financial-accounts.test.ts`, domain tests — 286 unit + 59 integration all green |
| Duplicate enforcement / idempotency on the write | Pass (pre-existing, now observable) | repository envelope `replayed` surfaced; `Idempotency-Replayed: true` header; receipt unchanged on replay (integration) |
| Current-impact reconciles with snapshot anchor; historical-only never changes current balance | Pass (pre-existing, re-run) | M01/M02 integration suites (`financial-foundation`, `financial-corrections`) 59/59 |
| Browser-write defense on the mutation (M04 convention) | **Closed by this milestone** | 11-test M07 block; mutation check above |
| No migration changes / forward-only | Pass | no new migration file; fresh DB applies `0001`–`0006` with checksums |
| Reuse existing auth/error conventions | Pass | `requireCsrfProtectedAuthentication`, `errorResponseSchema` `403` contract entry only |
| No float money math, no secrets, no unsafe logging | Pass | amounts stay BIGINT string minor units; commit contains no secrets (routes altered only) |
| No M04–M06 regression | Pass | full unit gate (286) + integration (59) green, auth/access, account onboarding, savings suites untouched and green |

## Deferred observation (not fixed here, by constraint)

`POST /api/v1/snapshots` still runs plain `requireAuthentication` at `preHandler`, without the M04 browser defense. The instruction for this milestone was to harden the transaction write **without changing the Milestone 05 onboarding/snapshot contract**, so the route was left untouched. It accepts no client-controlled financial amounts (it seeds the account at onboarding), but it is a mutation and the inconsistency with the M04–M06 convention is now explicit; raising `onRequest: requireCsrfProtectedAuthentication` there is a one-line change with a ready-made test pattern whenever the M05 contract is allowed to be amended.

## Not in scope (unchanged)

Corrections/voids/previews (M02), schedule occurrences (M03), recurrence generation, debts, reminders, deletion — all behind their existing milestone scopes or open SPEC blockers.
