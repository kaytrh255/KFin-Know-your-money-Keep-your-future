# Private Beta implementation — 2026-10-17

Implementation of the three blockers in
`docs/evidence/2026-10-17-PRIVATE-BETA-RELEASE-READINESS.md`.
Base `caa43a8`; no production or Supabase access, PR #10 stays draft.

| Commit | Scope |
|---|---|
| `b3fb761` | Resend adapter, provider configuration and production mail guard |
| `a48862b` | Deployable artifact, single-origin static serving, production smoke test |
| `52a104c` | Backup/restore scripts and drill, migration-failure tests, runbooks |
| `a4f6962` | Executable bits for the operator scripts |
| `75f9c89` | Pinned PostgreSQL client binaries, drill failures as CI annotations |
| `031d038` | Pinned `ubuntu-24.04` runner (PGDG repository stability) |

The six commits above touch 25 files, +2174/−19.

## 1. Production runtime — PASS (executed locally and in CI)

`pnpm run build` typechecks and assembles `apps/api/dist`:
`server.bundle.mjs` (all `@kfin/*` packages inlined), `migrate.bundle.mjs`,
`provision-invitation.bundle.mjs`, `migrations/`, `web/` and `BUILD-INFO.json`.
The build fails if the server bundle references `tsx` or TypeScript modules.
`apps/api` now starts with `node dist/server.bundle.mjs`; `tsx` is only used by
`pnpm run api:dev`.

The API serves the compiled client itself (`apps/api/src/static-site.ts`), so
staging keeps the no-CORS, same-origin design. Behaviour pinned by 11 tests:
HTML entry point, JS/CSS content types, missing asset → `404 text/plain`, SPA
fallback, `/api/*` → JSON 404, `ETag`/`304`, `HEAD`, `nosniff`, traversal refusal,
and fail-fast when `index.html` is missing.

**Smoke test** (`pnpm run smoke:production`) starts the real bundle with
`NODE_ENV=production` and checks 12 conditions, including that the process still
refuses to boot with insecure cookies or without email delivery.

- Local, 2026-10-17: **12/12 pass**.
- CI run `39020443013`: **Build**, **Smoke test the production artifact** and
  **Backup and restore drill** all succeeded; no step failed.

## 2. Email delivery — PASS for the adapter, NOT VERIFIED for a real send

`ResendEmailAdapter` posts `POST /emails` with the API key in the header and the
six-digit code only in the body; plain-text templates, 5 s timeout, bounded
references (`resend-http-<status>`, `resend-unreachable`), no provider body read
or logged, no secret in the result. `NODE_ENV=production` now refuses any adapter
other than `resend`; `resend` requires `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS`.

Eight adapter tests use a local HTTP double: contract shape, reply-to, 401/422/429/500
mapping, unreachable provider, timeout, missing-secret refusal, and construction
guards. Three configuration tests cover the production requirement and credential
pairing. Executed: **19/19** in `apps/api/test/email-delivery.test.ts`,
**19/19** in `packages/config/test/index.test.ts`.

Still missing (external, cannot be fabricated):
- a Resend account, a **verified sending domain** and an API key;
- one real invitation/reset message delivered to an external mailbox;
- an operator runbook decision on who holds the provider account.

Configuration to supply at deploy: `EMAIL_DELIVERY_ADAPTER=resend`,
`RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, optional `EMAIL_REPLY_TO`.

## 3. Backup and restore — PASS on disposable databases

Scripts: `backup-database.sh` (custom-format dump, refuses overwrite, 30 s lock
wait, archive list check, SHA-256), `restore-database.sh` (empty-target guard,
single transaction, exit on first error), `verify-restore.mjs` (per-table row
count and content checksum, migrations, RLS flags and policies, role grants,
sequences), `backup-restore-drill.mjs` (creates two throwaway databases,
provisions roles, migrates with the production bundle, seeds, dumps, restores,
verifies, drops).

Drill results:

| Run | Tables | Rows | Dump | Restore | Differences |
|---|---|---|---|---|---|
| local `a4f6962` | 19 | 28 | 77–103 ms | 117–174 ms | 0 |
| CI `39020443013` (annotation) | 19 | 28 | 171 ms | 275 ms | 0 |

The restored database also passed `db:verify-app-role` (159 checks) and served
14 category rows to `kfin_app`. The timings are for an almost-empty database and
prove the procedure, not the RTO.

Still missing: a scheduled backup, retention/encryption storage, Supabase
PITR/backup configuration, and a restore into staging. RPO/RTO targets are
proposed in `docs/operations/BACKUP-AND-RESTORE.md`, not approved.

## 4. Migration failure — PASS (4 tests)

`packages/database/test/migration-atomicity.integration.test.ts` proves on real
PostgreSQL that a failing file leaves no objects and no `kfin_migrations` row,
that earlier files stay applied when a later file fails, that an edited applied
migration is refused by the checksum guard, and that an unchanged set is a
no-op. Executed: **4/4**.

## Test evidence

| Command | Result |
|---|---|
| `pnpm run check` | 736 passed, 0 failed, 150 skipped (integration suites), SQL guard 0 violations |
| `pnpm run test:integration` | 150 passed / 13 files |
| `pnpm run build` | artifact complete; 11 migrations copied |
| `pnpm run smoke:production` | 12/12 (local) and green in CI |
| `pnpm run backup:drill` | pass locally and in CI, 0 differences |
| CI `39020321914`, `39020443013` | success; first attempt `39020188878` failed in the drill because the image's default `pg_dump` was older than the server — fixed by pinning `/usr/lib/postgresql/17/bin/*` |

## Remaining blockers

| Item | Verdict | What closes it |
|---|---|---|
| Artifact, start, same-origin serving | **PASS** (local + CI) | — |
| Real email delivery | **NOT VERIFIED** | provider account, verified domain, one delivered message |
| Backup schedule / PITR on a live database | **NOT VERIFIED** | staging database with backups enabled and a restore from it |
| Staging host, TLS, secret store, deploy job | **BLOCKED** | an environment and a deploy path; none exists yet |
| Log shipping, metrics, alerts | **BLOCKED** | still nothing consumes the JSON logs or health probes |
| Browser E2E against a deployed instance | **NOT VERIFIED** | a staging run of the 13-step journey |

## Decision

**Building staging can start now: YES.** The repository produces a runnable,
smoke-tested artifact, serves client and API on one origin, has a tested email
adapter, and has an executed backup/restore and migration-failure procedure.

**Inviting Private Beta users is not justified yet: NO.** It still needs a real
mail credential on a verified domain, a staging environment with TLS/secrets and
a deploy job, and monitoring. None of those can be produced from the repository
alone.
