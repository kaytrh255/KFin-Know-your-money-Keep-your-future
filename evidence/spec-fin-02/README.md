# SPEC-FIN-02 PostgreSQL evidence harness

This directory is standalone evidence-generation infrastructure for the accepted frozen specification baseline `a48d2c5683550859c1b4e19e9d06750616adc0a2`. It is **not** the KFin application, a production migration, owner approval, ADR acceptance, blocker closure, or permission to open the Implementation Gate.

## 1. Prerequisites

- Node.js 22 or later with Corepack and the repository-pinned pnpm version.
- A dedicated **non-production** PostgreSQL/Supabase project containing no real users or production data.
- A PostgreSQL role able to create/drop one `kfin_fin02_*` schema and create tables, indexes, triggers, and a PL/pgSQL test function inside it.
- Multiple concurrent connections plus visibility of the role's own sessions through `pg_stat_activity`, `pg_locks`, and `pg_blocking_pids`.
- Permission to call `pg_cancel_backend` for a session created by the same test role.
- Direct TCP egress to the configured endpoint. FIN-RACE-06 handle-lifecycle proof and FIN-RACE-07 commit-boundary proof require Supabase direct or session mode; transaction-pooler or unknown mode is reported `BLOCKED` for those cases.

Install the pinned driver:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run evidence:check
corepack pnpm run evidence:test
```

## 2. Secret-safe configuration

Supply the connection only through the environment. In Arena, configure it as a masked environment secret—do not paste it into source, command arguments, issues, PR text, or evidence artifacts.

```bash
export KFIN_EVIDENCE_TARGET=non-production
export KFIN_EVIDENCE_POOL_MODE=direct   # direct | session | transaction | unknown
# DATABASE_URL must already be supplied by the secret environment.
```

The harness refuses any database connection unless `KFIN_EVIDENCE_TARGET=non-production`. It never prints `DATABASE_URL`, username, password, or hostname. `.env*`, keys, dependencies, and `.artifacts/` are ignored. `KFIN_EVIDENCE_SSL_MODE` may be `disable`, `prefer`, `require`, or `verify-full`; remote/Supabase endpoints default to `require`. Certificate verification defaults on and may only be changed explicitly with `KFIN_EVIDENCE_SSL_REJECT_UNAUTHORIZED=false` in a controlled evidence environment.

## 3. Schema setup, reset, and cleanup

Migration `001_account_financial_serialization_evidence.sql` creates only the minimum synthetic model: users, `financial_accounts`, immutable snapshots, transactions/correction chain, scheduled-occurrence link, idempotency results, audit metadata, and deterministic fault rows/functions.

```bash
corepack pnpm run evidence:setup
corepack pnpm run evidence:reset
corepack pnpm run evidence:drop
```

The default namespace is `kfin_fin02_evidence`. Override it with `--schema kfin_fin02_<name>` or `KFIN_EVIDENCE_SCHEMA`; destructive operations reject every other prefix. A full run resets the namespace first and drops it afterward. Use `--keep-schema` only for controlled failure investigation.

All IDs, amounts, dates, users, keys, and correlations are synthetic. Raw idempotency keys are never stored; only SHA-256 digests are used.

## 4. Running tests

Complete closure-shaped execution (FIN-RACE-01–08; FIN-RACE-01–05 run 100 repetitions per forced order):

```bash
corepack pnpm run evidence:run
```

One case:

```bash
corepack pnpm run evidence:case -- --case FIN-RACE-06
corepack pnpm run evidence:case -- --case FIN-RACE-07 --keep-schema
```

A developer smoke count is allowed, but cannot become PASS evidence:

```bash
corepack pnpm run evidence:case -- --case FIN-RACE-01 --repetitions 2
```

Any FIN-RACE-01–05 run below 100 repetitions per forced order is labelled `NOT RUN` for closure purposes even if its executed assertions succeed. If `DATABASE_URL` is absent, all selected PostgreSQL cases are emitted as `BLOCKED`; the command does not fabricate observations.

## 5. Transaction and retry protocol exercised

Every logical mutation uses direct driver queries to:

1. `BEGIN ISOLATION LEVEL READ COMMITTED`;
2. apply 2,000 ms `lock_timeout` and 5,000 ms `statement_timeout`;
3. execute the owner-scoped `financial_accounts ... WHERE id = $1 AND user_id = $2 FOR UPDATE` lock first;
4. perform post-lock idempotency lookup;
5. compare expected `financial_state_version` and latest snapshot;
6. acquire snapshot, transaction, and occurrence rows in global order;
7. mutate atomically, increment `financial_state_version` once, insert idempotency result and audit metadata;
8. `COMMIT`.

Only `55P03`, `40P01`, and `40001` retry, once, after a recorded 25–75 ms jitter. The connection is released before backoff. `57014` never retries. An 8,000 ms logical database deadline spans the operation; a deadline that prevents confirmed cleanup evicts the handle and returns the stable timeout result. After a failed statement, the harness proves `25P02`, issues `ROLLBACK` on the same handle, consumes the driver's exact `ReadyForQuery(I)` boundary, checks idle transaction state, and only then releases/retries. Loss of rollback acknowledgement destroys the handle and prohibits retry.

`40P01` and `40001` are deterministically raised by a PostgreSQL PL/pgSQL evidence function so the real driver receives those SQLSTATEs and the real transaction enters failed state. `55P03` uses an actual row lock and PostgreSQL lock timeout. `57014` uses an active `pg_sleep` query cancelled through `pg_cancel_backend`; it is not an application exception.

## 6. Deterministic barriers

Winner-order tests do not rely on timing sleeps. The designated winner acquires the account row and waits at an in-process barrier. The loser starts a separate PostgreSQL transaction; an observer verifies its ungranted lock/`pg_blocking_pids` state. Only then does the harness release the winner. Polling observes an already-forced database state; it does not choose the winner.

FIN-RACE-08 holds account A while proving account B commits before A is released. It also submits a deliberately descending multi-account request against a concurrent single-account writer and proves UUID-sorted account locks are all acquired before narrower snapshot locks. A rank guard records account → snapshot → transaction → occurrence → result ordering and deliberately rejects a child-before-account test path.

## 7. Commit fault injection

FIN-RACE-07 uses connection/wire faults, not thrown application substitutes:

- socket destruction before `COMMIT` dispatch;
- a one-connection PostgreSQL wire relay that accepts `COMMIT` from the driver but closes upstream before forwarding it (original rollback branch);
- the relay forwards `COMMIT`, observes upstream `CommandComplete` plus `ReadyForQuery(I)`, suppresses those frames from the driver, then closes both sockets (committed/acknowledgement-lost branch);
- connection loss after acknowledged commit but before the caller receives a result;
- a blocked one-attempt same-key recovery that must return `FINANCIAL_RESULT_UNKNOWN` without a nested retry.

For Supabase TLS, the relay negotiates TLS with the upstream while the local one-use client side remains loopback-only. It forwards authentication frames without logging payloads. It records protocol message types/status only.

## 8. Evidence outputs

Each run writes ignored, permission-restricted artifacts under:

```text
.artifacts/spec-fin-02/<run-token>/
  evidence.json
  evidence.sha256
  summary.md
