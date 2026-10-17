# Staging deployment

Status: the deployment path is implemented and rehearsed in CI. It has **not**
been deployed to a real host: no VM, DNS record, certificate or GitHub
Environment exists in this repository's ownership. Step-by-step owner actions
are in [`deploy/staging/README.md`](../../deploy/staging/README.md).

## Shape

```
browser ──HTTPS──> Caddy :80/:443 ──HTTP──> kfin-runtime :3000 ──> staging PostgreSQL
                   Host preserved          trusts 172.28.0.0/16    (container or managed)
```

- **Host.** One small Linux VM (2 vCPU, 2–4 GB) with Docker Engine ≥ 24 and the
  Compose plugin ≥ 2.17. The runtime is a single same-origin Node process with
  six production dependencies, no Docker socket and no shared state, so there is
  nothing to orchestrate beyond one Compose project.
- **Edge.** Caddy terminates TLS, preserves `Host`, and sets
  `X-Forwarded-Proto`/`X-Forwarded-Host`. The app trusts exactly the Compose
  network's fixed CIDR (`TRUST_PROXY`), never `*`, so a client cannot forge the
  address recorded in the security audit trail. A PaaS was rejected because it
  puts proxy trust and `Host` handling behind provider-specific behaviour while
  the application's CSRF defense depends on both.
- **Database.** A separate PostgreSQL instance, by default a container on the
  same VM (`docker-compose.database.yml`). It publishes port 5432 on the host
  loopback only, which is enough for the one-time role provisioning over an SSH
  tunnel and not enough for the internet. A managed PostgreSQL is supported by
  setting the `managed` mode and a `DATABASE_URL`; it is not the default
  because it adds a second provider, a CA to distribute and a network path that
  CI cannot rehearse.
- **Image.** Published by CI to `ghcr.io/<owner>/<repo>/kfin-runtime`, tagged
  `sha-<commit>` (deployed) and `staging` (moving). The host logs in with the
  workflow token, pulls, and logs out.

## Deploy sequence

1. **Rehearsal (every pull request).** Build the image from the commit, start
   the stack with `docker-compose.rehearsal.yml` (internal CA, ephemeral
   secrets), provision roles, migrate as `kfin_migrator`, wait for HTTPS, mint
   an invitation as `kfin_operator`, then run `scripts/smoke/staging-smoke.mjs`
   with `STAGING_CA_FILE` and the invitation code — so the rehearsal registers a
   user and signs it in over real TLS — and tear down.
2. **Publish (`workflow_dispatch`).** Build and push the image for the
   dispatched commit.
3. **Deploy.**
   - Check that every required secret is present (names only — values are never
     printed).
   - Stream `staging.env`, `db.env` and `migration.env` to
     `/opt/kfin-staging/` with mode 0600. The API container reads only
     `staging.env`; the database and migration credentials stay out of it.
   - Optionally provision `kfin_app`, `kfin_migrator`, `kfin_operator` from the
     runner, over an SSH tunnel to the loopback database port.
   - Run `staging-deploy.sh`: pull, create the fixed-name edge network (and
     verify its subnet matches `TRUST_PROXY`), start the database and wait for
     its health check, migrate with the new image, `up -d`, wait for the API
     health check.
   - Run the staging smoke test against the public HTTPS URL, then log the host
     out of the registry.

Migrations run before the application is replaced, as `kfin_migrator`, from the
same image. A failed migration leaves the previous deployment serving.

## What the smoke test proves

`scripts/smoke/staging-smoke.mjs` runs against the deployed URL, not the local
process, so it covers DNS, the certificate chain, Caddy, `Host` preservation,
proxy trust and the app together:

- `/health/live` and `/health/ready` (database reachable);
- the client document and its compiled module, with the hardening headers, CSP
  and HSTS;
- an unauthenticated protected route (401) and an unknown API route (JSON 404);
- a same-origin login attempt that is processed (not 403) and a cross-origin
  attempt that is refused;
- with an invitation (`STAGING_INVITATION_CODE`): registration with a fresh
  address, sign-in, the `__Host-` session cookie flags and an authenticated read
  — the invite-only journey end to end;
- optionally, a real login with `STAGING_SMOKE_EMAIL/PASSWORD` for an existing
  account (cookie values are never printed);
- an HTTP→HTTPS redirect when `STAGING_HTTP_URL` is set.

## Staging-specific configuration

`STAGING_MODE=true` is an opt-in that only relaxes one production guard:
`EMAIL_DELIVERY_ADAPTER=none` is otherwise refused when `NODE_ENV=production`.
Everything else still refuses to boot — insecure cookies, missing secrets,
`AUTH_ALLOWED_ORIGINS`, static-artifact checks — and the server logs a warning
at boot. Password reset cannot complete while `none` is selected. No mail
provider is configured and no backup is part of this environment.

## Verification split

| Verified here (this repository) | Not verified here |
| --- | --- |
| Config unit tests for `STAGING_MODE` | A real VM, DNS record or certificate |
| `bash -n` on the deploy script | A real image pull from GHCR |
| YAML parse of the workflow | GitHub Environment secrets |
| CI rehearsal of the Compose stack (runs on GitHub's Docker) | Reaching a public HTTPS URL |
| Staging smoke test against a real TLS proxy, including registration + sign-in | Let's Encrypt issuance |
| `pnpm run check` | Rollback against a real host |

The CI rehearsal is the strongest evidence available without a host: it starts
the same Caddy image with the same Caddyfile, applies the same migrations
through the same `docker run --env-file migration.env` invocation, and drives
the same smoke test over verified TLS.

## Rollback

Forward-only migrations and immutable `sha-<commit>` tags. Redeploy the previous
tag with `staging-deploy.sh` (see `deploy/staging/README.md`). A migration is
not undone by a rollback; check `packages/database/migrations` first.
