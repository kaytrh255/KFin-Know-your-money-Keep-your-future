# Production runtime and serving topology

Status: **implemented and smoke-tested locally on 2026-10-17**, not yet deployed to
any environment. This document describes the artifact; it is not evidence that a
staging environment exists.

## Why one process serves both the client and the API

`apps/api/src/session-transport.ts` accepts a state-changing browser request only
when it is same-origin (or carries `Sec-Fetch-Site: same-origin|none`), and
`AUTH_ALLOWED_ORIGINS` is refused at startup because no credentialed CORS layer
exists. A separate static host would therefore need a new CORS design, so the
production topology is one origin: the API process also serves the compiled
client. `tools/dev-server.mjs` remains a development-only proxy and is not part
of the artifact.

## Build

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run build
```

`pnpm run build` runs `tsc -b` and then `scripts/build-production.mjs`, which
writes everything a deploy needs under `apps/api/dist`:

| Path | Contents |
|---|---|
| `server.bundle.mjs` | the API with every `@kfin/*` workspace package inlined; imports only `apps/api` runtime dependencies |
| `migrate.bundle.mjs` | `db:migrate` from the same artifact, with `migrations/` beside it |
| `provision-invitation.bundle.mjs` | the operator invitation CLI |
| `migrations/` | the reviewed forward-only SQL |
| `web/` | `index.html`, `src/styles.css`, compiled `src/*.js` |
| `runtime-package.json` | the exact production dependency set (`npm install --omit=dev`) |
| `BUILD-INFO.json` | commit, build time, Node version |

The bundles deliberately contain no `tsx` and no TypeScript source; `scripts/build-production.mjs`
fails the build if either appears. Fastify, `pg`, `zod`, `@fastify/swagger`,
`fastify-type-provider-zod` and `@node-rs/argon2` stay external and must be
present in the production install (they are `apps/api` dependencies).

## Start

```bash
corepack pnpm run start          # -> node apps/api/dist/server.bundle.mjs
```

The process refuses to boot in `NODE_ENV=production` when:

- `AUTH_COOKIE_SECURE` is not `true`;
- `EMAIL_DELIVERY_ADAPTER` is not `resend` (or the provider key/sender is missing);
- `apps/api/dist/web/index.html` is absent (an incomplete artifact);
- a required secret (`AUTH_SECRET`, `FINANCIAL_PREVIEW_SIGNING_KEY`,
  `DATABASE_URL`, `IDEMPOTENCY_RETENTION_HOURS`) is missing or malformed.

Required environment for a deploy (no values in this repository):
`DATABASE_URL`, `DATABASE_SSL_MODE=verify-full`, `AUTH_SECRET`,
`FINANCIAL_PREVIEW_SIGNING_KEY`, `IDEMPOTENCY_RETENTION_HOURS`,
`EMAIL_DELIVERY_ADAPTER=resend`, `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`
(optionally `EMAIL_REPLY_TO`). The process binds `HOST`/`PORT`; the platform must
provide TLS, process supervision, a secret store and log shipping — none of those
are in this repository yet.

## Smoke test

```bash
DATABASE_URL=... AUTH_SECRET=... FINANCIAL_PREVIEW_SIGNING_KEY=... \
IDEMPOTENCY_RETENTION_HOURS=24 corepack pnpm run smoke:production
```

It starts the real bundle with `NODE_ENV=production` and checks, in order:
`/health/live`, a database-backed `/health/ready`, the HTML entry point and its
`nosniff` header, the compiled module and stylesheet with their content types, a
missing asset as `404 text/plain`, SPA fallback for `/money`, a JSON 404 for an
unknown API route, `401 + Cache-Control: no-store` on `/api/v1/auth/me`, and that
the process still refuses to boot with insecure cookies or without email.
It prints a JSON report and exits non-zero on the first failure.

## Production-only install

The artifact must run with no devDependency at all — no `tsx`, no TypeScript, no
repository `node_modules`:

```bash
DATABASE_URL=... AUTH_SECRET=... FINANCIAL_PREVIEW_SIGNING_KEY=... \
IDEMPOTENCY_RETENTION_HOURS=24 corepack pnpm run verify:production-install
```

It copies `apps/api/dist` into an empty directory, renames `runtime-package.json`
to `package.json`, runs a real `npm install --omit=dev`, asserts `tsx` cannot be
resolved, and then runs the 12 deployment checks against `server.bundle.mjs` in
that directory. The repository's own `node_modules` is not on the resolution
path.

## Container image

The deployable unit is a two-stage image built from the repository root
(`Dockerfile`):

- **build**: pinned `node:22.22.3-bookworm-slim`, `pnpm install --frozen-lockfile`,
  `pnpm run build` with the commit passed as `BUILD_COMMIT`;
- **runtime**: the same base image, `npm install --omit=dev` against
  `runtime-package.json`, then the artifact copied in; runs as the `node` user,
  `ENV NODE_ENV=production`, `HEALTHCHECK` on `/health/ready`, `CMD node server.bundle.mjs`.

```bash
corepack pnpm run image:build
docker run --env-file /run/kfin.env -p 3000:3000 kfin-runtime:local
```

The image also carries `migrate.bundle.mjs`, so a deploy applies reviewed SQL
with the same artifact:

```bash
docker run --rm --network host -e MIGRATION_DATABASE_URL=... \
  kfin-runtime:ci node migrate.bundle.mjs
```

**Hosting decision (minimal):** one container behind a TLS-terminating proxy,
with a managed PostgreSQL (Supabase) reached over `verify-full`. This keeps the
single-origin design intact, needs no CDN or CORS work, and is portable across
hosts; the proxy owns the hostname, certificates, HSTS and request logging.

`verify:production-install` and the image build are exercised in CI
(`verify` job and the separate `image` job). Docker is not available in the
development sandbox used on 2026-10-17, so the image itself is only proven by CI.

## Measured

- 2026-10-17, local PostgreSQL 18.6: smoke **12/12**, production-only install
  (6 dependencies, `npm install --omit=dev`) **12/12**; artifact commit `5802b8c`.
- The CI `verify` and `image` jobs repeat both against `postgres:17.6`.

## Rollback

The artifact is addressed by commit (`BUILD-INFO.json`). Application rollback is
redeploying the previous artifact; database rollback is *not* a down migration
(see `MIGRATION-FAILURE.md`). Keep the previous artifact available before every
deploy.

## Known gaps (not implemented here)

- TLS termination, HSTS and the other response headers belong to the ingress;
  nothing in the repository configures them.
- No staging host, DNS, certificate or deploy workflow exists; the image is built
  and started only in CI and locally.
- No secret store is configured for `AUTH_SECRET`, `FINANCIAL_PREVIEW_SIGNING_KEY`
  or `RESEND_API_KEY`; the container expects them in its environment.
- No log shipping, metrics or alerts consume the JSON logs or the health probes.