```

Artifacts include frozen source commit, current harness commit/dirty marker, migration digest, Node/driver/PostgreSQL versions, endpoint class and pool mode, pool settings, timestamp, case/order/repetition, safe correlation token, SQLSTATE, attempt/backoff, cleanup/eviction, transaction/handle tokens, counts, timings, assertions, and reproduction command for failures. They exclude connection strings, passwords, raw idempotency keys, and real financial/user data; endpoint metadata is reduced to provider class, port, SSL mode, and declared pool mode.

## 9. PASS semantics

A case can be `PASS` only after it executed against PostgreSQL and recorded at least one successful assertion with no failure. `FIN-RACE-01`–05 additionally require at least 100 repetitions for every forced order and zero forbidden outcomes. The runner also emits `FAIL`, `NOT RUN`, and `BLOCKED`; test code existence is never PASS.

Even a complete PASS does not itself approve the evidence. Named mandatory owners must review the artifacts under the governance process. This harness never changes SPEC-FIN-02 from OPEN, ADR-009 from Proposed, Issue #3, or the CLOSED Implementation Gate.

## 10. Supabase and environment limitations

- Prefer the Supabase **direct database endpoint** for closure evidence. Session pooling may be usable if backend/session boundaries remain observable.
- Transaction pooling is intentionally `BLOCKED` for FIN-RACE-06 and FIN-RACE-07 because one application connection cannot prove physical backend reuse, rollback-idle lifecycle, or the required session/commit boundary. Run other selected cases separately if useful, but do not call that complete closure evidence.
- If the role cannot observe its lock waits, cancel its own backend, create PL/pgSQL functions, or use concurrent connections, affected cases fail or block; the harness does not downgrade the oracle.
- Network appliances that prevent the loopback fault relay from reaching the Supabase endpoint block FIN-RACE-07.
- The configured 500 ms cleanup reserve is evidence-harness instrumentation recorded in artifacts; it does not silently amend or approve the frozen candidate's policy values.
- PostgreSQL/Supabase runtime tests have not run until a real `DATABASE_URL` execution produces artifacts. Local `corepack pnpm run evidence:test` validates the harness itself only.
