# Milestone 01 — financial foundation implementation trace

**Implementation date:** 2026-10-08<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Scope:** Smallest vertical financial foundation only<br>
**Production readiness:** Not claimed

The accepted SDD files remain unchanged. This implementation applies their financial contracts without introducing alternate snapshot, occurrence, domain-link, locking, retry, or idempotency semantics.

## Delivered structure

```text
/apps/api                 Fastify composition, trusted-principal boundary, routes, OpenAPI
/packages/config          validated runtime configuration and frozen candidate bounds
/packages/contracts       strict Zod HTTP request/response contracts
/packages/domain          integer money, local-date classification, balance invariants, safe errors
/packages/database        Drizzle schema, reviewed SQL migration, repositories, serialization
/packages/database/test   unit/static tests and conditional real-PostgreSQL integration test
```

The root is a pinned pnpm workspace using Node.js 22, TypeScript, Vitest, Fastify, Zod, node-postgres, and Drizzle. Runtime dependencies reported only `Apache-2.0`, `BSD-3-Clause`, `ISC`, and `MIT` licenses in the kickoff check. `pnpm audit --prod` reported no known vulnerabilities on 2026-10-08; this is a point-in-time package-manager result, not a security approval.

## HTTP surface

All protected endpoints derive `userId` from an injected trusted authenticator. Owner/account/currency/balance-effect fields are not accepted from request bodies.

| Method | Path | Foundation contract |
|---|---|---|
| `GET` | `/api/v1/financial-account` | Latest authoritative snapshot, current-segment components, current balance, and financial-state version |
| `POST` | `/api/v1/financial-account/snapshots` | Idempotent manual known-balance snapshot with reviewed version/latest-snapshot preconditions |
| `GET` | `/api/v1/transactions` | Owner-scoped bounded keyset page ordered by local occurrence date and UUID |
| `POST` | `/api/v1/transactions` | Idempotent posted transaction with server-derived anchor/effect/currency and exact classification checks |
| `GET` | `/api/v1/transactions/{id}` | Owner-scoped transaction lookup with absent/unowned equivalence |
| `GET` | `/openapi.json` | Generated OpenAPI contract; server base is `/api/v1` |
| `GET` | `/health/live`, `/health/ready` | Process and dependency health without configuration disclosure |

Account bootstrap and user creation are internal application services in this milestone; no unauthenticated registration/onboarding HTTP shortcut was added.

## SDD traceability

| Milestone item | Implementation | Automated check/evidence |
|---|---|---|
| Project/application skeleton | Root workspace; `apps/api`; `packages/config`, `contracts`, `domain`, `database` | TypeScript composite build/typecheck |
| PostgreSQL connection/migrations | `packages/database/src/pool.ts`, checksum/advisory-lock migration runner, separate `MIGRATION_DATABASE_URL`, reviewed `0001_financial_foundation.sql` | Migration static-contract tests; conditional PostgreSQL migration test |
| Users | `PostgresUserRepository`; normalized unique email, verified/active status, locale/timezone/base currency | Input validation unit test; conditional PostgreSQL integration test |
| One aggregate account | `FinancialAccountBootstrapService`; user lock + uniqueness + initial snapshot + audit + idempotency in one transaction; financial version starts at `1` | Bootstrap order/digest/uncertain-commit unit tests; conditional integration test |
| Immutable snapshots | Composite owner/account/currency constraints; immutable trigger; unique `(account_id, effective_at)`; strictly later/non-future application check | Migration contract tests; domain/API tests; conditional integration test |
| Transactions | Positive BIGINT magnitude, kind/category compatibility, current/historical effect, inclusion meaning, classification, unexpected flag, status/correction-chain constraints | Domain/contract/migration tests; conditional integration test |
| Current balance | `financial_current_balances` uses only latest snapshot + posted/current transactions on that snapshot; bigint range check; negative values allowed | Pure invariant tests; migration static test; conditional integration test |
| Server-side ownership | Trusted principal injected by auth boundary; every private repository query includes `user_id`; client authority fields rejected | Fastify injection BOLA/mass-assignment tests; conditional two-user PostgreSQL lookup |
| Financial-state versioning | Dedicated BIGINT, initialized at `1`, account guard trigger, exactly one `+1` update for one winner | Serialization unit tests; conditional PostgreSQL test |
| Account-row serialization | Explicit `READ COMMITTED`; owner-scoped account `FOR UPDATE` first; post-lock idempotency then latest-snapshot lock/revalidation | Ordered-query unit tests; real FIN-RACE evidence remains blocked |
| Bounded cleanup/retry | Exact SQLSTATE set `55P03`, `40P01`, `40001`; one retry; `57014` no retry; awaited same-handle `ROLLBACK`; unconfirmed handle destroyed | Deterministic protocol unit tests for every code and cleanup failure; not PostgreSQL evidence |
| Idempotency | SHA-256 key/request digests, account/user partial unique scopes, bounded JSON result, terminal stale receipt, replay before stale check, configurable retention | Replay/digest/stale/unknown-result unit tests; conditional integration test |
| Uncertain commit | One same-key recovery attempt; no new key and no nested retry; explicit `FINANCIAL_RESULT_UNKNOWN` fallback | Account serialization and bootstrap unit tests; FIN-RACE-07 remains blocked |
| API/data contracts | Strict Zod bodies, bigint strings, opaque UUIDs, bounded input, stable safe error envelope, generated OpenAPI, `no-store` | Contract and Fastify injection tests |

## Database integrity delivered

Migration `0001` provides:

- same-owner/same-account/same-currency composite foreign keys;
- exactly one aggregate account per user;
- immutable snapshots and audit events;
- append-only transaction authority fields, reviewed posted-to-voided transition support, same-owner correction source, and unique linear successor;
- required category/type compatibility and the PRD default expense-category coverage;
- no floating-point persisted money;
- digest-only idempotency keys and bounded result JSON;
- current-balance view anchored only to the deterministic latest snapshot segment.

Critical transaction control uses reviewed explicit SQL on a checked-out node-postgres connection. Drizzle supplies typed schema metadata and the normal database runtime; raw SQL is retained where PostgreSQL lock order, transaction lifecycle, `SET LOCAL`, and exact cleanup behavior must remain inspectable.

## Tests actually available

- Unit/domain/contract/API/static-protocol suites run without credentials.
- The integration suite in `packages/database/test/financial-foundation.integration.test.ts` requires both `TEST_DATABASE_URL` and `KFIN_INTEGRATION_TARGET=non-production` and otherwise reports skipped.
- The integration suite creates an isolated disposable schema, applies the actual migration, exercises user/bootstrap/transaction/replay/current-balance/new-snapshot/stale/owner-isolation behavior, then drops the schema.
- GitHub Actions run [`37751446740`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37751446740) executed that guarded test successfully against an ephemeral synthetic PostgreSQL 17.6 service after two transparently retained failed correction runs.
- The independent FIN-02 closure harness remains separate under `evidence/spec-fin-02`; the foundation integration test is not a substitute for `FIN-RACE-01..08`.

Execution results are recorded only after commands run; see the change-set verification section below and the separate [kickoff evidence status](../evidence/2026-10-08-IMPLEMENTATION-KICKOFF-STATUS.md).

## Known limitations and OPEN items

1. No `DATABASE_URL`/`TEST_DATABASE_URL`, PostgreSQL binary, container runtime, or Supabase target was available in the local Arena environment, so the local integration command skipped. GitHub Actions did execute the foundation integration test successfully against ephemeral PostgreSQL 17.6; this is narrow implementation evidence, not Supabase, production, or FIN-RACE closure evidence.
2. `FIN-RACE-01..08` remain **BLOCKED** and unexecuted, and current FIN-RACE-08 harness scope still predates the complete accepted domain-claim matrix.
3. `FIN-LINK-01..06` and `FIN-OCC-01..04` remain **NOT RUN — implementation prerequisite**. Schedule, debt, purchase, and occurrence services are deliberately out of this milestone.
4. Authentication/session delivery is not implemented. The standalone server fails all protected routes closed; tests inject a trusted principal. No user-ID header or development bypass is accepted.
5. PostgreSQL RLS remains a proposed defense-in-depth decision, not silently accepted here. Application owner scoping and composite database constraints are implemented; RLS approval/role-policy evidence remains OPEN.
6. Migration-role provisioning, runtime GRANTs, managed TLS certificates, backups, deployment, and production pool-mode configuration are environment/operations work not completed here.
7. Correction/void HTTP flows and complete owning-domain link writers are not exposed. The transaction schema prepares append-only correction-chain constraints but does not claim FIN-COR or FIN-LINK evidence.
8. An approved idempotency retention value is required at startup; there is deliberately no silent default. Expiry pruning/background jobs remain out of scope.
9. The frozen 2 s/5 s/8 s/25–75 ms/one-retry/2 s recovery values remain unvalidated candidate values. Their use makes the protocol executable; it does not approve them for production.
10. Immutable-history purge/deletion procedure, migration/runtime database privileges, observability metrics, CSRF/origin controls, rate limits, web/PWA, and release operations remain outside this vertical and OPEN under their existing gates.
11. Dependency audit and license output are point-in-time tooling observations only; mandatory security, data, architecture, financial-integrity, governance, and legal reviews remain OPEN.

No genuine contradiction in the frozen FIN-01/FIN-02 financial contracts was encountered during this milestone. No frozen semantic was changed.

## Change-set verification

Local verification on 2026-10-08 observed:

- frozen pnpm install completed from `pnpm-lock.yaml`;
- FIN-02 harness syntax/static check completed (`25` modules, `29` harness files);
- FIN-02 harness unit/static suite executed `16/16` passing tests;
- TypeScript application and test typecheck completed;
- credential-free Vitest suite executed `43` passing tests with `0` failures;
- the one conditional PostgreSQL integration test was skipped locally because no target was configured;
- explicit credential-free FIN-02 evidence execution returned exit code `2`, overall `BLOCKED`, PostgreSQL `NOT OBSERVED`, and no FIN-RACE runtime assertions;
- production dependency audit reported no known vulnerabilities and production package metadata listed only Apache-2.0, BSD-3-Clause, ISC, and MIT licenses; and
- `git diff --check` completed successfully.

GitHub Actions subsequently recorded two failed correction runs and then successful run [`37751446740`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37751446740) on `d8213b4b12e25b69b2679af4552afd88da46c27d`. The successful run completed the harness checks, typecheck, `43` credential-free tests, and the single isolated foundation integration test against PostgreSQL 17.6. The integration failure exposed PostgreSQL `date` decoding at the driver boundary; the implementation now explicitly selects date-only values as text before domain classification.

See [Milestone 01 verification](../evidence/2026-10-08-MILESTONE-01-VERIFICATION.md) for the commands, run history, boundaries, artifact digest, and retained OPEN statuses. A passing foundation integration command must not be interpreted as FIN-RACE closure, Supabase behavior evidence, owner approval, production readiness, or release evidence.
