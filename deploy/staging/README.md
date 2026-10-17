# Staging deployment

Staging runs the production artifact — the same image, the same production
guards — behind Caddy on one small Linux VM. The database is a separate
PostgreSQL instance (a container on that VM by default). Nothing here creates
an account, a DNS record or a certificate: those are owner actions, listed
below.

```
browser ──HTTPS──> Caddy :443 ──HTTP──> kfin-runtime :3000 ──> PostgreSQL
                   (Host preserved)     (trusts 172.28.0.0/16)   (separate instance)
```

Why a VM and Compose rather than a PaaS: the runtime is a single same-origin
Node process with six dependencies and no Docker socket or shared state. A VM
gives a deterministic proxy CIDR for `TRUST_PROXY`, a proxy that preserves
`Host` (the CSRF check depends on it), and no vendor-specific TLS termination
to reason about. A PaaS would move both of those into someone else's control.

## What the repository already provides

| Piece | File |
| --- | --- |
| Compose stack (app + Caddy) | `deploy/staging/docker-compose.yml` |
| Staging database (container) | `deploy/staging/docker-compose.database.yml` |
| CI rehearsal overlay | `deploy/staging/docker-compose.rehearsal.yml` |
| Caddy config | `deploy/staging/Caddyfile` |
| Deploy script (runs on the host) | `scripts/ops/staging-deploy.sh` |
| Post-deploy smoke test | `scripts/smoke/staging-smoke.mjs` |
| Workflow | `.github/workflows/staging.yml` |

The workflow has two modes. Every pull request rehearses the full stack —
image built from that commit, real Caddy TLS, a disposable PostgreSQL, role
provisioning, migrations — and runs the staging smoke test over HTTPS. A
`workflow_dispatch` run publishes the image to GHCR and deploys it to the host.
The rehearsal is what makes the deploy path trustworthy before a host exists;
it is not a substitute for the real deployment.

## Owner steps

### 1. Create the host

Any provider; 2 vCPU / 2–4 GB RAM is enough. Ubuntu 22.04 or 24.04 with a
public IPv4 address.

- Install Docker Engine and the Compose plugin (Compose ≥ 2.17 for
  `up --wait`; Docker ≥ 24).
- Create a non-root user that can run Docker (`usermod -aG docker deploy`).
  The workflow connects as that user and does not use `sudo`.
- Point a DNS `A` record (and `AAAA` if you want IPv6) at the host, for example
  `staging.example.com`. Caddy obtains a Let's Encrypt certificate on the first
  HTTPS request, so the record must resolve before the deploy.
- Firewall: allow TCP 22, 80, 443. Port 3000 is published only inside the
  Compose network, and the database only on the host loopback — do not open
  either.

Do not run `host-bootstrap.sh` as root unless the deploy user owns
`/opt/kfin-staging`; the script only creates directories and checks tools.

### 2. Register the GitHub secrets

Create an Environment named `staging` (repository **Settings → Environments**,
optionally with required reviewers) and add these **secrets**:

| Secret | Value |
| --- | --- |
| `STAGING_HOST` | hostname or IP the deploy connects to |
| `STAGING_USER` | the deploy user |
| `STAGING_SSH_KEY` | private key (ed25519) for that user, PEM format |
| `STAGING_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <host>` |
| `STAGING_SITE_ADDRESS` | bare hostname, e.g. `staging.example.com` (no scheme) |
| `STAGING_TLS_ARGS` | ACME email for Let's Encrypt, e.g. `ops@example.com` |
| `STAGING_AUTH_SECRET` | `openssl rand -hex 32` |
| `STAGING_FINANCIAL_PREVIEW_SIGNING_KEY` | `openssl rand -hex 32` |
| `STAGING_DB_ADMIN_PASSWORD` | `openssl rand -hex 24` (container database, superuser) |
| `KFIN_APP_PASSWORD` | `openssl rand -hex 24` |
| `KFIN_MIGRATOR_PASSWORD` | `openssl rand -hex 24` |
| `KFIN_OPERATOR_PASSWORD` | `openssl rand -hex 24` (required for the register/sign-in check) |

Optional secrets: `STAGING_EMAIL_ADAPTER` (`none` by default), `RESEND_API_KEY`,
`STAGING_EMAIL_FROM_ADDRESS` (only when a provider exists), and
`STAGING_SMOKE_EMAIL`/`STAGING_SMOKE_PASSWORD` to additionally sign in an
existing account.

