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

### Least-privilege database roles (SPEC-SEC-01)

The API connects as `kfin_app`; migrations connect as `kfin_migrator`; the
invitation CLI connects as `kfin_operator`. No role owns the schema, and
`kfin_app` has only the DML allowlist used by `packages/database/src`.
`kfin_operator` has INSERT on `beta_invitations` and nothing else. Provision the
roles once per database with an owner/admin connection, then run migrations as
the migration role:

```bash
ROLE_ADMIN_DATABASE_URL='...' \
KFIN_APP_PASSWORD='...' KFIN_MIGRATOR_PASSWORD='...' KFIN_OPERATOR_PASSWORD='...' \
corepack pnpm run db:provision-roles

MIGRATION_DATABASE_URL='...' DATABASE_SSL_MODE=disable \
corepack pnpm run db:migrate

DATABASE_URL='...' corepack pnpm run db:verify-app-role
```

`ROLE_ADMIN_DATABASE_URL` and the three passwords are operator-only. Provisioning also
removes every role membership from the three roles: `NOINHERIT` does not prevent
`SET ROLE`, so a membership would let the application switch to a privileged role. Keep them out
of the API environment, `.env`, Git, and logs; the provisioning script never
prints a password. Migration 0008 refuses to run unless `kfin_app` exists with
the safe attributes and schema grants, and it grants only the reviewed DML
allowlist. If an existing schema is owned by the platform role (for example an
already-migrated Supabase project), run `db:migrate` as that owner; do not
transfer ownership in this phase. The application role must remain a non-owner.

`db:verify-app-role` is a smoke check over `public`. The full table-by-table
allowlist, the RLS/policy/function shape, and both deployment paths (migration
role or existing owner) are pinned by
`packages/database/test/least-privilege.integration.test.ts` and
`packages/database/test/rls-owner-isolation.integration.test.ts`.

Migrations 0009–0011 implement SPEC-SEC-01 phase 2: owner-scoped Row Level
Security plus five narrow `SECURITY DEFINER` lookup functions for the
pre-identity authentication reads. Every repository call runs in a transaction
that sets the transaction-local `kfin.user_id` setting; a missing or malformed
setting matches no row. Deploy order matters: ship the context plumbing first,
then apply 0009 (policies only), 0010 (financial tables enabled) and 0011
(authentication tables enabled).

The operator CLI uses its own connection string and refuses to run as anything
but `kfin_operator`:

```bash
OPERATOR_DATABASE_URL='...' AUTH_SECRET='...' \
corepack pnpm run invite:provision
```

Read `docs/security/ROW-LEVEL-SECURITY.md` before changing policies or
functions: the setting is a guardrail against application bugs, not a defence
against arbitrary SQL executed under the application role.

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

### Sign-in inside the preview frame (2026-10-13)

The preview renders the client inside a **cross-site iframe** on the platform page.
A browser stores and sends a `SameSite=Lax`/`Strict` cookie only when the page is
same-site with the top-level document, so the session cookie (`SameSite=Lax`) and the
CSRF cookie (`SameSite=Strict`) are **not kept inside that frame**: sign-in answers
200 because the API did mint the session, then `GET /api/v1/auth/me` answers 401 and
no screen may claim a signed-in state.

Reproduced locally on 2026-10-13 with a browser-equivalent client and a separate test
account, driving the real dev server and API: first-party origin → login 200,
`/auth/me` 200; cross-site iframe → login 200, `/auth/me` 401. The API and the proxy
are correct — the proxy passes `Set-Cookie` out and the returned `Cookie` back
unchanged, which `apps/web/test/dev-server.test.ts` now pins.

Two consequences, both deliberate:

- **Sign in from a top-level tab**, not from inside the frame (`window.top !==
  window.self` is `true` inside the frame). The cookie transport stays
  `HttpOnly; Secure; SameSite=Lax` for the session and `SameSite=Strict` for CSRF;
  relaxing it for the frame was considered and **rejected** (owner decision,
  2026-10-13), because SameSite remains defense-in-depth alongside the API's
  `Origin`/`Sec-Fetch-Site` check.
- **The client reports the failure honestly.** The sign-in screen shows "Signed in."
  only after `/api/v1/auth/me` confirms a session; otherwise it says the API accepted
  the sign-in but this browser did not keep the session cookie, and points at its own
  tab. `apps/web/test/session-routing.test.ts` covers both outcomes.

### Diagnosing a rejected write

A `4xx` that says the request "does not match the API contract" now names the
field and the rule next to the message, and prints the correlation ID:

```json
{ "error": {
  "code": "REQUEST_VALIDATION_FAILED",
  "message": "The request does not match the API contract.",
  "correlationId": "5bcdd7b2-f5ba-413b-b09c-2c322b2c5ef6",
  "fields": [
    { "path": "invitationCode", "rule": "the value does not satisfy a rule this contract states for the field" }
  ]
} }
```

The `fields` list is deliberately value-free: it names the field and states the
rule, and never repeats a submitted password, invitation code, or one-time code.
The same summary is written to the API log against that correlation ID, so the ID
the client shows can be looked up:

```bash
grep <correlationId> <the api:dev process output>
```

If a write is refused for a different reason, the code tells you the layer: `403
AUTH_CSRF_FAILED` is the origin/CSRF defense, `400 REQUEST_BODY_UNREADABLE` is a
body the JSON parser refused, `400 AUTH_INVITATION_INVALID` is an unknown, used,
expired, or wrong-email invitation, `400 AUTH_PASSWORD_POLICY_FAILED` is the
service password policy (at least 12 characters, at most 128, and not too common
or too similar to the email address), and `409` codes are business rules such as a
stale snapshot version.

## 4. Completing the password-reset email flow locally

**Registration sends no email.** An invited account is created usable and explicitly unverified, and
signing in needs nothing but the password you chose — there is no verification screen and no
verification route, because the specification no longer verifies email at registration (OQ-20,
2026-10-12). The only message the product sends is the password-reset OTP.

The OTP is never returned in an API response, and the default adapter (`none`) reports delivery
failure, so a browser reset cannot be completed on the default settings — by design, because the
design never persists a one-time secret.

For local development only, `EMAIL_DELIVERY_ADAPTER=file` writes each message to
`EMAIL_OUTBOX_DIR` as a `0600` JSON file, and the dev server exposes the newest
messages at `/__dev__/outbox` for the "Local email outbox" panel. This is:

- refused when `NODE_ENV=production` (the API will not start);
- a route on the **dev server**, not the API — the API still has no route that
  reveals a one-time code;
- local state that must be treated as sensitive: delete the directory when done.

To walk the flow: start `api:dev` and `web:dev` with the same `EMAIL_OUTBOX_DIR`, provision an
invitation (§5), register, sign in, press "Forgot password" → "Email me a reset code", then press
"Use code" in the panel — it fills the six-digit field on the reset screen. The code is single-use,
lives ten minutes, allows five attempts, is superseded by the next request, and the reset revokes
every session of the account, so sign in again with the new password afterwards.

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

Sign in, register (invitation), verify email *(pre-revision flow; see the §4 note)*,
forgot/reset password, change password, session list/revocation, opening the financial account, posting a
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
