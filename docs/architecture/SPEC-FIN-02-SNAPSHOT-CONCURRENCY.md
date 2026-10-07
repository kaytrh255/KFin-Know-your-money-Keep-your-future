# SPEC-FIN-02 — Snapshot Concurrency

**Status:** Proposed decision for GitHub Issue #3; owner approval and PostgreSQL evidence pending<br>
**Policy identifier:** `account_financial_serialization.v1`<br>
**Date:** 2026-10-07<br>
**Accountable owner:** Data Owner<br>
**Mandatory co-approvers:** Architecture Owner, Security Owner, Financial Integrity Owner<br>
**Consulted roles:** Product Owner, QA Owner, Operations Owner<br>
**Related issue:** [GitHub Issue #3](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/issues/3)<br>
**Related ADR:** [ADR-009 — Per-account financial serialization](ADR/ADR-009-per-account-financial-serialization.md)<br>
**Blocker state:** OPEN — approval/evidence ready<br>
**Implementation Gate:** CLOSED

## 1. Purpose and decision status

This specification defines a concrete PostgreSQL candidate for the per-account serialization boundary required by `SPEC-FIN-02`. It selects an owner-scoped `financial_accounts` row lock, PostgreSQL `READ COMMITTED`, a dedicated monotonic financial-state version, deterministic lock ordering, bounded internal retry, and idempotency-based recovery when commit acknowledgement is uncertain.

The policy is deliberately simple for a Private Beta of at most approximately 50 users:

- PostgreSQL remains the only coordination system;
- every account-scoped financial mutation passes through one row-level lock;
- a client-confirmed mutation is valid only against the exact account version and latest snapshot it reviewed;
- retries never refresh or re-anchor a user decision silently;
- a race from the same reviewed state has one commit winner and one stale loser; and
- an uncertain response is recovered with the original idempotency key rather than a second logical write.

This document and ADR-009 are decision candidates, not approval or runtime evidence. `SPEC-FIN-02` remains OPEN until mandatory owners approve this exact version and the required PostgreSQL evidence passes. `SPEC-FIN-01` remains independently OPEN. No implementation phase or Implementation Gate is opened by this documentation.

## 2. Normative terms and scope

- **Account serialization row:** the user-owned `financial_accounts` row for the one MVP aggregate account.
- **Financial-state version:** `financial_accounts.financial_state_version`, a server-controlled `BIGINT` representing the committed account-scoped financial state.
- **Reviewed state:** the version and latest snapshot ID returned with the form, preview, or read model that the user confirms.
- **Serialized financial mutation:** a write that creates or changes an account snapshot, posted transaction, transaction terminal status, or owning-domain link/effect participating in that account’s financial history.
- **Attempt:** one PostgreSQL transaction execution of an unchanged logical request.
- **Business stale result:** a post-lock mismatch between the reviewed state and authoritative committed state.
- **Transient database failure:** only SQLSTATE `55P03`, `40P01`, or `40001` under §8.
- **Commit uncertainty:** the application sent `COMMIT` but did not receive a trustworthy committed/rolled-back result because the connection or request timed out.
- **Confirmed explicit rollback:** `ROLLBACK` is issued on the same driver-visible connection as the failed attempt and awaited through PostgreSQL `ReadyForQuery` status `I` (idle), or a documented driver-equivalent guarantee that consumes that status. Dispatching the command, receiving the original error, or resolving a client-side wrapper without confirmed idle state is insufficient.
- **Eviction/quarantine:** an unconfirmed-clean application connection/pool handle is made unavailable to borrowers and invalidated/closed; it is not checked in, rehabilitated by a sentinel query, or used for an internal retry.

`MUST`, `MUST NOT`, and `MAY` are normative.

Serialized financial mutations include:

- manual authoritative-balance snapshot creation;
- current or historical transaction creation;
- transaction correction or standalone void;
- schedule-occurrence confirmation that creates/links a transaction;
- debt or planned-purchase operations that atomically create/change an account transaction; and
- any worker/operator path authorized to perform one of those mutations.

A read-only report does not acquire this write lock. A savings-goal scalar update that creates no transaction keeps its own version boundary; a planned-purchase operation that also posts an expense uses both the account lock and its domain locks. Initial account + initial snapshot bootstrap is the §5.5 exception because no account row exists yet.

## 3. Chosen PostgreSQL mechanism

### 3.1 Isolation and lock

Each attempt MUST run in one PostgreSQL transaction at explicit isolation level `READ COMMITTED`.

The first authoritative domain lock MUST be the owner-scoped account row:

```sql
SELECT id, currency, financial_state_version
FROM financial_accounts
WHERE id = :account_id AND user_id = :authenticated_user_id
FOR UPDATE;
```

This statement is illustrative SQL, not implementation code. A missing/non-owned account returns the same safe unavailable result and does not reveal another user’s row.

Successful acquisition orders competing writes for that account. The committed operation becomes externally visible at commit. A stale/rejected operation linearizes at its post-lock validation and commits no domain change. Reads performed before acquiring the account lock are hints only and MUST be re-read or revalidated after the lock.

PostgreSQL transaction-level advisory locks, Redis locks, process mutexes, and table locks are not part of this policy.

### 3.2 Financial-state version

`financial_accounts` MUST have a dedicated:

```text
financial_state_version BIGINT NOT NULL
```

Rules:

- initial account + snapshot bootstrap commits version `1`;
- every successful serialized financial mutation increments it exactly once;
- one multi-row logical mutation increments once, not once per row;
- rejected, stale, rolled-back, idempotent-replay, and read-only operations do not increment it;
- clients cannot supply the committed version, decrement it, or bypass comparison;
- overflow/wrap is forbidden and fails closed; and
- ordinary account-profile metadata uses a separate metadata version if needed.

Every relevant post-bootstrap read/preview response exposes `financial_state_version` and `latest_balance_snapshot_id`. Every post-bootstrap confirmed mutation requires `expected_financial_state_version`; snapshot-sensitive mutations also require the reviewed latest snapshot ID. Bootstrap has no prior version/account row and follows §5.5 with an explicit null prior snapshot.

### 3.3 Latest-snapshot check

After acquiring the account lock, the transaction MUST select the latest immutable snapshot using the approved deterministic ordering and compare its ID to the reviewed latest snapshot ID. The server derives transaction anchor/effect from this post-lock state.

A client cannot request a different anchor as a recovery strategy. Version equality without latest-snapshot equality is an integrity failure; latest-snapshot equality without version equality is stale state.

### 3.4 Why `READ COMMITTED`

Correctness comes from the explicit per-account row lock plus mandatory post-lock reads, not from a long-lived snapshot. `READ COMMITTED` lets a waiter observe the winner’s committed state after lock acquisition and then reject its old reviewed version deterministically. Using `REPEATABLE READ` or `SERIALIZABLE` as the primary mechanism would convert expected user conflicts into broader serialization retries without removing the need for version checks.

## 4. Required transaction protocol

Every serialized financial mutation follows this order:

1. Authenticate, authorize the operation shape, validate bounded input, and compute the canonical request digest before opening the database transaction. No authoritative financial decision is made yet.
2. An optional read-only idempotency lookup MAY return an already committed compatible result as a fast path. It is not the authoritative race check.
3. Begin one `READ COMMITTED` transaction and apply the bounded timeout settings in §8.
4. Lock the owner-scoped `financial_accounts` row `FOR UPDATE`.
5. Under that lock, recheck the idempotency key. Same key + same digest returns the original committed result without comparing the now-old expected version. Same key + different digest returns `IDEMPOTENCY_KEY_REUSED` and changes nothing.
6. If no committed idempotency result exists, compare `expected_financial_state_version` and reviewed latest snapshot ID with authoritative post-lock state.
7. On mismatch, commit only a bounded terminal stale idempotency receipt for this key/digest, with no financial/domain/link/audit mutation and no version increment, then return the operation-specific stale result in §6. Do not retry internally. A persistence failure rolls back the receipt and still cannot mutate financial state.
8. Lock and validate required source/link/domain rows in §5 order; rederive anchor, effect, ownership, currency, and consequences from locked state.
9. Apply the complete domain mutation, audit/link changes, and no partial subset.
10. Increment `financial_state_version` exactly once and write the bounded idempotency result, including previous/committed version and result reference, in the same transaction.
11. Commit. External calls, email, logging sinks, user interaction, and report rendering MUST NOT occur while locks are held.

For any failed statement inside an open transaction, the handler MUST issue `ROLLBACK` on that same connection and await confirmed idle state before releasing it to the pool, starting any retry, or returning a mapped timeout/busy result. SQLSTATE `55P03` and `57014` explicitly require this sequence. A statement error or driver exception MUST NOT be treated as proof that PostgreSQL already rolled back the whole transaction. Rollback uses a bounded cleanup scope that remains usable after statement/request cancellation; attempting it only through an already-cancelled request context is insufficient.

If rollback/idle confirmation is impossible, the pool MUST invalidate/close the connection handle before any result is returned. It MUST NOT check the handle in or start an internal retry on another connection while the prior backend outcome remains unconfirmed. After eviction, a pre-`COMMIT` failure returns the safe timeout/busy result associated with its trigger; if it is not trustworthy whether `COMMIT` was sent, §7.3 commit-uncertainty recovery applies instead. A different connection does not turn unknown cleanup into a retryable attempt.

A code path that writes a covered table without this protocol is a correctness defect, not an alternate optimization.

## 5. Lock order and transaction boundaries

### 5.1 Global order

All covered paths MUST acquire locks in this order:

1. account rows, ascending account UUID if a future approved operation ever spans accounts;
2. existing balance-snapshot rows that the operation must lock, ascending UUID;
3. transaction rows, ascending UUID;
4. scheduled-occurrence rows, ascending UUID;
5. debt aggregate/payment/adjustment rows, by that table order then ascending UUID;
6. planned-purchase rows, ascending UUID;
7. savings-goal rows, ascending UUID; and
8. audit/idempotency/outbox inserts or result updates.

MVP operations MUST affect only the user’s one aggregate account. Cross-account transfer is unavailable. The future ascending-account rule prevents a later feature from inventing an opposite lock order.

### 5.2 Account first

A handler MUST NOT lock a transaction, occurrence, debt, purchase, or goal row and then request the account lock. If an owning-domain flow discovers the account through a child ID, it may perform an unlocked owner-scoped lookup, but it must acquire the account lock before locking/revalidating the child.

### 5.3 Snapshot creation

Snapshot creation locks the account, checks the expected version/latest snapshot, validates that the requested `effective_at` is strictly later, inserts one immutable snapshot, increments the version once, records idempotency/audit result, and commits. It never updates an earlier snapshot.

### 5.4 Transaction/correction/domain writes

Transaction create, correction/void, and owning-domain confirmation lock the account first, derive or preserve the snapshot anchor under that lock, then lock required existing rows in global order. The whole source/replacement/link/audit/idempotency outcome commits or rolls back together.

### 5.5 Bootstrap exception

Initial onboarding creates the one account and initial snapshot atomically because there is no account row to lock. Uniqueness on `financial_accounts.user_id`, one user-scoped idempotency key, and the onboarding transaction permit one winner. The winner stores `financial_state_version = 1`; a duplicate compatible request returns that result, while incompatible duplicate state fails safely. Every later financial mutation uses the normal account lock.

### 5.6 Worker and operator paths

A worker, support tool, recovery action, or approved operator script that mutates covered state MUST use the same account lock, version increment, row order, audit, and idempotency protocol. Elevated database privileges do not create a bypass. Bulk direct changes require the separately approved operational process and cannot run concurrently with normal writes unless they honor this contract.

## 6. One-winner/stale-loser contract

If two different requests begin from the same reviewed version `N` for one account:

- the request that acquires the account lock, passes checks, and commits increments the version to `N + 1`;
- the waiter acquires the lock only after that commit, observes a mismatch, commits no financial/domain mutation or version increment, persists only the bounded terminal stale receipt needed to keep that key/digest result stable, and returns HTTP `409`; and
- the waiter is never replayed against version `N + 1`, never auto-reanchored, and never converted from `historical` to `current` or vice versa.

Operation-specific stale codes are:

| Losing operation | Stable code | Required recovery |
|---|---|---|
| Snapshot creation | `FIN_SNAPSHOT_STALE_STATE` | Refetch balance/version/latest snapshot; rebuild and reconfirm snapshot preview |
| Correction or standalone void | `FIN_CORRECTION_STALE_STATE` | Refetch source/link/version; rebuild and reconfirm consequences |
| Transaction create, schedule confirmation, or other account-linked financial mutation | `FINANCIAL_STATE_STALE` | Refetch account/domain state; rebuild and reconfirm; do not preserve a now-invalid anchor silently |

This applies to snapshot/snapshot, snapshot/transaction, snapshot/correction, correction/correction, correction/link, and snapshot/owning-domain races. The row-lock winner is not necessarily the request sent first. A successful idempotent replay is not a second winner and does not increment the version.

## 7. Idempotency and timeout-after-commit

### 7.1 Idempotency record

The unique scope is:

```text
(user_id, account_id, operation, key_digest)
```

A committed record stores a canonical request digest, bounded response status/reference, prior version, committed version when applicable, correlation ID, and retention metadata. A success record is written atomically with the financial mutation. A terminal stale record commits as metadata only, with no financial/domain/link/audit mutation or version increment, so that key/digest cannot later be repurposed. Raw idempotency keys and unrestricted financial payloads are not stored in logs.

The authoritative idempotency check occurs after the account lock and before expected-version comparison. This ordering is mandatory so a retry after a successful commit returns the original result rather than a false stale error and a retry after stale returns the same stale result.

### 7.2 Known pre-commit failure

If `COMMIT` was not sent and the server has explicitly issued and successfully awaited `ROLLBACK`, no idempotency result or financial mutation exists. A failed statement alone is insufficient to establish this state. Only after confirmed rollback may §8 retry the unchanged request in a new transaction with the same key/version; a client retry also uses the same key.

### 7.3 Commit uncertainty

A trustworthy PostgreSQL response rejecting `COMMIT` is not commit uncertainty. If it carries an internally retryable SQLSTATE, the handler still issues and awaits `ROLLBACK`/idle confirmation—`ROLLBACK` is harmless if PostgreSQL already ended the transaction—before applying §8. If the response does not establish whether `COMMIT` took effect, it is uncertain rather than retryable.

If `COMMIT` was sent but acknowledgement is lost:

1. the server MUST NOT assume rollback, create a new key, or issue an uncoordinated duplicate write;
2. it performs at most one in-request recovery attempt using the same account, key, digest, expected version, and transaction protocol;
3. if the original committed, recovery waits for/releases behind the account lock and returns the stored committed result;
4. if the original rolled back, recovery may execute the same logical request only after acquiring the account lock and finding no idempotency result; expected-version checks still apply;
5. if another request changed state, recovery returns the appropriate stale result; and
6. if the recovery budget cannot establish a result, return HTTP `503` + `FINANCIAL_RESULT_UNKNOWN`, preserve the user’s draft, and instruct retry with the **same** idempotency key.

A subsequent same-key/same-digest retry deterministically returns the committed result or safely executes once after a rollback. Same key/different digest is always rejected. UI copy must not claim failure or invite a new entry while the result is uncertain.

## 8. Bounded timeouts and retry policy

The proposed Private Beta bounds are part of this policy and require benchmark/race evidence before approval:

| Control | Candidate bound | Behavior |
|---|---:|---|
| PostgreSQL account/domain lock wait | `2,000 ms` per attempt | `lock_timeout`; on `55P03`, explicitly `ROLLBACK` before pool release/retry/result |
| PostgreSQL statement timeout | `5,000 ms` per statement | On `57014`, explicitly `ROLLBACK` before pool release/timeout result; no hidden long-running mutation |
| Application database budget | `8,000 ms` across attempts, rollback cleanup, and backoff | Reserve cleanup time; do not start a retry the remaining budget cannot contain |
| Internal transient retry | `1` retry; `2` total attempts | Same key, digest, expected version, and payload only |
| Retry backoff | Random `25–75 ms` | Bounded jitter; no exponential retry loop |
| Commit-uncertainty recovery | `1` attempt, within `2,000 ms` additional budget | Same-key protocol in §7.3; otherwise `FINANCIAL_RESULT_UNKNOWN` |

Only SQLSTATE `55P03` (`lock_not_available`/lock timeout), `40P01` (`deadlock_detected`), and `40001` (`serialization_failure`) are internally retryable. The failed transaction is unusable until explicit rollback; the server MUST await `ROLLBACK` before deciding whether the unchanged request may retry. A retry reuses the original expected version and never refreshes state automatically.

Rules:

- a business stale result, validation failure, authorization failure, or idempotency digest conflict is never internally retried;
- every `55P03`, `40P01`, or `40001` attempt failure MUST complete confirmed explicit rollback before the one allowed retry or a busy result;
- SQLSTATE `57014`/application deadline is not internally retried and MUST use the cleanup scope to complete confirmed explicit rollback before returning HTTP `503` + `FINANCIAL_OPERATION_TIMEOUT` with safe same-key retry guidance;
- a failed statement MUST NOT be interpreted as proof that the complete transaction has already rolled back;
- a second transient failure, or a first transient failure after which the remaining budget cannot safely contain cleanup/backoff/another complete attempt, returns HTTP `503` + `FINANCIAL_CONCURRENCY_BUSY` and `Retry-After: 1` after confirmed rollback, with no new `BEGIN`;
- every retry begins with a new `BEGIN`/new PostgreSQL transaction after the prior attempt’s confirmed rollback; retrying inside the failed transaction is forbidden;
- if rollback/idle cannot be confirmed, the connection is evicted/closed before response, no internal retry occurs on any connection, and the trigger maps to timeout/busy unless §7.3 applies;
- connection loss after `COMMIT` is not a normal transient retry; it follows §7.3; and
- no retry loop may outlive the request budget or hold a database connection during backoff.

Changing these bounds requires the same Data/Architecture/Security/Financial Integrity approval and updated evidence; framework/driver defaults cannot silently replace them.

## 9. Error and observability contract

Safe responses include a correlation ID, stable code, retry/refetch instruction, and no SQL text, lock identity, account existence detail, financial amount, or another request’s data.

Required metrics, without raw account IDs/amounts/notes:

- account-lock wait histogram and timeout count;
- stale result count by operation code;
- transient retry count by SQLSTATE and attempt number;
- rollback cleanup duration/outcome, idle-confirmation failure, and connection-eviction count;
- retry-exhausted, budget-prevented-retry, and operation-timeout count;
- commit-uncertainty recovery outcome: replayed, safely executed, stale, or unknown;
- idempotency replay/digest-conflict count; and
- transaction duration and pool saturation.

A deadlock is never normalized as routine success; it emits a sanitized diagnostic and triggers lock-order review. Evidence may inspect `pg_locks`, PostgreSQL logs, and query traces only in a synthetic environment with identifiers redacted from retained artifacts.

## 10. Reproducible test and evidence matrix

Every case runs against PostgreSQL using the intended driver/transaction layer. Deterministic barriers/hooks force each lock/commit order; sleep-only race tests are insufficient. The matrix is specified, **NOT RUN**, and cannot be labelled PASS by this document.

| Case | Forced fixture/action | Required result |
|---|---|---|
| `FIN-RACE-01` — snapshot vs transaction | Both requests use version `N` and latest snapshot `S`; force transaction-first, then snapshot-first | First commit increments to `N+1`; loser gets its operation-specific `409`; transaction is never silently moved to a new anchor; one latest snapshot/effect only |
| `FIN-RACE-02` — snapshot vs correction/void | Same reviewed state; force correction-first and snapshot-first, including linked schedule correction | One complete winner; losing snapshot gets `FIN_SNAPSHOT_STALE_STATE` or losing correction gets `FIN_CORRECTION_STALE_STATE`; source/replacement/link remain atomic |
| `FIN-RACE-03` — correction vs correction/void | Parallel different keys target one posted terminal source | One source transition and at most one replacement; loser stale; no branch, double reversal, partial link, or second version increment |
| `FIN-RACE-04` — snapshot vs snapshot/stale tab | Two snapshots or a deliberately stale tab use version `N`; force both orders | Exactly one new immutable latest snapshot and version `N+1`; loser stale; no duplicate effective anchor or overwrite |
| `FIN-RACE-05` — idempotency contention | Parallel same-key/same-digest, then same key/different digest, plus retry after committed version changed | Compatible calls return one stored result and one version increment; different digest gets `IDEMPOTENCY_KEY_REUSED`; replay is not stale |
| `FIN-RACE-06` — rollback cleanup and bounded retry | Force each of `55P03`, `40P01`, `40001` after the account lock on attempt one and, in exhaustion subcases, again on attempt two; commit a competitor between attempts in a stale subcase; force `57014` with request context cancelled; separately exhaust pre-retry budget and make rollback acknowledgement unconfirmable | Each confirmable case reaches `ReadyForQuery(I)`/driver-equivalent before check-in/result/fresh `BEGIN`; `57014`, insufficient budget, and unconfirmed cleanup start no retry; unconfirmed cleanup evicts the handle; changed state is stale; second transient is busy; no failed-transaction reuse/third attempt |
| `FIN-RACE-07` — timeout/commit uncertainty | Cut the connection before `COMMIT`, after `COMMIT` is sent, and after commit but before response; test original commit and rollback branches | Same key recovers one result or safely executes once after rollback; unresolved budget returns `FINANCIAL_RESULT_UNKNOWN`; no duplicate row/effect/version increment |
| `FIN-RACE-08` — scope, order, and bypass | Run covered user/worker/operator/domain writes on one account and parallel writes on distinct synthetic accounts; deliberately violate child-before-account order in test instrumentation | Same-account writes serialize; distinct accounts are not globally locked; every covered path uses account-first order; prohibited order/bypass fails architecture review/test |

### 10.1 Evidence execution requirements

Closure evidence MUST run on a dedicated non-production Supabase project using real PostgreSQL and synthetic data only. That evidence environment does not by itself select the production provider under OQ-17. It MUST include:

- Supabase/PostgreSQL server version/configuration, driver/ORM version, pool mode, schema/spec commit, and test harness commit;
- at least 100 deterministic repetitions of each forced winner order in `FIN-RACE-01`–`05` with zero forbidden outcome;
- exact SQLSTATE, attempt count, backoff, remaining budget, and final result for every `FIN-RACE-06` subcase, including each retryable code on attempts one/two, `57014`, budget-prevented retry, and rollback-acknowledgement loss;
- protocol/driver trace proving same-connection `ROLLBACK` reaches `ReadyForQuery(I)` or documented driver-equivalent idle state before pool release, timeout/busy response, or a fresh retry `BEGIN`;
- pool-state evidence that unconfirmed cleanup evicts/closes the application handle, starts no internal retry, and never checks that handle in; deterministic clean-reuse evidence uses a one-slot application pool or equivalent connection correlation;
- a connection/proxy fault injection at each `FIN-RACE-07` cut point, not an application exception substituted for commit uncertainty; the pre-`COMMIT` cut must confirm backend/session termination before same-key re-execution;
- account/version/snapshot/result counts before and after, using synthetic data and no retained private payload;
- proof that version increments once for a logical winner and zero times for loser/replay/rollback;
- lock-order/query review and sanitized `pg_locks`/database diagnostics for `FIN-RACE-08`;
- observed p95/p99 lock wait and transaction duration at the intended beta concurrency, compared with §8 bounds;
- defect list and rerun disposition; and
- named evidence producer, Data/Architecture/Security/Financial Integrity reviewers, date, and artifact digest in the Approval and Evidence Register.

A probabilistic run without forced order, an in-memory database, a mocked lock, or documentation-only review cannot close the blocker.

### 10.2 Rollback, lock-release, and pool-reuse oracle

The Supabase PostgreSQL harness MUST make transaction cleanup observable rather than infer it from an error response:

1. Begin attempt A, acquire the account lock, then force each retryable SQLSTATE on a later test action; separately force `57014` and request-context cancellation after the account lock is held.
2. For statement failures, observe failed transaction status `E`/`25P02` before cleanup. This proves the original error is not accepted as idle-state confirmation.
3. On the same driver-visible connection, record the still-live cleanup scope, `ROLLBACK` dispatch, and receipt of `ReadyForQuery(I)` or the documented driver-equivalent idle acknowledgement. Before idle confirmation, no retry `BEGIN`, pool check-in, timeout/busy response, or application result is allowed.
4. After cleanup, an independent observer MUST acquire every known account/child lock from attempt A within the expected bound; evidence must show no lock remains, without assuming the original statement error itself released it.
5. Using a one-slot application pool or equivalent handle/session correlation, return the confirmed-clean connection and force the next synthetic borrower to execute a sentinel query/new transaction without `25P02`, inherited locks, local settings, or prior request context.
6. Deliberately lose the rollback acknowledgement. The application pool MUST invalidate/close that handle before response, MUST NOT check it in or rehabilitate it with a query, and MUST start no internal retry on another connection.
7. The next borrower MUST NOT receive the evicted application handle. If a Supabase-managed pooler multiplexes backend sessions, evidence MUST distinguish application-handle eviction from provider backend reuse and prove an idle/new transaction boundary rather than rely only on backend PID change.
8. A permitted retry MUST show a new transaction identity/`BEGIN` after confirmed rollback and must re-run the full account-lock/version/idempotency protocol. A budget-prevented retry MUST show no second `BEGIN` and the stable busy result.

Artifacts retain ordered timestamps, safe handle/backend/transaction correlation tokens, protocol or driver transaction-status events, pool checkout/check-in/eviction events and lock observations—never real user IDs, amounts, notes or raw idempotency keys.

The oracle follows PostgreSQL’s documented [`ROLLBACK`](https://www.postgresql.org/docs/current/sql-rollback.html) behavior and [`ReadyForQuery`](https://www.postgresql.org/docs/current/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-READYFORQUERY) statuses: `I` is idle, `T` is in a transaction block, and `E` is in a failed transaction block.

## 11. Acceptance trace

| Requested outcome | Contract evidence |
|---|---|
| PostgreSQL per-account linearization | §§3–5; owner-scoped account row `FOR UPDATE` at `READ COMMITTED` |
| Lock/isolation/version mechanism | §§3–5; account-first order plus `financial_state_version` and latest-snapshot check |
| Bounded retry | §§4/8; confirmed idle rollback before pool release/fresh transaction, exact retryable SQLSTATEs, one retry, no retry after unconfirmed cleanup, fixed budgets and stable exhaustion result |
| Timeout-after-commit behavior | §7.3 and `FIN-RACE-07`; same-key recovery, never blind duplicate execution |
| One-winner/stale-loser race | §6 and `FIN-RACE-01`–`04`; one version increment and operation-specific stale codes |
| Test/evidence matrix | §10; deterministic PostgreSQL barriers, fault injection, repetitions, metadata and reviewers |
| No premature blocker/gate closure | Header, §1 and §12; OPEN pending approval/evidence, Implementation Gate CLOSED |

## 12. Approval and gate conditions

`SPEC-FIN-02` may move from OPEN to RESOLVED only when:

1. the Data Owner and mandatory Architecture, Security, and Financial Integrity co-approvers approve this exact policy/version and bounds;
2. ADR-009 is accepted with names, date, rationale, rejected alternatives, and linked evidence;
3. `FIN-RACE-01`–`FIN-RACE-08` execute against real PostgreSQL on the dedicated Supabase evidence project with intended driver/pool behavior and satisfy every required result, including idle-confirmed rollback-before-retry, clean reuse, and eviction/no-retry after unconfirmed cleanup;
4. query/lock review proves every covered user, worker, operator, and owning-domain write uses the account-first boundary;
5. timeout-after-commit fault injection proves same-key recovery with no duplicate effect;
6. the Approval and Evidence Register records source commit, PR, artifact versions/digests, observed results, reviewers, defects, and disposition; and
7. all synchronized specifications contain no alternate mechanism, retry, or stale-state behavior.

This remediation records a concrete candidate and reproducible evidence plan only. No runtime test has been executed, ADR-009 remains Proposed, `SPEC-FIN-02` remains OPEN, and the global Implementation Gate remains CLOSED.
