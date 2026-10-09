# Milestone 06 — Savings goals

**Implementation date:** 2026-10-09<br>
**Base:** `main` at `422593acbdf9df70d0674175b21aa562459870c3` (Milestone 05 merged as PR #5)<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Trace:** PRD-SAV-01..07; MVP-SCOPE §2.6; UF-SAV-01; SCREEN-INVENTORY SAV-01..05; DATABASE §§9.1–9.2, §14; TEST-STRATEGY STS-09/10<br>
**Scope:** Backend API, persistence, and tests for manually maintained savings goals<br>
**Production readiness:** Not claimed

This milestone adds savings goals as a backend vertical slice: migration, domain rules, contracts, repository, and HTTP routes. It does **not** modify any specification, SDD, ADR, test-strategy, or governance document. It does not change Milestone 04 authentication, sessions, or CSRF behavior. No open SPEC blocker covers savings goals. SPEC-SCH-01, SPEC-DEBT-01, SPEC-REM-01, and SPEC-DEL-01 block the other remaining MVP areas: recurrence, debts, reminders, and deletion.

## Product rules implemented

- **A goal is a declared reserve, not a cash ledger** (DATABASE §9, OQ-08). The current amount is an absolute value the user maintains with an as-of date. Creating, editing, updating, or archiving a goal never reads or writes `financial_accounts`, `balance_snapshots`, `transactions`, `financial_current_balances`, or monthly actuals. The migration has no reference to those tables, and an integration test confirms that balance, financial-state version, snapshots, transactions, and monthly actuals are unchanged after a full goal lifecycle.
- **Currency** is always the user's base currency. A composite foreign key to `users(id, base_currency)` enforces this, and the client cannot supply it.
- **Create** (PRD-SAV-01/02) requires a name (1–120 characters after trimming), a target (> 0), a current amount (≥ 0), and an as-of date. Optional fields are a target date, a planned contribution (> 0), and a contribution cadence. The as-of date must not be in the user's local future, judged in the user's own timezone. The goal row and its `initial` amount-change row commit in one transaction.
- **Current-amount update** (PRD-SAV-03) is an absolute replacement, not a delta. It requires `expectedVersion` and writes exactly one immutable `manual_update` row holding the previous amount, the new amount, the as-of date, an optional reason (up to 500 characters), the actor, and the correlation id. All of this happens in the same transaction as the scalar update. A stale version returns `409 SAVINGS_GOAL_VERSION_CONFLICT` and writes nothing.
- **Plan edit** (SAV-04) can change the name, target, target date, planned contribution, and cadence, and it is versioned. It never changes the current amount or its history; the contract rejects `currentAmountMinor` on PATCH. Setting a field to `null` clears it.
- **Progress** (PRD-SAV-05) is derived on every read and never stored:
  - `percentBasisPoints = floor(current × 10 000 ÷ target)`, not capped, so an over-target goal reports more than 10 000;
  - `achieved` (current ≥ target);
  - `overTarget` (current > target);
  - `remainingMinor` (never negative).

  Reaching the target never archives the goal (PRD-SAV-07).
- **Archive** (PRD-SAV-07) needs `expectedVersion`. It keeps the latest value and the full history and removes the goal from the active list. Archive is terminal, enforced both in the repository (`409 SAVINGS_GOAL_ARCHIVED`) and by a database trigger. Archived goals stay visible with `?status=archived` or `?status=all`.
- **Safe-to-spend reserve term** (STS-09/10). `activeSavingsReserveMinor` sums the current amounts of active goals only and fails closed on BIGINT overflow. Safe-to-spend itself is not part of this milestone because it depends on recurrence (SPEC-SCH-01). This helper and its tests define the savings input it will consume.

## HTTP surface

Every mutation requires an `Idempotency-Key`. Every mutation also runs the Milestone 04 browser defense at `onRequest`, before the body is parsed: same-origin `Origin` or `Sec-Fetch-Site`, plus the `x-kfin-csrf` double-submit token. A cross-site or token-less request, including an HTML form, is rejected with `401`/`403` before it reaches the body parser. The owner always comes from `request.principal.userId`, and the strict contracts reject `userId`, `currency`, and similar fields.

| Method | Path | Success | Notable errors |
|---|---|---|---|
| `POST` | `/api/v1/savings-goals` | `201 { goalId, version, amountChangeId }` | `400`, `401`, `403`, `404` (owner unavailable), `409 IDEMPOTENCY_KEY_REUSED`, `422 SAVINGS_GOAL_INVALID` |
| `GET` | `/api/v1/savings-goals?status=active\|archived\|all&limit&cursor` | `200 { items: SavingsGoal[], nextCursor }` (default `active`, oldest first) | `400`, `401` |
| `GET` | `/api/v1/savings-goals/:id` | `200 SavingsGoal` (with derived `progress`) | `404` (missing or another user's goal) |
| `PATCH` | `/api/v1/savings-goals/:id` | `200 { goalId, version }` | `409 SAVINGS_GOAL_VERSION_CONFLICT` / `SAVINGS_GOAL_ARCHIVED`, `422` |
| `POST` | `/api/v1/savings-goals/:id/current-amount` | `200 { goalId, version, amountChangeId }` | `409` (stale or archived), `422` (future as-of, out of range) |
| `POST` | `/api/v1/savings-goals/:id/archive` | `200 { goalId, version }` | `409` (stale or already archived) |
| `GET` | `/api/v1/savings-goals/:id/amount-changes?limit&cursor` | `200 { items: SavingsAmountChange[], nextCursor }` (newest goal version first) | `404` |

A replay with the same key and the same payload returns the stored receipt with `Idempotency-Replayed: true`. Receipts hold only identifiers and versions, never amounts. Mutation responses are receipts in the same style as earlier milestones, so the client re-reads the goal with `GET`.

## Persistence (migration `0005_savings_goals.sql`)

- `savings_goals` holds BIGINT amounts with checks, `status active|archived` (with `archived_at` set exactly when archived), and `version`. A composite currency foreign key ties the goal to the user's base currency. The index `(user_id, status, created_at, id)` serves the filtered list.
- `savings_amount_changes` stores `goal_version`, previous and new amounts, `as_of`, and a `source` from the DATABASE §9.2 set: `initial | manual_update | planned_purchase_use | recovery_correction`. It also stores `planned_purchase_id`, which is unique and present exactly when the source is `planned_purchase_use`. Its foreign key waits until planned purchases are implemented. Remaining columns are a bounded `reason`, actor columns with an exactly-one check, and `correlation_id`. The index is `(user_id, savings_goal_id, created_at DESC, id DESC)`.
- **Database-enforced invariants (defense in depth):**
  - amount-change rows can never be updated or deleted (`kfin_reject_immutable_history`);
  - goals cannot be deleted, because the deletion policy is still open under SPEC-DEL-01;
  - a goal's id, owner, currency, and creation time are immutable;
  - every goal update advances `version` by exactly one, and archived goals are terminal;
  - a change row must match the goal's current version, amount, and as-of date when it is inserted, and `UNIQUE (savings_goal_id, goal_version)` allows at most one such row per version;
  - a **deferred constraint trigger** rejects at commit any goal insert, or any change of current amount or as-of date, that lacks one matching old/new change row (`initial` for an insert; `previous = OLD.current_amount_minor` for an update). This makes "every update writes its audit row in the same transaction" checkable inside the database.
- Each mutation also writes a digest-only `idempotency_results` row (user scope, `account_id IS NULL`) and an `audit_events` row (`resource_type = 'savings_goal'`) in the same transaction.

## Concurrency and failure handling

- Create locks the owner's `users` row (`FOR UPDATE`). Mutations lock the goal row (`FOR UPDATE OF g`, owner-scoped). Concurrent same-key creates are serialized and replay. When several updates arrive concurrently with the same version, exactly one wins and the others receive `409 SAVINGS_GOAL_VERSION_CONFLICT`. The idempotency receipt is checked before the version and archived checks, so the replay of a successful archive or update still returns its receipt.
- The transaction sets `lock_timeout` to 2 s and `statement_timeout` to 5 s.
  - SQLSTATE `55P03`, `40P01`, `40001`, and `23505` return `409 FINANCIAL_CONCURRENCY_BUSY` with `Retry-After`.
  - `57014` returns `503 FINANCIAL_OPERATION_TIMEOUT`.
  - Any other database failure returns `503 FIN_DATABASE_UNAVAILABLE`.
  - If `COMMIT` fails without a SQLSTATE, one recovery attempt runs. It replays through the receipt, or performs the write if it never committed. If that attempt also fails, the request returns `503 FINANCIAL_RESULT_UNKNOWN`.

## Code changes

| Area | Change |
|---|---|
| `packages/database/migrations` | `0005_savings_goals.sql` |
| `packages/domain` | `savings.ts`: amount parsing, name/reason bounds, user-local as-of rule, cadence rule, `computeSavingsProgress`, `activeSavingsReserveMinor`, and the error codes `SAVINGS_GOAL_INVALID` (422), `SAVINGS_GOAL_VERSION_CONFLICT` (409), `SAVINGS_GOAL_ARCHIVED` (409) |
| `packages/contracts` | `savings.ts`: strict request, response, and query schemas |
| `packages/database` | `PostgresSavingsGoalRepository` (`savings-repository.ts`); Drizzle declarations in `schema.ts` |
| `apps/api` | `savings-routes.ts` (`registerSavingsRoutes`, `SavingsApiService`); optional `savingsService` in `buildApp`; production wiring in `server.ts` |

## Tests

| Concern | Tests |
|---|---|
| Authorization, CSRF at `onRequest` (including a cross-site HTML form), required `Idempotency-Key`, principal-only ownership, strict contracts, 404/409/422 envelopes, replay header | `apps/api/test/savings-goals.test.ts` (45) |
| Progress math including the BIGINT boundary, active-only reserve (STS-09/10), user-local timezone as-of rule, cadence, bounds | `packages/domain/test/savings.test.ts` (9) |
| Static migration contract, including "no balance/transaction references" | `packages/database/test/migration-contract.test.ts` (3 new) |
| Real PostgreSQL: atomic create, replay, key reuse, concurrent same-key create, future as-of, invalid plans, absolute update with history, stale version, concurrent same-version updates, plan edit leaves the amount alone, archive (terminal, value kept, reserve 750 000), cross-user 404s, no balance/monthly effect, pagination, database invariants | `packages/database/test/savings-goals.integration.test.ts` (11) |

Results and mutation checks are in [the verification evidence](../evidence/2026-10-09-MILESTONE-06-VERIFICATION.md).

## Implementation choices within the specification

These choices fill gaps the specification does not settle. None of them contradicts it.

- **Target must be > 0.** DATABASE §9 says the amounts are non-negative, but a zero target makes progress undefined. The current amount may be 0.
- **Cadence values** are `weekly | monthly | yearly`, the same set as the MVP schedule cadences. The cadence is informational only and does not generate schedules or reminders, which remain blocked by SPEC-SCH-01 and SPEC-REM-01. A cadence requires a planned contribution amount.
- **As-of date.** Any date that is not in the user's local future is accepted, including one earlier than the previous as-of date. The latest explicit update wins, and the history keeps both rows.
- **Updating to the same amount** is allowed. It still records a history row, because the user re-confirmed the value as of a date.
- **No hard delete.** This waits for SPEC-DEL-01.

## Not included

- UI. The repository has no web app yet, so SAV-01..05 screens are not built.
- Planned-purchase use of goal reserves (`planned_purchase_use` rows). This belongs to the planned-purchases milestone; the enum and checks are ready.
- Operator `recovery_correction` writes.
- The safe-to-spend calculation, which depends on recurrence and SPEC-SCH-01.
- Goal deletion and export (SPEC-DEL-01).