With `managed` mode add `STAGING_OPERATOR_DATABASE_URL` (the `kfin_operator`
connection) instead of `KFIN_OPERATOR_PASSWORD`; the workflow then uses it for
the invitation step.

Optional repository **variable** `STAGING_DB_MODE` — `container` (default) or
`managed`. For `managed`, instead of the three database passwords provide
`STAGING_DATABASE_URL`, `STAGING_MIGRATION_DATABASE_URL`,
`STAGING_DATABASE_SSL_MODE` (default `verify-full`), `STAGING_OPERATOR_DATABASE_URL`,
and for the one-time provisioning run, `STAGING_DATABASE_ADMIN_URL`.

Notes:

- Secrets are never printed. The workflow streams the environment files over
  SSH and checks only that each required name is present.
- The migration role's URL lives in a separate `migration.env`; the API
  container never sees it.
- Use hex passwords: they are interpolated into connection URLs.
- For a managed database, a URL that contains `sslmode=require` downgrades
  verification even if `DATABASE_SSL_MODE=verify-full` is set. Omit the
  parameter or use `sslmode=verify-full`, and make the provider CA available to
  Node (`NODE_EXTRA_CA_CERTS`) when it is not publicly trusted.

### 3. First deployment

1. Run **Actions → Staging → Run workflow** on `main` with
   `provision_roles = true`. That step creates `kfin_app`, `kfin_migrator` and
   `kfin_operator` against the staging database over an SSH tunnel (or
   `STAGING_DATABASE_ADMIN_URL` for a managed database), then migrates and
   deploys.
2. Later runs use `provision_roles = false`. Provisioning is idempotent, but it
   needs the admin credential, so it is not part of a routine deploy.
3. The workflow publishes `ghcr.io/<owner>/<repo>/kfin-runtime:sha-<commit>` and
   the moving `:staging` tag, logs the host into GHCR, applies migrations as
   `kfin_migrator` from the same image, restarts the stack, waits for the
   health check, mints one invitation as `kfin_operator`, and runs the staging
   smoke test over the public HTTPS URL. That smoke test redeems the invitation
   with a fresh address, signs the new user in and reads the session, so a
   successful run is a real registration and sign-in on staging. Set
   `verify_register_login = false` only to skip it (the operator credential is
   then not required).

Dispatch requires the workflow on the default branch. Until this change is
merged, merge it (or cherry-pick only the workflow) before the first dispatch;
the pull-request rehearsal is the CI evidence in the meantime.

### 4. Roll back

The previous image tags remain on the host. To go back:

```bash
cd /opt/kfin-staging
KFIN_IMAGE=ghcr.io/<owner>/<repo>/kfin-runtime:sha-<previous> \
STAGING_SITE_ADDRESS=staging.example.com \
STAGING_TLS_ARGS=ops@example.com \
  bash staging-deploy.sh
```

Migrations are forward-only: rolling back the image does not undo a migration.
Check `packages/database/migrations` for a reversible change before rolling
back across one.

## What a successful run proves

`scripts/smoke/staging-smoke.mjs` with an invitation prints
`auth.registration`, `auth.registration-login`, `auth.registration-session-cookie`
and `auth.registration-read` as passing checks. Together they mean: the public
HTTPS URL served the invite-only registration form, the invitation was accepted,
the new account signed in, the `__Host-` session cookie carries
`HttpOnly; Secure; Path=/`, and an authenticated read returned that account.
The code is minted on the host and masked in the log; the generated address is
`staging.smoke.<timestamp>@example.invalid` and is safe to delete.

## What is deliberately not here

- **Email.** `EMAIL_DELIVERY_ADAPTER=none` with `STAGING_MODE=true` is the
  explicit exception added for this environment: the production config refuses
  `none`, and staging logs a warning at boot. Password reset cannot complete.
  Remove both lines when a provider exists.
- **Backups.** Out of scope for this change; a staged database holds no
  production data.
- **Production access.** This stack never points at production Supabase.

## Local checks

```bash
node --check scripts/smoke/staging-smoke.mjs
bash -n scripts/ops/staging-deploy.sh
corepack pnpm run check
```

The Compose files and the Caddyfile are validated for real by the CI rehearsal,
which starts Caddy, applies migrations and drives the smoke test over TLS.
