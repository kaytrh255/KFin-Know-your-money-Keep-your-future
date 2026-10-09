# KFin — Know your money, Keep your future

KFin is a production-oriented personal finance platform designed for an initial Private Beta of at most 50 real users.

## Current phase

**The financial foundation, append-only transaction-correction, one-off schedule-occurrence, Trusted Private Beta access, authenticated financial-account onboarding, and savings-goal milestones are implemented for QA review.**

The accepted and frozen implementation baseline is commit `a48d2c5683550859c1b4e19e9d06750616adc0a2`. Implemented scope includes users, one aggregate account, immutable balance snapshots, posted transactions, authoritative current balance, ownership enforcement, financial-state serialization/versioning, idempotency, authoritative correction/void previews, append-only void + replacement, correction history, amended monthly actuals, and explicitly confirmed one-off income/essential-expense occurrences.

This implementation does **not** resolve unavailable owner approvals, accept proposed ADRs, validate candidate timeout values, establish Supabase/production behavior, or close pre-existing governance/security/legal/release blockers. Release Candidate and Private Beta gates remain closed until their actual criteria are met.

Start with the [KFin Specification Foundation](docs/README.md), [Milestone 01 trace](docs/implementation/MILESTONE-01-FINANCIAL-FOUNDATION.md), [Milestone 02 trace](docs/implementation/MILESTONE-02-TRANSACTION-CORRECTIONS.md), [Milestone 03 trace](docs/implementation/MILESTONE-03-ONE-OFF-SCHEDULE-OCCURRENCES.md), [Milestone 04 trace](docs/implementation/MILESTONE-04-TRUSTED-PRIVATE-BETA-ACCESS.md), [Milestone 05 trace](docs/implementation/MILESTONE-05-FINANCIAL-ACCOUNT-ONBOARDING.md), [Milestone 06 trace](docs/implementation/MILESTONE-06-SAVINGS-GOALS.md), and the [kickoff evidence status](docs/evidence/2026-10-08-IMPLEMENTATION-KICKOFF-STATUS.md).

## Implemented foundation

- pnpm/TypeScript modular-monolith workspace;
- Fastify REST API and generated OpenAPI contract under `/api/v1`;
- Drizzle schema definitions plus reviewed forward SQL migration tooling;
- user persistence and atomic aggregate-account/onboarding-snapshot bootstrap;
- immutable balance snapshots and append-only transaction facts;
- latest-snapshot current-balance query (never a whole-history sum);
- trusted-principal owner scope at HTTP and repository boundaries;
- PostgreSQL account-row serialization, monotonic financial-state version, bounded exact-SQLSTATE retry, same-handle rollback cleanup, unsafe-handle eviction, and same-key uncertain-commit recovery;
- digest-only idempotency records and bounded result receipts;
- authoritative correction/void consequence previews with reviewed source/version/anchor context;
- append-only correction chains, standalone voids, owner-scoped history, stable stale receipts, and no silent re-anchoring;
- owner-scoped monthly actuals that exclude voided facts and identify amended groups;
- one-off scheduled income/essential-expense occurrences with exact persisted states, derived due/Paid/Received presentation, explicit confirmation, and skip/cancel;
- Trusted Private Beta access: digest-only single-use invitations, Argon2id registration, generic OTP verification with a fresh rotated session, opaque rotating sessions with CSRF/origin defense, session list/revocation, known-password change, password reset that revokes every session, and sanitized security history;
- authenticated financial-account onboarding (`POST /api/v1/financial-account`: atomic account + opening snapshot + idempotency receipt, replay, duplicate-account `409`, CSRF-protected) and owner-scoped listing from `financial_current_balances` (`GET /api/v1/financial-accounts`);
- savings goals (`/api/v1/savings-goals`): create, list by status, plan edits, absolute current-amount updates with immutable old/new history, optimistic versions, idempotent CSRF-protected mutations, and terminal archive; a goal is a declared reserve and never changes the account balance or monthly actuals;
- schedule-linked correction pointer transfer and linked standalone-void rejection;
- unit/API/static-contract tests plus guarded real-PostgreSQL foundation, correction, schedule, access, onboarding, and savings-goal integration suites.

Access secrets are never persisted in plaintext: invitation codes, OTP/reset secrets, session tokens, and CSRF tokens are stored only as purpose-separated keyed digests. Unauthenticated outcomes stay generic so a missing account, a consumed invitation, an expired code, and a wrong password are indistinguishable. Invitation provisioning has no HTTP route; it remains an audited operator procedure.

## Workspace commands

Requires Node.js 22 and the pinned pnpm version through Corepack.

```bash
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm run test:unit
corepack pnpm run test
corepack pnpm run evidence:test
```

Run reviewed migrations with a separately provisioned migration role:

```bash
MIGRATION_DATABASE_URL='postgresql://...' corepack pnpm run db:migrate
```

Run the conditional integration suite only against an explicitly designated disposable non-production PostgreSQL database:

```bash
KFIN_INTEGRATION_TARGET=non-production \
TEST_DATABASE_URL='postgresql://...' \
corepack pnpm run test:integration
```

Never commit connection strings or populated `.env` files. The checked-in [`.env.example`](.env.example) contains names and placeholders only.

## Specification areas

- [Product](docs/product/PRD.md)
- [MVP scope](docs/product/MVP-SCOPE.md)
- [SPEC-FIN-01 snapshot/correction semantics](docs/product/SPEC-FIN-01-SNAPSHOT-CORRECTION.md)
- [SPEC-FIN-02 snapshot concurrency](docs/architecture/SPEC-FIN-02-SNAPSHOT-CONCURRENCY.md)
- [Architecture](docs/architecture/ARCHITECTURE.md)
- [Database](docs/architecture/DATABASE.md)
- [Security requirements](docs/security/SECURITY-REQUIREMENTS.md)
- [Test strategy](docs/testing/TEST-STRATEGY.md)
- [Governance approval and evidence register](docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md)

The priority remains: **correct product → excellent UX → secure architecture → maintainable implementation → reliable production system**.
