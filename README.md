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
- Trusted Private Beta access: digest-only single-use invitations, Argon2id registration admitted by the invitation code alone (usable account, email explicitly unverified, no verification email), opaque rotating sessions with CSRF/origin defense, session list/revocation, known-password change, password reset by a single-use six-digit emailed OTP that revokes every session, and sanitized security history;
- authenticated financial-account onboarding (`POST /api/v1/financial-account`: atomic account + opening snapshot + idempotency receipt, replay, duplicate-account `409`, CSRF-protected) and owner-scoped listing from `financial_current_balances` (`GET /api/v1/financial-accounts`);
- savings goals (`/api/v1/savings-goals`): create, list by status, plan edits, absolute current-amount updates with immutable old/new history, optimistic versions, idempotent CSRF-protected mutations, and terminal archive; a goal is a declared reserve and never changes the account balance or monthly actuals;
- schedule-linked correction pointer transfer and linked standalone-void rejection;
- unit/API/static-contract tests plus guarded real-PostgreSQL foundation, correction, schedule, access, onboarding, and savings-goal integration suites.

Access secrets are never persisted in plaintext: invitation codes, reset OTPs, session tokens, and CSRF tokens are stored only as purpose-separated keyed digests. Unauthenticated outcomes stay generic so a missing account, a consumed invitation, an expired code, and a wrong password are indistinguishable. Invitation provisioning has no HTTP route; it remains an audited operator procedure.

> **Specification revision 2026-10-12 (OQ-20), implemented.** Registration admits an account on the
> invitation code alone — no OTP, no email composed or sent, no session — and leaves the address
> explicitly unverified rather than marked verified. The emailed six-digit OTP exists only for
> password reset, is single-use with a 10-minute lifetime, five attempts, a 60-second cooldown, a
> cumulative per-account failure budget, and 3-per-hour / 6-per-day issuance caps; reset revokes
> every session and issues none. `/api/v1/auth/verify-email` and `/api/v1/auth/verification/resend`
> no longer exist. Implemented by
> [`docs/implementation/MILESTONE-11-OTP-RESET-ONLY.md`](docs/implementation/MILESTONE-11-OTP-RESET-ONLY.md)
> on top of the revision
> [`docs/evidence/2026-10-12-AUTH-POLICY-SPECIFICATION-REVISION.md`](docs/evidence/2026-10-12-AUTH-POLICY-SPECIFICATION-REVISION.md)
> (**not merged, not deployed**; `SPEC-AUTH-01`/`SPEC-AUTH-02` remain open owner decisions).

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

### Running it locally

[`docs/development/LOCAL-DEVELOPMENT.md`](docs/development/LOCAL-DEVELOPMENT.md) is the single runbook: environment names, migrations, how to complete the email flows on a local machine without a provider, and how to mint the first invitation. It documents the **current implementation**, which the 2026-10-12 specification revision changes for registration.

```bash
cp .env.example .env            # fill in locally; never commit it
corepack pnpm run db:migrate    # local/disposable database only
corepack pnpm run api:dev       # terminal 1
corepack pnpm run web:dev       # terminal 2, serves the local testing client
corepack pnpm run invite:provision
```

`apps/web` is a **local testing client**, not a product surface: one form per implemented API flow, no stub endpoints, no seeded data. Browser writes must be same-origin, so the dev server proxies `/api/*` to the API rather than the client calling another port.

## Production runtime

Deployment does **not** run `tsx` or `tools/dev-server.mjs`. The build produces one artifact in
`apps/api/dist` and one process serves both the compiled client and the API on the same origin,
which is what the same-origin-only browser transport requires.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run build                  # tsc -b + scripts/build-production.mjs
corepack pnpm run start                  # node apps/api/dist/server.bundle.mjs

# prove it before deploying (needs a non-production database)
DATABASE_URL=... AUTH_SECRET=... FINANCIAL_PREVIEW_SIGNING_KEY=... \
IDEMPOTENCY_RETENTION_HOURS=24 corepack pnpm run smoke:production

# prove the artifact survives a production-only install (no devDependencies, no tsx)
corepack pnpm run verify:production-install
```

The artifact contains `server.bundle.mjs`, `migrate.bundle.mjs`,
`provision-invitation.bundle.mjs`, `migrations/`, `web/`, `runtime-package.json` (the exact
production dependency set) and `BUILD-INFO.json`. A production start refuses to boot without
secure cookies, without the `resend` mail adapter, or without `web/index.html`.

The deployment unit is a container image built from the repository root:

```bash
corepack pnpm run image:build            # docker build -t kfin-runtime:local .
docker run --env-file /run/kfin.env -p 3000:3000 kfin-runtime:local
```

TLS, the public hostname, the secret store and log shipping belong to the host in front of the
container. See [`docs/operations/PRODUCTION-RUNTIME.md`](docs/operations/PRODUCTION-RUNTIME.md).
There is still no staging environment, and none of this has been deployed.

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
