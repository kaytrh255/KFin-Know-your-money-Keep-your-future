# KFin — Know your money, Keep your future

KFin is a production-oriented personal finance platform designed for an initial Private Beta of at most 50 real users.

## Current phase

**Narrow financial-foundation implementation has started.**

The accepted and frozen implementation baseline is commit `a48d2c5683550859c1b4e19e9d06750616adc0a2`. Implementation is limited to the smallest financial vertical: users, one aggregate account, immutable balance snapshots, posted transactions, authoritative current balance, ownership enforcement, financial-state serialization/versioning, and idempotency foundations.

This implementation start does **not** resolve unavailable owner approvals, accept proposed ADRs, validate candidate timeout values, provide real PostgreSQL/Supabase evidence, or close pre-existing governance/security/legal/release blockers. Release Candidate and Private Beta gates remain closed until their actual criteria are met.

Start with the [KFin Specification Foundation](docs/README.md), the [implementation milestone trace](docs/implementation/MILESTONE-01-FINANCIAL-FOUNDATION.md), and the [kickoff evidence status](docs/evidence/2026-10-08-IMPLEMENTATION-KICKOFF-STATUS.md).

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
- unit/API/static-contract tests plus a conditional real-PostgreSQL integration suite.

Authentication/session implementation is not part of this milestone. The standalone server therefore fails protected routes closed until a trusted session adapter is wired; it does not accept an insecure user-ID header shortcut.

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
