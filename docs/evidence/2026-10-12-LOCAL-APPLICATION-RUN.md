# Local application run — first browser-runnable client, end-to-end against the real API (2026-10-12)

**Branch:** `arena/bfaf5019-kfin-know-your-money-keep-your` (PR #10)<br>
**Recorded:** 2026-10-12 (Asia/Saigon)<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2` (unchanged)<br>
**Production readiness:** Not claimed. No deployment was performed; everything below is one local machine.

## 1. The gap that was reported, confirmed

Before this change the repository contained **no client of any kind**: `apps/` held only
`apps/api`, and a repository-wide search for `*.tsx`, `*.jsx`, `*.html`, `*.css`, `*.vue`, and
`*.svelte` returned zero files. There was no browser surface, no local run documentation, and no
way to complete registration from a browser because one-time codes existed only inside a request
process (`EMAIL_DELIVERY_ADAPTER=memory`) or nowhere at all (`none`, the default).

Verified by enumeration, not assumption: `git ls-files | grep -E '\.(tsx|jsx|html|css|vue|svelte)$'`
→ 0 results before this change set; `apps/` → `api` only.

## 2. What now exists

| Added | Purpose |
|---|---|
| `apps/web` | Local testing client: static TypeScript, no framework, one screen per implemented flow |
| `tools/dev-server.mjs` | Same-origin dev server: serves the compiled client, proxies `/api/*`, `/health/*`, `/openapi.json`, and reads the local email sink |
| `apps/api/tools/provision-invitation.ts` + `pnpm run invite:provision` | The operator channel in local form, using the same repository method production would |
| `EMAIL_DELIVERY_ADAPTER=file` + `EMAIL_OUTBOX_DIR` | Local development email sink for one-time codes; refused when `NODE_ENV=production` |
| `docs/development/LOCAL-DEVELOPMENT.md` | The runbook: env names, migrations, Supabase compatibility, invitation flow, seeded category codes |

The client is honest about its status: the shell carries a banner saying it is a local testing
client, every screen shows the request and response payload it used, and no screen, fixture, or
seed invents data for a capability the API does not have. `/__dev__/outbox` is a **dev-server**
route, not an API route: the API still exposes nothing that reveals a one-time code.

## 3. Measured results (this run, PostgreSQL 17.6, migrations 0001–0006, `NODE_ENV=development`)

Every row below is a real HTTP exchange through the dev-server origin (`http://127.0.0.1:5173`),
proxied to the API on loopback. No value is simulated.

| Flow | Result |
|---|---|
| `GET /health/ready` | `200` |
| `POST /api/v1/auth/register` (invitation consumed) | `202` |
| one-time code read from the local sink | present, 6 digits, `email_verification_otp` |
| `POST /api/v1/auth/verify-email` | `200`, session + `kfin_csrf` cookie issued |
| `GET /api/v1/auth/me` | `200` |
| `POST /api/v1/financial-account` | `201`, `financialStateVersion=1` |
| `POST /api/v1/transactions` | `201` |
| same intent replayed with the same `idempotency-key` | `201`, **no second posting** |
| `GET /api/v1/financial-account` after the expense | `currentBalanceMinor=205000000`, `postedCurrentExpenseMinor=45000000` (exact) |
| void preview → void commit (reviewed context echoed back) | `200` → `200` |
| `GET /api/v1/reports/monthly-actuals` after the void | `expenseMinor=0`, group marked `amended=true` |
| `GET /api/v1/transactions` after the void | record still listed with `status=voided` |
| savings create → update amount → stale version | `201`, `200`, `409 SAVINGS_GOAL_VERSION_CONFLICT` |
| schedule one-off with a stale financial version | `409 FINANCIAL_STATE_STALE` |
| schedule one-off with the current version → confirm | `201`, `201`; balance `197000000` = opening − expense − confirmed outflow |
| cross-site write (`Origin: http://evil.invalid`) | `403 AUTH_CSRF_FAILED` |
| same-origin malformed JSON body | `400 REQUEST_BODY_UNREADABLE` — the Milestone 10 fix, observed on the wire |
| logout → `GET /auth/me` | `200 {revoked:true}` → `401 AUTHENTICATION_REQUIRED` |

Gate results on the same tree: `evidence:check` 25 modules / 29 harness files; `evidence:test`
16 pass / 0 fail / 0 skipped; `typecheck` exit 0; `test:unit` **674 passed / 29 files**
(baseline `33357ea`: 626 / 24; the client adds 35 tests across four files, the email sink 9,
and the extended config suite 4); `test:integration` **64 passed / 7 files** on PostgreSQL 17.6.

## 4. Defects the run itself found (all fixed, each with a regression test)

Running the application — rather than reasoning about it — exposed four real integration defects.
They are listed because a client that only "looks right" would have shipped all four:

1. **The dev server rewrote the `Host` header**, so the API's same-origin defense
   (`apps/api/src/session-transport.ts` compares `Origin` against `Host`) rejected **every**
   browser write with `403`. The proxy now forwards the browser's own `Host`; `apps/web/test/dev-server.test.ts`
   asserts both headers arrive unchanged.
2. **`POST /api/v1/financial-account` requires `idempotency-key`** (`idempotencyHeadersSchema`);
   the client sent none and would have failed with `400 REQUEST_VALIDATION_FAILED` before the
   handler ran. Fixed and pinned in `apps/web/test/api.test.ts`.
3. **Same-day records need an explicit snapshot-inclusion choice**
   (`classifyTransaction`, `packages/domain/src/financial.ts`). The client's former boolean
   checkbox could not express "unspecified", and a same-day write was refused. The screen now
   offers a three-valued choice and states the date rule next to it.
4. **`voidCommitBodySchema` requires the reviewed `context`** returned by the preview, including
   `reviewedPreviewDigest`. Sending only `reason` was refused. The client now commits only after a
   preview and echoes the API's own context verbatim.

## 5. Open findings (recorded, not hidden)

- Every category code is a row in the seeded `categories` table and **no endpoint lists them**. The
  tester must know a code; the codes are documented in `docs/development/LOCAL-DEVELOPMENT.md` §7.
  A category-listing endpoint is a real, unimplemented capability.
- `POST /api/v1/transactions/:id/corrections` (correction commit) needs a reviewed correction chain
  the client has no way to obtain yet, so the client offers preview/history reads only.
- Recurring cadences, debts, purchases, notifications, and the PWA shell are not implemented in the
  API; no screen pretends otherwise.
- **No browser click-through was performed by the agent.** The verification above is HTTP-level
  through the same origin the browser uses; the interactive proof is the user opening the client.
- `docs/ux/UI-DESIGN-SYSTEM.md` remains a Draft proposal with no accessibility validation. The
  client consumes its proposed tokens but claims no conformance.
- The email sink writes a one-time secret to a local file. It is refused in production
  (`loadApiConfig`), and that refusal is tested, but it is a deliberate development-only weakening
  of the "never persist a one-time secret" property and must not be enabled on a shared machine.
