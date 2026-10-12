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

## 2.1 Addendum (2026-10-12, Milestone 11): the register/reset flow changed after this run

The measurements in §3 are preserved exactly as they were taken, on the tree that existed then. Two
of those rows describe behaviour that the OQ-20 implementation has since replaced, so they are marked
here rather than rewritten:

| §3 row | Status after Milestone 11 |
|---|---|
| one-time code read from the local sink: `email_verification_otp` | **superseded** — registration sends nothing at all; the only sink message is `password_reset` |
| `POST /api/v1/auth/verify-email` → `200` with a session | **superseded** — the route no longer exists (`404`); the session comes from `POST /api/v1/auth/login` |

See [`docs/implementation/MILESTONE-11-OTP-RESET-ONLY.md`](../implementation/MILESTONE-11-OTP-RESET-ONLY.md)
§7 for the same flows re-measured on the new tree, including the empty sink after registration, the
single-use reset OTP, the revoked sessions, and the byte-identical reset responses for unknown and
known addresses.

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
16 pass / 0 fail / 0 skipped; `typecheck` exit 0; `test:unit` **691 passed / 30 files**
(baseline `33357ea`: 626 / 24; the client adds 40 tests across four files, the email sink 9,
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

## 4.1 Arena preview access (added after the first run)

The client is reachable without a terminal through the platform's preview proxy at
`https://<port>-<sandboxId>.e2b.app` (`E2B_SANDBOX_ID` supplies the id; port 5173
is the dev server). Because a preview proxy may rewrite the `Host` header while the
API compares `Origin` against `Host`, the dev server now resolves the
browser-facing host from `X-Forwarded-Host` → browser-attested `Origin` → `Host`,
and refuses cross-site or header-less state-changing requests itself with
`403 LOCAL_PROXY_ORIGIN_REJECTED` rather than forwarding them. `GET /__dev__/request-context`
and the client's `#/self-check` screen report which case applied.

Measured through a preview-shaped origin (`Host: 5173-<sandboxId>.e2b.app`,
`Origin: https://5173-<sandboxId>.e2b.app`), on the local API and database:

| Request | Result |
|---|---|
| `POST /api/v1/auth/login` | `200` |
| `GET /api/v1/auth/me` (session cookie) | `200` |
| `POST /api/v1/financial-account/snapshots` with a deliberately stale version, CSRF header present | `409 FIN_SNAPSHOT_STALE_STATE` — a business-rule answer, so origin + CSRF + session all passed |
| `POST /api/v1/auth/login` with an unregistered probe address | `401` (evaluated, not refused by origin) |
| the same write with a cross-site `Origin` | `403` from the API, and `403` from the proxy when it reaches the proxy first |

**Not verified:** the preview URL cannot be fetched from inside this sandbox (egress
is restricted and the TLS handshake to `*.e2b.app` is refused), so no claim is made
about the platform proxy's own header behaviour; both plausible behaviours are
handled and tested, and the self-check screen reports which one is in effect in the
user's browser.

## 4.2 A rejected registration could not be explained (found by the user, fixed)

Registering from the preview client answered `400 REQUEST_VALIDATION_FAILED — "The
request does not match the API contract."` with correlation ID
`4f6c54eb-1a71-4b19-a9c3-be28579bfb99`, and nothing else.

Measured, in this order:

- The correlation ID is retained **nowhere**: `disableRequestLogging: true` and
  `requestIdHeader: false` mean no request is logged and the ID is API-generated,
  and the validation branch of the shared error handler logged nothing. The
  database held no trace either, so the request was rejected before the service
  ran — i.e. by the body schema.
- The client's register payload matches `registerBodySchema` field for field, and
  the same payload through the client origin answers `202 accepted`. The form is
  not the defect, and neither is the invitation code it was handed: the code in
  `.env.preview-account` passes `invitationCodeSchema`, and 200 freshly generated
  codes pass it 200/200.
- The published OpenAPI for `invitationCode` said `{minLength: 1, maxLength: 64}`
  and nothing else, because the rule is a `.refine` and a refine cannot become a
  JSON-schema `pattern`. The contract callers were pointed at did not contain the
  rule the API had enforced. The service password policy (`12–128` plus a
  common/similarity check) was likewise unpublished behind a `1–200` contract.

So the request that failed is genuinely unrecoverable, and this record says so
rather than guessing its field. What changed is that the failure class is now
identifiable — see `docs/implementation/MILESTONE-10-VALIDATION-ERROR-DETAIL.md`
for the change and its evidence. Reproduced live after the change, a register body
with a malformed invitation code answers `400` naming `invitationCode`, the same
correlation ID appears in the API log with the same field list, an unknown key is
named (`emailVerified`), a correct payload still answers `202`, and no submitted
password or invitation code appears in the response or the log. New cover:
`apps/api/test/validation-contract-detail.test.ts` and two tests in
`apps/web/test/api.test.ts`.

## 4.3 The unit gate depended on the developer's shell (found while fixing 4.2)

The unit gate run once reported `1 failed | 690 passed`, then passed repeatedly on
the same tree. It was not flaky: it was environment-sensitive, and it reproduced
5 times out of 5 under the condition that mattered.

`apps/web/test/dev-server.test.ts` starts the dev server as a child process with
`{ ...process.env, … }`. When the shell has sourced `.env` — which is how the API,
the client, and this document's own commands are started — `EMAIL_OUTBOX_DIR` is
exported, so the case "hides the local email sink when no outbox directory is
configured" was handed the one variable it is about, and answered `200` where it
must answer `404`. Any developer following the documented run steps saw a red
unit gate; a shell without `.env` saw a green one.

The fix is in the test only: the spawn helper no longer inherits
`EMAIL_OUTBOX_DIR`, so each case states the directory itself (one sets it, the rest
leave it unset) and the assertion tests the behaviour instead of the ambient
shell. No product code changed. Verified with `.env` sourced (3 × `691 passed`,
previous 5 × `1 failed | 690 passed`) and with a clean shell (`691 passed`).

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
