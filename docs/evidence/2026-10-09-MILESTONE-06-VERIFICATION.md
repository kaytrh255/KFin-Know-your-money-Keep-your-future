# Milestone 06 — Savings goals: verification evidence

**Date:** 2026-10-09<br>
**Base:** `main` at `422593acbdf9df70d0674175b21aa562459870c3`<br>
**Implementation trace:** [MILESTONE-06-SAVINGS-GOALS.md](../implementation/MILESTONE-06-SAVINGS-GOALS.md)<br>
**Production readiness:** Not claimed

These results come from commands actually run in the development sandbox. The environment was Node 22, pnpm through Corepack, and a local embedded PostgreSQL 17.6 instance that is non-production and disposable. Each integration suite migrates into its own isolated schema and drops that schema afterwards. CI results for the pull request are recorded on the PR, not here.

## Gates

| Command | Result |
|---|---|
| `corepack pnpm run evidence:check` | Passed: 25 JavaScript modules and 29 harness files checked |
| `corepack pnpm run evidence:test` | 16/16 passed |
| `corepack pnpm run typecheck` | Passed, no errors |
| `corepack pnpm run test:unit` (no database) | 19 files, 270/270 passed. The 213 tests from the base remain, and 57 are new |
| `corepack pnpm run test` with `KFIN_INTEGRATION_TARGET=non-production` and `TEST_DATABASE_URL` set to local PostgreSQL | 25 files, 326/326 passed. The base had 258, and 68 are new: 57 unit/API plus 11 savings integration tests |

Where the new tests are:

- `apps/api/test/savings-goals.test.ts`: 45 tests;
- `packages/domain/test/savings.test.ts`: 9 tests;
- `packages/database/test/migration-contract.test.ts`: 3 new tests;
- `packages/database/test/savings-goals.integration.test.ts`: 11 tests.

## Real-PostgreSQL behavior covered (`savings-goals.integration.test.ts`)

1. One create writes 1 goal, 1 `initial` change, 1 receipt, and 1 audit row. The goal is in VND, the progress fields are derived, and the receipt contains no amount.
2. Six concurrent creates with the same key produce one goal: one original and five replays. The same key with a different payload returns `409 IDEMPOTENCY_KEY_REUSED`, and the row counts do not change.
3. Each of the following returns `422` and writes no rows: an as-of date in the user-local future (tomorrow in Asia/Ho_Chi_Minh), a cadence without a contribution, a target of 0, a negative current amount, and a current amount one above the BIGINT maximum. An as-of date of today is accepted.
4. An absolute update from 2 500 000 to 12 000 000 replays with the same key. Afterwards the goal reports `achieved` and `overTarget`, with 12 000 basis points. A stale version returns `409 SAVINGS_GOAL_VERSION_CONFLICT`, and a future as-of date returns `422`. The history holds exactly two rows: [v2 2 500 000 → 12 000 000 `manual_update` "Bonus"] and [v1 null → 2 500 000 `initial`].
5. Six concurrent updates with the same version produce exactly one success. The other five receive `SAVINGS_GOAL_VERSION_CONFLICT`. The latest history row matches the goal's current amount.
6. A plan edit (name trimmed, target, target date) leaves the current amount, its as-of date, and the history unchanged. Clearing the contribution while a cadence remains returns `422`, and clearing both succeeds.
7. Archive was tested with three goals of 100 000, 150 000, and 50 000. Archiving the third one replays with the same key. Afterwards `1 000 000 − active reserve = 750 000` (STS-09/10), the archived value is kept, and the active and archived lists are correct. Any further update, plan edit, or archive returns `409 SAVINGS_GOAL_ARCHIVED`.
8. Another user's get, history, update, plan edit, and archive all return `404`, and that user's list is empty. The intruder ends with no goals, history rows, receipts, or audit rows.
9. After opening an account and running a full goal lifecycle, `getCurrentBalance` and `getMonthlyActuals` are deep-equal to their values before the lifecycle. The user still has zero transactions and exactly one snapshot.
10. Cursor pagination works for goals (2 + 1) and for history (versions 4, 3, 2 and then 1). An invalid cursor returns `400`.
11. The database rejects each of the following:
    - an amount update with no audit row (deferred check at commit);
    - a goal insert without its `initial` row;
    - a currency other than the user's base currency;
    - a version skip;
    - an owner change;
    - a mismatched change row;
    - an UPDATE or DELETE on a history row;
    - a DELETE of a goal;
    - un-archiving an archived goal.

## End-to-end HTTP probe (temporary, not committed)

A throwaway vitest file built the real `buildApp` with the real `PostgresSavingsGoalRepository` against local PostgreSQL. It used an injected principal and CSRF verifier. Observed results:

| Request | Result |
|---|---|
| create | `201` |
| same-key replay | `201`, `Idempotency-Replayed: true` |
| update | `200`, version 2 |
| stale update | `409 SAVINGS_GOAL_VERSION_CONFLICT` |
| `GET` | `200`, Vietnamese name round-trip, progress 12 000 basis points |
| history | `200`, 2 rows |
| archive | `200`, version 3 |
| active list / archived list | 0 / 1 items |
| cross-site `text/plain` POST | `403` |

The file was deleted after the run.

## Mutation checks

Each mutation was applied to a backup copy, the relevant suite was run, and the original was restored. Every mutation was caught.

| # | Mutation | Result |
|---|---|---|
| M1 | Remove the repository's optimistic-version check | Killed: 2 integration failures |
| M2 | Create route uses `requireAuthentication` instead of the CSRF guard | Killed: 3 API failures |
| M3 | Drop the deferred amount-audit constraint trigger | Killed: database-invariant test |
| M4 | Ignore the status filter in `listGoals` | Killed |
| M5 | Check archived/version before the idempotency receipt | Killed: archive replay |
| M6 | Remove the user-local future as-of check on update | Killed |
| M7 | Do not cap `remainingMinor` at 0 | Killed: domain test |
| M8 | Drop the owner predicate from the goal lock | Killed: cross-user test |
| M9 | Plan edit also zeroes the current amount | Killed: 2 failures |
| M10 | Disable the archived-terminal trigger | Killed |

## Not verified here

- CI for this commit. See the pull request checks.
- Any UI, because the repository has no web app.
- Planned-purchase use of reserves, safe-to-spend, deletion and export, and operator recovery corrections. These are out of scope; see the implementation trace.
