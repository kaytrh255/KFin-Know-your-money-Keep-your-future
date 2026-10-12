# Local development run

**Status:** Working instructions for running the implemented stack on one machine
**Scope:** M01–M10 backend plus the local testing client in `apps/web`
**Not covered:** deployment, Supabase project provisioning, provider selection (still Phase 6, OQ-17)

This is the shortest path from a fresh clone to a browser screen that talks to the
real API, real PostgreSQL, and the real migrations. Nothing here seeds demo data:
every value a screen shows comes from a response to a request this run made.

## 1. What exists today

| Piece | Path | State |
|---|---|---|
| API | `apps/api` | implemented (M01–M10); Fastify, cookie sessions, same-origin only |
| Database schema | `packages/database` | migrations 0001–0006 |
| Client | `apps/web` | **local testing client**, not a product surface — one form per implemented flow, no framework, no build tool beyond `tsc -b` |
| Dev server | `tools/dev-server.mjs` | static files + same-origin proxy + local email sink reader |

There is no CORS layer and `AUTH_ALLOWED_ORIGINS` must stay empty
(`packages/config/src/index.ts` rejects any value). The browser therefore has to
see one origin, which is why the dev server proxies `/api/*`, `/health/*`, and
`/openapi.json` to the API instead of the client calling `http://localhost:3000`
directly.

## 2. Environment

Copy `.env.example` to `.env` (never commit it; `.env*` is ignored except the
example) and fill in the names below. Only names appear here — no values, no
connection strings, no secrets:

| Variable | Local value to use |
|---|---|
| `NODE_ENV` | `development` |
| `HOST` / `PORT` | API bind address and port (the dev server proxies to `http://127.0.0.1:$PORT`) |
| `DATABASE_URL` | local PostgreSQL, app role |
| `MIGRATION_DATABASE_URL` | local PostgreSQL, migration role (`db:migrate` only) |
| `DATABASE_SSL_MODE` | `disable` for a local server; `verify-full` when the connection string points at managed PostgreSQL (Supabase) |
| `DATABASE_POOL_MAX` | small, for example `5` |
| `IDEMPOTENCY_RETENTION_HOURS` | an approved retention value; the API refuses to start without it |
| `FINANCIAL_PREVIEW_SIGNING_KEY` | 32 random bytes as 64 hex characters |
| `AUTH_SECRET` | 32 random bytes as 64 hex characters, never reused for anything else |
| `AUTH_ALLOWED_ORIGINS` | **empty** — a non-empty value is refused at startup |
| `AUTH_COOKIE_SECURE` | `true`; `false` is accepted only outside production and only for plain-HTTP local development |
| `EMAIL_DELIVERY_ADAPTER` | `file` to make local email flows completable (see §4) |
| `EMAIL_OUTBOX_DIR` | a directory on this machine, used only when the adapter is `file` |
| `KFIN_WEB_PORT` | dev server port, default `5173` |
| `KFIN_API_ORIGIN` | where the dev server proxies; default `http://127.0.0.1:$PORT` |

Generate the two 32-byte secrets locally, for example with
`openssl rand -hex 32`, and keep them out of shell history, logs, and Git.

### Using Supabase PostgreSQL

Supabase is compatible with the current configuration because the pool builds its
own TLS options from `DATABASE_SSL_MODE` (`packages/database/src/pool.ts`:
`disable` → no TLS, otherwise `{ rejectUnauthorized: true }`) and refuses
self-signed certificates. Supabase's managed certificates are publicly trusted, so
point `DATABASE_URL` at the pooled connection string and set
`DATABASE_SSL_MODE=verify-full`. Two cautions:

- run migrations only against a database you are allowed to migrate — **never**
  against production, and never with migration credentials stored in this repo;
- a Supabase project is a shared resource: the integration suite
  (`test:integration`) creates and drops its own schemas and must only ever be run
  against a disposable, explicitly designated non-production database.

## 3. Run it

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run db:migrate      # needs MIGRATION_DATABASE_URL; local/disposable DB only
corepack pnpm run api:dev         # terminal 1
corepack pnpm run web:dev         # terminal 2 (builds apps/web, then serves it)
```

Open the dev server origin (`http://localhost:5173` by default). `web:dev` runs
`tsc -b apps/web` first and serves `apps/web/dist`; restart it after editing client
sources, or run `corepack pnpm run web:build` yourself and start the dev server
with `KFIN_WEB_SKIP_BUILD=1`.

## 3.1 Opening the client from an Arena preview (no terminal in the session)

