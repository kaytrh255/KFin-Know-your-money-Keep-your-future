# Private Beta Release Readiness — 2026-10-17

**Question:** is deployment to a staging environment justified?
**Answer:** **NO** — see the decision at the end.

**Evidence base:** repository at `c3115a3` (PR #10, draft) only. No staging or production
environment exists, so nothing below is a measured real-world result.
**Rule applied:** a document describing a control is never evidence that the control exists.
Only code, configuration, automated tests and executed commands count. `RELEASE-CHECKLIST.md`
is a template — every item is unchecked and it states *"Implementation Gate: CLOSED"* — so it
is used as the item list, never as a pass.

## Summary

| # | Item | Verdict |
|---|------|---------|
| 1 | Environment config contract and fail-fast validation | **PASS** |
| 2 | Staging/production environment, real secrets, rotation | **NOT VERIFIED** |
| 3 | Deployable production artifact and same-origin serving topology | **BLOCKED** |
| 4 | Migrations on an empty database | **PASS** |
| 5 | Migrations on an existing populated database, managed Postgres/TLS | **NOT VERIFIED** |
| 6 | Backup and restore drill | **BLOCKED** |
| 7 | Health probes | **PASS** |
| 8 | Logging pipeline, monitoring, alerting | **BLOCKED** |
| 9 | Cookie, CSRF and origin defenses in code | **PASS** |
| 10 | HTTPS/TLS and security headers in a deployed path | **NOT VERIFIED** |
| 11 | Registration and login flow against real PostgreSQL | **PASS** |
| 12 | Email delivery for invitation, OTP and reset | **BLOCKED** |
| 13 | Application and database rollback | **BLOCKED** |
| 14 | Staging environment and end-to-end staging run | **BLOCKED** |

## Pass items (evidence only, no action requested)

- **1 — Config contract.** `packages/config/src/index.ts` validates the whole environment with a
  Zod schema at boot and throws before the listener opens: `DATABASE_URL` must be a PostgreSQL
  URL, `DATABASE_SSL_MODE` defaults to `verify-full`, `IDEMPOTENCY_RETENTION_HOURS`,
  `FINANCIAL_PREVIEW_SIGNING_KEY` and `AUTH_SECRET` are mandatory (the last two must be 64 hex
  characters), `AUTH_ALLOWED_ORIGINS` must be empty, and `NODE_ENV=production` refuses
  `AUTH_COOKIE_SECURE=false` and `EMAIL_DELIVERY_ADAPTER=file`. `.env.example` documents every
  key with no values, and `packages/config/test/index.test.ts` has 16 tests covering exactly
  these refusals (including the `AUTH_ALLOWED_ORIGINS` rejection and the secure-cookie default).
- **4 — Fresh-database migrations.** `packages/database/src/migrations.ts` takes a PostgreSQL
  advisory lock, checksums each file into `kfin_migrations` and applies each migration in its own
  transaction with lock/statement timeouts; 11 migrations applied from empty in this session, and
  the CI step *"Apply migrations as the migration role"* runs the same path as `kfin_migrator`.
- **7 — Health probes.** `apps/api/src/app.ts:271-279` serves `/health/live` and `/health/ready`;
  readiness runs `SELECT 1` and returns 503 when the database is unavailable.
- **9 — Cookie/CSRF code.** `apps/api/src/session-transport.ts`: `__Host-`-prefixed, `Secure`,
  `HttpOnly`, `SameSite=Lax` session cookie; `Secure`, `SameSite=Strict` readable CSRF cookie;
  double-submit `x-kfin-csrf`; a state-changing request is rejected at `onRequest` unless
  same-origin or `Sec-Fetch-Site: same-origin|none`. Covered by `session-transport.test.ts`,
  `auth-routes.test.ts` and `auth-write-defense.test.ts`.
- **11 — Registration/login.** `apps/api/test/journey.integration.test.ts` runs 13 ordered tests
  against a real PostgreSQL: invitation admission, registration, cookie-only sign-in, password
  change with session rotation, and password reset through the mailed OTP.

## Gaps

### 2 — Environment and secrets — NOT VERIFIED
- **Missing:** no staging or production environment definition, no secret store, no record that a
  real `AUTH_SECRET`/`FINANCIAL_PREVIEW_SIGNING_KEY` was generated, loaded or rotated. (CI proves
  the *schema*, not that an operator can supply it.)
- **Minimum action:** stand up one staging environment; inject secrets from a secret manager;
  record a run proving the API boots with `NODE_ENV=production`, `DATABASE_SSL_MODE=verify-full`
  and real secrets; write the rotation step (rotate `AUTH_SECRET` ⇒ all sessions invalidated).

### 3 — Production artifact and serving topology — BLOCKED
- **Missing:** no `Dockerfile`, compose file, PaaS/Kubernetes manifest or deploy job anywhere
  (CI has 12 verify steps and no environment). `tsc -b` does emit `apps/api/dist`, but nothing
  packages or runs it: the package has no build/start over `dist`, `pnpm api:start` is
  `tsx src/server.ts`, and `tsx` sits in `devDependencies` — an install without dev dependencies
  cannot start the API at all. The web client is served only by `tools/dev-server.mjs`, a
  development proxy that rebuilds at startup; there is no production same-origin front end, which
  the no-CORS design requires.
- **Minimum action:** make `dist` the runtime entry (or ship a runtime image) **and** add a
  production static server/reverse proxy that serves `apps/web/dist` and forwards `/api/*`,
  `/health/*`, `/openapi.json` on one origin; start it with `NODE_ENV=production`.

### 5 — Migrations on an existing database — NOT VERIFIED
- **Missing:** migrations are forward-only and checksum-pinned with no down path; no test or run
  upgrades a **populated** database from version N-1 to N; every run so far used a local cluster
  with `DATABASE_SSL_MODE=disable`, so the `verify-full` path to a managed PostgreSQL is untested.
- **Minimum action:** clone a staging database with representative data at the previous schema
  version, apply the new migration, assert row counts/checksums and application boot afterwards;
  repeat once against the managed provider with TLS verification on.

### 6 — Backup and restore — BLOCKED
- **Missing:** no backup mechanism at all — no snapshot/PITR configuration, no `pg_dump` script,
  no retention policy, no storage target, no restore script and no drill record. `pg_dump`,
  `pg_basebackup`, WAL archiving and restore appear nowhere in the repository outside prose, and
  `docs/README.md:126` still records that *no restore test has occurred*.
- **Minimum action:** enable provider snapshots/PITR with a stated RPO, plus a logical dump
  schedule; restore into an isolated database, then verify migration checksums, role provisioning
  and row counts, and record the measured RTO.

### 8 — Logging, monitoring, alerting — BLOCKED
- **Missing:** `server.ts` boots Fastify with `logger: true`, so JSON logs go to stdout and stop
  there — no aggregation, retention, redaction rules, metrics, alerting, dashboards, error
  tracking or on-call route. Health endpoints exist but nothing consumes them.
- **Minimum action:** ship logs to a store with retention and a redaction rule set; add an
  uptime check on `/health/ready`, an alert on 5xx rate and on database unavailability, and one
  operator-visible dashboard; prove it with a deliberately failed readiness check.

### 10 — HTTPS and headers in a deployed path — NOT VERIFIED
- **Missing:** no TLS terminator, certificate handling or HSTS/`X-Content-Type-Options`/
  `frame-ancestors`/`Referrer-Policy` configuration; no request has ever traversed a real HTTPS
  proxy. The API never consults `X-Forwarded-Proto` (only the development proxy does, at
  `tools/dev-server.mjs:199`), so a proxy that rewrites the scheme is untested.
- **Minimum action:** terminate TLS at the staging proxy, set the four headers there, then verify
  from a real browser that the session cookie carries the `__Host-` prefix and that a plain-HTTP
  request is redirected.

### 12 — Email delivery — BLOCKED
- **Missing:** `apps/api/src/email-delivery.ts` ships exactly three adapters — `none` (every send
  fails), `memory` (unreadable), `file` (writes the one-time secret to disk and is refused in
  production). No vendor adapter exists; provider selection is deferred to Phase 6 (OQ-17). An
  invited beta user therefore cannot receive an invitation, an OTP or a reset code. Invitations
  themselves are issued by an operator-only CLI (`apps/api/tools/provision-invitation.ts`) with
  no documented operational runbook.
- **Minimum action:** implement/configure one transactional email adapter, send one real
  invitation + one OTP + one reset through it to an external mailbox, and document the invitation
  issuance step for operators.

### 13 — Rollback — BLOCKED
- **Missing:** no deployable previous version to roll back *to* (see 3), no down migrations, no
  restore point (see 6), no rollback runbook, no rehearsal. A failed deployment today can only be
  rolled forward by hand.
- **Minimum action:** keep the last two artifacts deployable, document the rollback procedure
  (redeploy N-1 against an N database, plus the forward-fix rule for irreversible migrations) and
  rehearse it once in staging with a timing record.

### 14 — Staging testing — BLOCKED
- **Missing:** no staging environment, no deploy workflow, no end-to-end run against a deployed
  instance (the 13-step journey runs in CI against a local database), no browser-level test.
- **Minimum action:** deploy behind the staging URL, run the journey against it, run the smoke
  script, and record the results with the artifact version and migration count.

## Decision

**Is staging deployment justified? NO.**

Top blockers:
1. **Nothing to deploy.** No artifact, no manifests and no deploy job; the API only runs under
   `tsx`, and the client is served by a development-only proxy. Staging cannot be stood up from
   this repository as it stands.
2. **No way to deliver mail.** Only `none`/`memory`/`file` adapters exist, so an invited beta user
   cannot complete registration, verification or reset.
3. **No recovery path.** No backup, no restore drill and no rollback target; a bad migration or
   data loss in staging would be unrecoverable, which makes even a staging rehearsal unsafe.

Before any external user traffic, also close items 2, 8 and 10 (real secrets, monitoring, HTTPS).
*Documentation note (not a blocker):* `docs/README.md:123` still states that no application code,
infrastructure, schema migration or executable test has been created. That is stale and should be
corrected before the docs are used to brief anyone.

This report does not change the status of SPEC-SEC-01, PR #10 remains draft, and nothing has been
deployed.
