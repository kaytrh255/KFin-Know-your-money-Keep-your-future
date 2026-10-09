# Milestone 06 — savings goals: QA addendum (F-1/F-2/F-3)

**Date:** 2026-10-09<br>
**Base:** PR #6 head `25165715200af9c5d1d2b0ba59a70a507090f63a` on `main` `422593acbdf9df70d0674175b21aa562459870c3`<br>
**Supplements:** [2026-10-09-MILESTONE-06-VERIFICATION.md](2026-10-09-MILESTONE-06-VERIFICATION.md) (unchanged)<br>
**Production readiness:** Not claimed

This addendum covers three QA findings raised against the Milestone 06 pull
request and their fixes. Every command below was actually run in the
development sandbox: Node 22, pnpm through Corepack, and a local non-production
PostgreSQL 16.2 server (multi-backend, unix socket). Each integration suite
migrates into its own isolated schema and drops it afterwards. CI for the
commit runs on PostgreSQL 17.6 and is recorded on the pull request, not here.

## Findings, root causes, and fixes

| # | Finding | Root cause | Fix |
|---|---|---|---|
| F-1 | A goal name or reason containing a NUL character returned `503 FIN_DATABASE_UNAVAILABLE` | `normalizeSavingsGoalName` / `normalizeSavingsReason` passed NUL through; PostgreSQL rejected the parameter with SQLSTATE `22021` (verified on real PostgreSQL: `invalid byte sequence for encoding "UTF8": 0x00`), and `mapDatabaseError` had no `22021` mapping, so the generic `FIN_DATABASE_UNAVAILABLE` mapping answered 503 | Domain rejects NUL with `422 SAVINGS_GOAL_INVALID` before any database I/O; `mapDatabaseError` now maps `22021` to the same 422 as defense in depth |
| F-2 | The database accepted forged amount history whose declared previous amount did not match the goal's own prior amount | The 0005 row guard pinned a change row to the goal's **current scalar state** (version, amount, as-of) but never checked the **history chain**. A plan edit or archive advances the version without a change row, so a forged row for such a version matched every scalar field while inventing any previous amount | Migration `0006` replaces the guard used by the existing BEFORE INSERT trigger: version 1 opens the chain (previous must be NULL); a later version's `previous_amount_minor` must equal the `new_amount_minor` of the newest earlier change row of that goal, and such a row must exist |
| F-3 | The database accepted history attributing an amount change to a user who does not own the goal | `actor_user_id` carried only `REFERENCES users(id)`; any existing user passed | Migration `0006` additionally requires `actor_user_id = user_id` (the goal owner) whenever a user actor is set; the operator path (`actor_operator_id` set, user NULL) from 0005 is unchanged |

Migration `0005` is byte-identical to the reviewed file; a contract test now
freezes its SHA-256 (`58f264e3…918e`), and the runtime migrator independently
verifies the same checksum before applying `0006`.

## Regression proof (tests failed before the fix, pass after it)

Each new regression test was run against the pre-fix code (fix reverted, tests
kept) and then against the fixed code on real PostgreSQL.

**Pre-fix (mutation run, 2026-10-09):**

- `answers 422 SAVINGS_GOAL_INVALID … (QA F-1)` — **failed**: the repository
  rejected with `FinancialError { code: "FIN_DATABASE_UNAVAILABLE", statusCode: 503 }`,
  reproducing the finding verbatim.
- `rejects NUL characters in names and reasons … (QA F-1)` (domain unit) —
  **failed**: no error was thrown.
- `rejects forged history whose previous amount does not continue the goal
  chain (QA F-2)` — **failed**: the forged INSERT committed
  (`previous_amount_minor = 666` while the goal's own history held 2 500 000).
- `rejects history whose user actor is not the goal owner (QA F-3)` —
  **failed**: the forged INSERT committed with a stranger's `actor_user_id`,
  while the truthful chain check alone would have accepted the row (the two
  guards are exercised independently).

**Post-fix (same run, fix restored):** all four tests pass. The F-1
integration test additionally shows the rejected attempts wrote nothing: the
same idempotency keys with clean payloads still succeed, and row counts stay
exact (`goals 1, changes 2, receipts 3, audits 3`).

## Gates

| Command | Result |
|---|---|
| `corepack pnpm run evidence:check` | Passed: 25 JavaScript modules and 29 harness files checked |
| `corepack pnpm run evidence:test` | 16/16 passed |
| `corepack pnpm run typecheck` | Passed, no errors |
| `corepack pnpm run test:unit` (no database) | 19 files, 275/275 passed (270 base + 1 F-1 domain + 4 migration-contract incl. the 0005 checksum freeze) |
| `corepack pnpm run test:integration` (`KFIN_INTEGRATION_TARGET=non-production`, real PostgreSQL) | 6 files, 59/59 passed (56 base + 3 QA regression tests) |
| Migration ledger on a fresh schema | Applies `0005_savings_goals.sql` (`58f264e35dba…`) then `0006_savings_history_chain.sql` (`68c4ad5fa0ac…`); `git diff` of `0005` against the PR head is empty |

Where the new tests are:

- `packages/domain/test/savings.test.ts`: NUL rejection with Vietnamese/CJK control cases (F-1);
- `packages/database/test/savings-goals.integration.test.ts`: F-1 422 contract with key-reuse safety, F-2 chain forgery, F-3 actor forgery;
- `packages/database/test/migration-contract.test.ts`: `0006` shape (guard-only replacement, chain query, actor rule) and the `0005` checksum freeze.

## Not verified here

- CI for this commit on GitHub-hosted PostgreSQL 17.6; see the pull request checks.
- An end-to-end HTTP probe of the NUL rejection (the repository raises the
  `FinancialError` the API error handler serializes; the envelope mapping for
  `SAVINGS_GOAL_INVALID` is covered by existing API tests).
- A forged change row whose previous amount *does* continue the chain and
  matches the goal's current state (a no-op old/new pair) is indistinguishable
  at SQL level from what a legitimate same-amount update writes; attribution of
  writes beyond owner-only access remains the application layer's job.
