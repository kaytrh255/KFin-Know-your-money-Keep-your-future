# Production runtime and serving topology

Status: **implemented and smoke-tested locally on 2026-10-17** (plain HTTP and
behind a local TLS-terminating proxy), not yet deployed to any environment. This document describes the artifact; it is not evidence that a
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

## HTTPS and response headers

TLS ends at the proxy in front of the container; the app emits the headers that
only the origin can express:

| Header | Value | Applies to |
|---|---|---|
| `Strict-Transport-Security` | `max-age=<HSTS_MAX_AGE_SECONDS>; includeSubDomains` | production only |
| `Content-Security-Policy` | document: `default-src 'self'`, no inline, `frame-ancestors 'none'`; JSON: `default-src 'none'` | all responses |
| `X-Content-Type-Options` | `nosniff` | all responses |
| `Referrer-Policy` | `no-referrer` | all responses |
| `X-Frame-Options` | `DENY` | all responses |
| `Cross-Origin-Opener-Policy` | `same-origin` | all responses |
| `Cross-Origin-Resource-Policy` | `same-origin` | all responses |
| `Permissions-Policy` | camera/microphone/geolocation/payment/usb disabled | all responses |

They are applied in one `onSend` hook (`apps/api/src/security-headers.ts`), so
errors, 404s and the static client get them too; a route that sets a header
deliberately keeps its value. The client has no inline script or style, which is
what lets the CSP stay strict.

`TRUST_PROXY` decides whether `X-Forwarded-For` is believed. Empty (the default)
trusts nobody, so a directly reachable API cannot have its audit-trail address
forged. Set it to the proxy address or CIDR only:

```bash
TRUST_PROXY=10.0.0.0/8      # or the exact proxy IP
HSTS_MAX_AGE_SECONDS=31536000
```

The proxy must preserve `Host` (nginx: `proxy_set_header Host $host;`). The
same-origin CSRF check compares `Origin` with the received `Host`, so a proxy
that rewrites the host into an internal address will refuse every browser write.

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

## HTTPS proxy smoke test

```bash
DATABASE_URL=... AUTH_SECRET=... FINANCIAL_PREVIEW_SIGNING_KEY=... \
IDEMPOTENCY_RETENTION_HOURS=24 OPERATOR_DATABASE_URL=... \
  corepack pnpm run smoke:https
```

It generates a throwaway self-signed certificate, starts the real artifact, puts
a TLS-terminating proxy in front of it (preserving `Host`, adding
`X-Forwarded-For`/`X-Forwarded-Proto`), and drives real HTTPS requests: the
document and its headers, the compiled module, a same-origin write that is
processed (401 for unknown credentials, not 403), a cross-origin write that is
refused (403), and — with `OPERATOR_DATABASE_URL` — an invitation → register →
login journey whose session cookie must be `__Host-` prefixed with
`HttpOnly; Secure; Path=/` and no `Domain`, followed by an authenticated read.
Cookie values are never printed; only names and attributes are.

## Measured

- 2026-10-17, local PostgreSQL 18.6: smoke **12/12**, production-only install
  (6 dependencies, `npm install --omit=dev`, `tsx` unresolvable) **12/12**;
  artifact commit `5802b8c`.
- 2026-10-17, local PostgreSQL 18.6, artifact `df1f03f`: production smoke
  **18/18** (headers added), HTTPS proxy smoke **16/16** including the
  `__Host-` cookie and an authenticated read through the TLS proxy.
- CI run `39025829097` (commit `cbc6a8f`): `verify` green including *Smoke test the
  production artifact*, *Run the artifact behind a TLS-terminating proxy* and
  *Verify a production-only install*; `image` green including the container
  header assertions. `verify` ran the
  production-only install; `image` built the image, applied the 11 migrations
  with `migrate.bundle.mjs` from the image, then started the container and
  confirmed `/health/ready`, the HTML entry point, `src/main.js` as
  `text/javascript`, `401` on `/api/v1/auth/me`, `404` on an unknown API route,
  and that `node_modules/tsx` does not exist in the image.

## Rollback

The artifact is addressed by commit (`BUILD-INFO.json`). Application rollback is
redeploying the previous artifact; database rollback is *not* a down migration
(see `MIGRATION-FAILURE.md`). Keep the previous artifact available before every
deploy.

## Known gaps (not implemented here)

- The proxy itself (TLS certificate handling, HTTP→HTTPS redirect, proxy config)
  is outside this repository; only the headers the app emits and the
  `TRUST_PROXY` contract are implemented and tested.
- No staging host, DNS, certificate or deploy workflow exists; the image is built
  and started only in CI and locally.
- No secret store is configured for `AUTH_SECRET`, `FINANCIAL_PREVIEW_SIGNING_KEY`
  or `RESEND_API_KEY`; the container expects them in its environment.
- No log shipping, metrics or alerts consume the JSON logs or the health probes.
