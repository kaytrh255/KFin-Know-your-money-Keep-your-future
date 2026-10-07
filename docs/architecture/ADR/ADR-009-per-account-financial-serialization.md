# ADR-009 — Per-account Financial Serialization

**Status:** Proposed<br>
**Date:** 2026-10-07<br>
**Decision owner:** Data Owner<br>
**Mandatory co-approvers:** Architecture Owner, Security Owner, Financial Integrity Owner<br>
**Consulted roles:** Product Owner, QA Owner, Operations Owner<br>
**Blocker:** `SPEC-FIN-02` — OPEN; approval and PostgreSQL evidence pending<br>
**Related:** [SPEC-FIN-02 — Snapshot Concurrency](../SPEC-FIN-02-SNAPSHOT-CONCURRENCY.md), [Database specification](../DATABASE.md), [SPEC-FIN-01 — Snapshot Correction](../../product/SPEC-FIN-01-SNAPSHOT-CORRECTION.md)

## Context

KFin’s current balance is anchored to the latest immutable snapshot segment. Snapshot creation, transaction creation, transaction correction/void, and linked owning-domain writes can race on one aggregate account. The external contract already requires one complete winner, an operation-specific stale loser, no automatic re-anchor, and idempotent recovery. A concrete PostgreSQL mechanism is required before financial implementation.

Private Beta has at most approximately 50 users and exactly one aggregate account per user. A distributed lock service, event-sourced architecture, or global serialization layer would add failure modes without justified scale benefit.

## Proposed decision

Adopt policy `account_financial_serialization.v1`:

1. Run each account-scoped financial mutation in one PostgreSQL `READ COMMITTED` transaction.
2. Acquire the authenticated user’s `financial_accounts` row with `SELECT … FOR UPDATE` as the first authoritative domain lock.
3. Re-read latest snapshot and relevant state only after acquiring that lock.
4. Require a client-reviewed `expected_financial_state_version` and latest snapshot ID.
5. Increment dedicated `financial_state_version` exactly once per committed logical mutation and zero times for stale/rejected/rollback/idempotent-replay results.
6. Acquire child/domain rows only after the account and in the global order specified by SPEC-FIN-02.
7. Persist a success idempotency result with the mutation; persist a bounded stale receipt with no financial/domain change or version increment; after the account lock, check either compatible result before expected-version comparison.
8. Retry only SQLSTATE `55P03`, `40P01`, or `40001`, at most once with the unchanged key/digest/version/payload and bounded jitter/budget.
9. Treat a lost `COMMIT` acknowledgement as uncertain; recover through the same account/key protocol and never issue a blind duplicate.
10. Require all user, worker, operator, and linked-domain paths to use the same boundary.

Proposed Private Beta bounds are: 2,000 ms lock wait per attempt, 5,000 ms statement timeout, 8,000 ms normal database budget, one internal retry after 25–75 ms jitter, and one commit-uncertainty recovery attempt within an additional 2,000 ms. These are candidate policy values pending evidence and approval, not framework defaults.

## Linearization and visible results

The account row lock establishes the serialization order; effects become externally visible at commit. Two different requests from the same reviewed version cannot both commit:

- first valid commit advances version `N` to `N+1`;
- waiter observes the committed version after acquiring the lock, makes no financial/domain mutation or version increment, persists only a bounded stale idempotency receipt, and returns the operation-specific HTTP `409`;
- a compatible idempotent replay returns the stored first result and does not become a stale loser; and
- no path refreshes/reanchors and continues without a new user review.

Snapshot losers return `FIN_SNAPSHOT_STALE_STATE`; correction/void losers return `FIN_CORRECTION_STALE_STATE`; other account-linked financial mutation losers return `FINANCIAL_STATE_STALE`.

## Alternatives considered

### PostgreSQL transaction-level advisory lock

**Not selected:** It requires a collision-free derived key convention, is easier for ad hoc SQL to bypass, has no row ownership predicate, and provides weaker schema-visible reviewability than locking the existing account aggregate row. It remains unnecessary at beta scale.

### `SERIALIZABLE` isolation as the primary mechanism

**Not selected:** It can detect anomalies but produces broader transaction-level retries and does not encode the product’s reviewed-version/latest-anchor conflict. Explicit row locking plus version checks gives deterministic user-facing stale results. PostgreSQL may still emit `40001`; bounded handling is specified.

### Optimistic version update without a row lock

**Not selected:** A single compare-and-swap does not by itself order latest-snapshot selection, correction-chain rows, and owning-domain links. It risks scattered retry logic around multi-row invariants.

### Table lock or one global mutex

**Rejected:** It serializes unrelated users, increases denial-of-service impact, and is unnecessary when the account row is the natural aggregate boundary.

### Redis/distributed lock

**Rejected:** It creates a second source of coordination truth and lease/split-brain failure modes while PostgreSQL already owns the transaction and target row.

### Automatic retry with refreshed state

**Rejected:** Re-executing against a new snapshot/version can silently change the anchor, effect, report, or link consequence the user confirmed.

## Consequences

### Positive

- One inspectable lock boundary for all account financial writes.
- Deterministic one-winner/stale-loser behavior under the intended PostgreSQL engine.
- Compatible idempotency handles parallel submission and uncertain commit without duplicate effects.
- Distinct accounts remain independently writable; no unnecessary infrastructure is added.
- Lock/retry metrics and deterministic evidence can prove the contract.

### Negative and risks

- A slow transaction on one account queues all financial writes for that account.
- Every covered path must obey account-first lock order; one bypass can invalidate the guarantee.
- Conservative versioning may reject a stale tab after an unrelated report-affecting financial write.
- Timeout/retry values require production-like benchmark and may need an explicitly approved revision.
- PostgreSQL/driver/pool behavior must be tested; documentation cannot substitute for fault injection.

## Required controls

- No external call, user interaction, or report rendering while the account lock is held.
- Owner-scoped lock query and same-user constraints remain mandatory under either future RLS posture.
- Stable safe errors expose no SQL/lock/private financial payload.
- Deadlock/timeout/retry/uncertain-result metrics contain no amount, note, or raw idempotency key.
- Migrations, recovery tools, workers, and operator scripts cannot bypass the protocol.
- `FIN-RACE-01`–`FIN-RACE-08` and the SPEC-FIN-02 evidence metadata are mandatory before acceptance.

## Approval and evidence required

This ADR MUST remain Proposed until:

1. named mandatory owners approve the exact mechanism, lock order, version scope, errors, and bounds;
2. deterministic PostgreSQL race tests prove both forced winner orders;
3. SQLSTATE injection proves one-retry behavior and exhaustion;
4. connection/proxy fault injection proves timeout-after-commit recovery;
5. lock/query review covers every user/worker/operator/domain path;
6. observed latency/lock waits fit the bounds or an approved revision updates every source document; and
7. evidence IDs, artifact digests, defects, reviewers, date, commit, and PR are recorded.

Creating or merging this proposed ADR does not resolve `SPEC-FIN-02`, does not mark this ADR Accepted, and does not open the Implementation Gate.
