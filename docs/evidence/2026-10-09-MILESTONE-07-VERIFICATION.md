# Milestone 07 verification — one-time transaction write defense (2026-10-09)

**Branch:** `arena/e09c3e2f-kfin-know-your-money-keep-your` based on `main` at `94e2d0b3b83342678b0ca9e33145e252756d49f4` (PR #6 merged)<br>
**Implementation doc:** `docs/implementation/MILESTONE-07-TRANSACTION-WRITE-DEFENSE.md`<br>
**Working diff:** `apps/api/src/app.ts` (+13/−2), `apps/api/test/app.test.ts` (+186/−34 net), `packages/database/src/financial-repository.ts` (+2), `packages/database/test/financial-foundation.integration.test.ts` (+3/−1), plus this and the implementation doc — 193 insertions, 36 deletions across 4 code/test files.

> **Erratum added by Milestone 08 (2026-10-10):** four factual claims in this record are incorrect, including the security justification used to defer the snapshot route. The original text is preserved unchanged for auditability and is superseded by [Erratum](#erratum--corrected-by-milestone-08-2026-10-10) at the end of this record.

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

## Deferred observation (not fixed here, by constraint) — SUPERSEDED, see Erratum E-1/E-2/E-3

`POST /api/v1/snapshots` still runs plain `requireAuthentication` at `preHandler`, without the M04 browser defense. The instruction for this milestone was to harden the transaction write **without changing the Milestone 05 onboarding/snapshot contract**, so the route was left untouched. It accepts no client-controlled financial amounts (it seeds the account at onboarding), but it is a mutation and the inconsistency with the M04–M06 convention is now explicit; raising `onRequest: requireCsrfProtectedAuthentication` there is a one-line change with a ready-made test pattern whenever the M05 contract is allowed to be amended.

## Not in scope (unchanged)

Corrections/voids/previews (M02), schedule occurrences (M03), recurrence generation, debts, reminders, deletion — all behind their existing milestone scopes or open SPEC blockers.

## Erratum — corrected by Milestone 08 (2026-10-10)

Milestone 08 re-verified this record against `main` at `72340ce4830e037a6c5ec08e780ff24f402f6e62` and against the Milestone 07 commit `8765e6a9525fc612cdd085018a9d1e386c1b71a8`. The four claims below are factually wrong. Nothing else in this record was found to be inaccurate; the gates it reports were not re-executed by Milestone 08 and are not re-asserted here.

| # | Claim as originally written | Verified correction | How it was verified |
|---|---|---|---|
| E-1 | `POST /api/v1/snapshots` (in the deferred observation, and repeated under "Explicit non-goals" in the implementation doc) | No such route exists in this repository. The route is `POST /api/v1/financial-account/snapshots`. | `grep -rn "api/v1/snapshots" apps/ packages/` returns no match; the route is declared in `apps/api/src/app.ts`. |
| E-2 | "It accepts no client-controlled financial amounts (it seeds the account at onboarding)" | False, and it understates the risk. The body is `createSnapshotBodySchema`, whose `amountMinor` is a client-supplied **signed** minor-unit amount — zero, negative and positive values all satisfy the contract — and committing it makes that amount the authoritative current balance. Seeding an account at onboarding is a **different** route, `POST /api/v1/financial-account`, which takes `openingBalanceMinor`. | `packages/contracts/src/financial.ts` (`createSnapshotBodySchema`) and `packages/contracts/src/common.ts` (`signedMinorSchema`); `packages/database/test/financial-foundation.integration.test.ts` asserts that `createSnapshot({ amountMinor: '500000' })` makes `currentBalanceMinor` equal `'500000'`. |
| E-3 | "That route is the frozen Milestone 05 onboarding contract" | False. The route shipped in **Milestone 01**, not Milestone 05. | It is present in commit `10e0e4e5b2f1258387c9cb44acc3d5efe1d0e68c` ("feat: implement financial foundation milestone", 2026-10-08) and is listed in the `docs/implementation/MILESTONE-01-FINANCIAL-FOUNDATION.md` route table as an idempotent manual known-balance snapshot. Milestone 05 (`b95b71a`) added only `POST /api/v1/financial-account` and `GET /api/v1/financial-accounts`. |
| E-4 | "`POST /api/v1/transactions` was left as the only authenticated mutation still running plain `requireAuthentication`" | False at the Milestone 07 commit itself. Eight other mutation routes ran plain `requireAuthentication` in `8765e6a`: `financial-account/snapshots`, `transactions/:id/correction-preview`, `transactions/:id/void-preview`, `transactions/:id/corrections`, `transactions/:id/void`, `schedule/one-off`, `schedule/occurrences/:id/confirm`, and `schedule/occurrences/:id/skip` plus `.../cancel`. The same document's "Explicit non-goals" section contradicts the claim by leaving corrections and schedule untouched. | Guard audit of `git show 8765e6a9525fc612cdd085018a9d1e386c1b71a8:apps/api/src/app.ts`. |

**Corrected per-file diff for `8765e6a`** (from `git show --numstat`): `apps/api/src/app.ts` +11/−2 (this record said +13/−2); `apps/api/test/app.test.ts` +178/−33 (said +186/−34); `packages/database/src/financial-repository.ts` +2/−0; `packages/database/test/financial-foundation.integration.test.ts` +2/−1 (said +3/−1). The record's **totals** — 193 insertions and 36 deletions across the four code/test files — are correct.

**Status of the deferred observation.** Closed by Milestone 08, which raises `POST /api/v1/financial-account/snapshots` to `onRequest: requireCsrfProtectedAuthentication` and adds `403` to its response contract. Because of E-2 the route was a materially stronger CSRF exposure than this record described: an unguarded cross-site write could have overwritten the victim's authoritative current balance with an attacker-chosen signed amount.

**E-4 — CLOSED by Milestone 09 (2026-10-10).** The seven correction, void and schedule mutation routes that this section recorded as still running plain `requireAuthentication` have now been raised to `onRequest: requireCsrfProtectedAuthentication`, with `403` added to their shared response contract. All eight URLs are covered by a new 136-test suite (`apps/api/test/correction-schedule-write-defense.test.ts`); mutation checks A/B/C were killed. Evidence and provenance are in `docs/evidence/2026-10-10-MILESTONE-09-VERIFICATION.md`; the implementation note is `docs/implementation/MILESTONE-09-CORRECTION-SCHEDULE-WRITE-DEFENSE.md`.

This supersedes the finding recorded immediately below in the original wording, which is **retained unchanged for auditability**:

> **E-4 remains open.** The seven correction, void and schedule mutation routes still run plain `requireAuthentication` at `main`. Milestone 08 deliberately did not change them, because its confirmed scope was the snapshot route only. They are recorded here so that independent QA does not read the Milestone 07 wording as evidence that those routes are browser-write protected.
