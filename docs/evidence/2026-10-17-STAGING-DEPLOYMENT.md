# Staging deployment path — 2026-10-17

Scope: build the staging deployment path for the runtime verified in
[`2026-10-17-RUNTIME-VERIFICATION.md`](2026-10-17-RUNTIME-VERIFICATION.md).
No merge, no production deployment, no production Supabase access, no mail
provider, no backup. This file records what was executed and where; it does not
claim that staging exists.

## What was added

| Commit | Change |
| --- | --- |
| `f5b5599` | `STAGING_MODE` opt-in in `packages/config`, boot warning, two config tests |
| `abff0b1` | `deploy/staging/*` Compose stack, Caddy edge, host bootstrap, deploy script |
| `1439b51` | `scripts/smoke/staging-smoke.mjs` |
| `3d3de7b` | `.github/workflows/staging.yml` (PR rehearsal + dispatch deploy) |
| `d20d18c` | `docs/operations/STAGING-DEPLOYMENT.md`, README status |
| `cc9d9eb` | Migration container gets `DATABASE_SSL_MODE`; deploy script requires it |

Hosting choice: one small Linux VM with Docker Compose — one `kfin-runtime`
container behind Caddy, with a separate PostgreSQL (a container on the same host
by default, managed PostgreSQL supported). Rationale: the runtime is one
same-origin Node process with six production dependencies, no Docker socket and
no shared state; a VM makes `TRUST_PROXY` a fixed CIDR and keeps `Host`
preservation under our control, which the CSRF and audit-trail design depend on.

## Executed here (local sandbox, no Docker)

- `corepack pnpm run build` — production artifact rebuilt from the working tree.
- The artifact was started with `NODE_ENV=production`,
  `EMAIL_DELIVERY_ADAPTER=none` and no `STAGING_MODE`:
  **refused to boot** with `EMAIL_DELIVERY_ADAPTER must be "resend" when
  NODE_ENV=production`. With `STAGING_MODE=true` the same artifact started and
  served traffic — the guard is real and the opt-in is what relaxes it.
- `scripts/smoke/staging-smoke.mjs` against that artifact behind a TLS proxy
  with a self-signed CA passed to `STAGING_CA_FILE` (chain verified, not
  skipped): **14/14 checks pass** — health live/ready, client document and
  module, CSP, HSTS (`max-age=300; includeSubDomains`), nosniff/referrer/frame
  headers, 401 on the protected route, JSON 404, 403 for a cross-origin write,
  a processed same-origin write, login, `__Host-kfin_session` with
  `HttpOnly; Secure; Path=/` and a CSRF cookie, authenticated read.
- `scripts/ops/staging-deploy.sh` under a stub `docker` (no container runtime
  here) exited 2, before any Docker call, for: missing `AUTH_SECRET`; mail-less
  `staging.env` without `STAGING_MODE`; missing `DATABASE_SSL_MODE` in
  `migration.env`; unknown `STAGING_DB_MODE`; edge network whose subnet does not
  match `TRUST_PROXY`; `STAGING_TLS_ARGS=internal` on a non-rehearsal host. The
  managed and container happy paths executed the expected sequence (network
  check → database wait → pull → migrate → up → health wait → build info).
- `corepack pnpm run check` — exit 0: evidence 17/17, config 29/29, vitest 35
  files passed / 13 skipped (integration files without a database).
- `corepack pnpm run test:integration` against PostgreSQL 18.6.3 with the three
  provisioned roles — 13 files, **150/150 passed**.
- `bash -n` on both shell scripts, `node --check` on the smoke script, YAML parse
  of every workflow and Compose file.

## Executed in CI

- `39030344531` (first rehearsal) **failed at “Apply migrations with the same
  image”**: the artifact's migration defaults `DATABASE_SSL_MODE` to
  `verify-full`, and a container PostgreSQL has no TLS. Fixed in `cc9d9eb` by
  writing the mode into `migration.env` and refusing to run without it.
- `39030452719` (`Staging`, commit `cc9d9eb`) — **success**. Steps: start the
  database, provision roles, build the image from the commit, apply migrations
  with that image, start the stack behind Caddy, export the internal CA, wait
  for HTTPS, run the staging smoke test with `STAGING_CA_FILE`, tear down.
  "Publish the runtime image" and "Deploy to staging" were skipped, by design,
  because the run was a pull request.
- `39030452725` (`Financial foundation CI`, commit `cc9d9eb`) — `verify` and
  `image` **success**, so the config change and the new files pass the existing
  gates.

The CI smoke step succeeded, which means every check in the script returned
pass (the script exits non-zero on the first failure and its JSON report is
printed only at the end). Its stdout is not retrievable here: GitHub's Actions
log endpoints are blocked from this sandbox.

## Not executed

| Item | Why |
| --- | --- |
| Deployment to a real host | No VM, SSH key, DNS record or GitHub Environment exists |
| GHCR publish and host pull | `workflow_dispatch` was not run; it also requires the workflow on the default branch |
| Let's Encrypt issuance | Needs the real hostname |
| `managed` database mode | No managed PostgreSQL instance; the code path is documented, not exercised |
| Rollback | Needs a host with two published tags |
| Email, backup | Out of scope for this change |

## Remaining conditions for staging to be reachable over HTTPS

1. A VM with Docker Engine ≥ 24, Compose ≥ 2.17, ports 22/80/443 open, and a
   non-root deploy user in the `docker` group.
2. A DNS `A`/`AAAA` record for `STAGING_SITE_ADDRESS` pointing at that VM.
3. A GitHub Environment `staging` with the SSH, hostname, secret and database
   values listed in [`deploy/staging/README.md`](../../deploy/staging/README.md).
4. One dispatch with `provision_roles = true` to create `kfin_app`,
   `kfin_migrator` and `kfin_operator`, then normal dispatches afterwards.
5. The workflow file on the default branch, which is required for
   `workflow_dispatch`.

Nothing above can be performed from this repository alone, and no placeholder
credentials, accounts or certificates were created.