When this workspace runs inside an Arena sandbox, a process that listens on
`0.0.0.0` is reachable from the user's browser through the platform preview proxy:

```
https://<port>-<sandboxId>.e2b.app
```

The sandbox id is in `E2B_SANDBOX_ID` (for example
`https://5173-<sandboxId>.e2b.app` for the default `KFIN_WEB_PORT=5173`). Two
consequences are built into the dev server rather than left to chance:

- **Binding.** The dev server binds `0.0.0.0` by default so the proxy can reach it;
  the API deliberately stays on loopback (`HOST=127.0.0.1`) and is reached only
  through the proxy, so the API port is not separately exposed.
- **Host/Origin agreement.** The API's same-origin defense compares the request's
  `Origin` with the `Host` it receives, and a preview proxy may rewrite `Host`
  (it commonly replaces it with the loopback address and reports the original one
  in `X-Forwarded-Host`). The dev server therefore resolves the browser-facing host
  from, in order, `X-Forwarded-Host`, then `Origin` when the browser also attests
  `Sec-Fetch-Site: same-origin|none`, then `Host`, and hands the API a consistent
  `Host`/`Origin` pair. It also refuses a cross-site or header-less state-changing
  request itself (`403 LOCAL_PROXY_ORIGIN_REJECTED`) instead of forwarding it.

`GET /__dev__/request-context` reports exactly what the dev server received
(`host`, `origin`, `x-forwarded-host`, `sec-fetch-site`, the host it forwards, and
whether a write would be forwarded) and never echoes a cookie or token. The client
surfaces it on the **Self-check** screen (`#/self-check`), together with an API
reachability call and one real state-changing request against a deliberately
unregistered probe address, so a broken preview can be diagnosed from the browser
without a shell.

## 4. Completing the email flows locally

Registration issues a six-digit code and password recovery issues a reset secret.
Neither is returned in an API response, and the default adapter (`none`) reports
delivery failure, so a browser flow cannot be completed on the default settings —
by design, because the design never persists a one-time secret.

For local development only, `EMAIL_DELIVERY_ADAPTER=file` writes each message to
`EMAIL_OUTBOX_DIR` as a `0600` JSON file, and the dev server exposes the newest
messages at `/__dev__/outbox` for the "Local email outbox" panel. This is:

- refused when `NODE_ENV=production` (the API will not start);
- a route on the **dev server**, not the API — the API still has no route that
  reveals a one-time code;
- local state that must be treated as sensitive: delete the directory when done.

Start `api:dev` and `web:dev` with the same `EMAIL_OUTBOX_DIR`, then register and
press "Use code" in the panel.

## 5. First sign-up needs an invitation

There is deliberately no HTTP route that mints invitations
(`packages/database/src/auth-repository.ts`), so the first account needs the
operator procedure in its local form:

```bash
corepack pnpm run invite:provision
corepack pnpm run invite:provision -- --email beta.user@example.invalid
```

The script calls the same repository method the operator flow uses, prints the
single-use code once, and stores only its digest. The API's environment supplies
the database URL and `AUTH_SECRET`; the script never echoes them.

## 7. Transaction category codes

Categories are rows in the seeded `categories` table (`transaction_kind` + `code`),
and **no endpoint lists them yet** — a real gap, recorded here rather than worked
around in the client. The active seeded codes after migration 0001 are:

| Kind | Codes |
|---|---|
| `expense` | `electricity`, `emergency`, `entertainment`, `expense_other`, `food`, `internet`, `rent`, `repair`, `required_subscriptions`, `shopping`, `transportation`, `unexpected_bills`, `water` |
| `income` | `income_other` |

A write with a code that does not exist for that direction is refused with
`FINANCIAL_VALIDATION_FAILED` (`packages/database/src/schedule-repository.ts`).

## 6. What is testable from the client today

Sign in, register (invitation), verify email, forgot/reset password, change
password, session list/revocation, opening the financial account, posting a
snapshot under optimistic concurrency, reading the authoritative balance, monthly
actuals, transaction list/detail/create/void preview/void/history, savings goals
(create, list, update amount, archive, amount history), and one-off schedule
occurrences (create, confirm, skip).

Known gaps, stated rather than hidden:

- the correction **commit** (`POST /api/v1/transactions/:id/corrections`) needs a
  reviewed correction chain the client has no way to obtain yet; the screen shows
  the preview/history endpoints only;
- recurring cadences, debts, purchases, notifications, and the PWA shell are not
  implemented in the API, so no screen pretends to offer them;
- the design system and screen inventory remain Draft proposals: the client uses
  the proposed tokens and route names, but no visual or accessibility acceptance
  exists.
