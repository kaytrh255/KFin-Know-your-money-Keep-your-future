# Milestone 10 verification — E-5 closure, browser state-change defense on the trusted-beta access surface (2026-10-12)

**Branch:** `arena/bfaf5019-kfin-know-your-money-keep-your`, based on `main` at `28ee85f2c0137a97d52133bff471526d8b661926` (PR #9 merged)<br>
**Recorded:** 2026-10-12 (Asia/Saigon)<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2` (unchanged)<br>
**Production readiness:** Not claimed

> **Provenance warning — read first.** This work was commissioned as the delivery of an existing commit `cf38b0eb8633e49333dd05006d2b8c30bfde248d` plus a `m10-recovery/` directory (bundle, patch, `RESTORE.md`) that were said to hold the Milestone 10 change set. **Neither exists.** Verification performed before any code was written:
>
> | Check | Command | Result |
> |---|---|---|
> | Object present locally | `git cat-file -t cf38b0eb8633e49333dd05006d2b8c30bfde248d` | `fatal: could not get object info` |
> | Present on GitHub | `gh api repos/kaytrh255/KFin-Know-your-money-Keep-your-future/commits/cf38b0eb…` | `HTTP 422` — `No commit found for SHA` |
> | Present anywhere in history | `git rev-list --all --objects` over **46** reachable commits, every local and remote branch, and every `refs/pull/*/head` | 0 matches |
> | Recovery artifact anywhere on the filesystem | `find / -xdev` for `*m10*`, `RESTORE.md`, `*.bundle`, `*.patch`; `grep -rl 'cf38b0eb' /` | nothing |
> | Recoverable from stash/reflog/dangling | `git stash list`, `git reflog --all`, `git fsck --lost-found`, `git cat-file --batch-all-objects` (**46** commits, 848 objects, none unreachable) | nothing |
> | Branch exists on the remote | `git ls-remote origin` (9 branches), branch-list API, repository event log | absent; no Milestone 10 branch was ever created or pushed |
> | Pull request exists | `gh pr list --state all` | PRs #2, #4, #5, #6, #7, #8, #9 only — all merged, none for Milestone 10 |
> | Actions artifacts, releases, gists | API | none |
>
> This is the **third** confirmed occurrence of this failure mode — Milestone 08 (phantom `c97bc89`) and Milestone 09 (phantom `3f2ad5e`, non-existent branch `feature/csrf-guard-remaining-mutations`) were commissioned under the identical condition. **No figure from the phantom commit is reused, restated, or relied on as evidence anywhere in this record.** Milestone 10 was implemented from scratch against `main`. Its scope is the open item Milestone 09 itself recorded, and the authority for fixing it now is the owner's explicit decision to reconstruct the milestone from the repository's own open findings rather than from the missing artifact.

## Scope statement

One item, confirmed against `main` before implementation. No feature work beyond it.

| # | Item | State at `main` before this milestone | Authority |
|---|---|---|---|
| 1 | Browser state-change defense placement on the trusted-beta access write surface, and the safe-method set its guard exempts | **Gap.** The ten access-surface writes ran the check inside the handler (after body parsing), and `requireAccess` exempted only `GET` while `isBrowserSafeRequest` short-circuits on `GET`, `HEAD` and `OPTIONS`. | Erratum **E-5**, recorded as a finding deliberately left open by Milestone 09 (`docs/evidence/2026-10-10-MILESTONE-09-VERIFICATION.md`) |

**No migration and no persisted-schema change.** `git status --porcelain packages/database/migrations/ package.json pnpm-lock.yaml` is empty — migrations, manifest and lockfile are byte-identical to `main`.

## Environment

- Node.js `v22.22.3`, pnpm `10.34.6` via Corepack, `corepack pnpm install --frozen-lockfile` (1.4 s, lockfile unchanged).
- **PostgreSQL 17.6 was available for this milestone**, unlike Milestone 09 which recorded the absence of any PostgreSQL instance as a gap. A genuine 17.6 server was provisioned in the sandbox: the `linux-x64` platform package of the npm distribution `@embedded-postgres/linux-x64@17.6.0-beta.15` was unpacked, its bundled ICU-60 libraries were given the sonames the binaries link against, `initdb -U postgres` initialised a data directory, and the server was started on `127.0.0.1:5432` with database `kfin_test` and the exact credentials the CI job uses. `postgres --version` and `SHOW server_version` both report `17.6`.
  **Caveat, stated plainly:** this is PostgreSQL **17.6** from a third-party repackaging, not the `postgres:17.6-alpine` image the CI job provisions. The version matches; the distribution and build do not. CI remains the authority for the integration result.
- No Supabase or production database was contacted. There is no `.env` file; `DATABASE_URL` is unset; the integration suite ran only under `KFIN_INTEGRATION_TARGET=non-production` against the disposable local database.

### The frozen commit must be reachable for `evidence:test`

The harness verifies its authoritative documents with `git show a48d2c56…:<doc>` (`evidence/spec-fin-02/src/runner.mjs` → `verifyFrozenAuthoritativeDocs`). In a **shallow, `main`-only clone the frozen commit is absent**, and three harness tests fail — reproducing exactly the 13/16 result previously reported for this repository:

```
# pass 13
# fail 3
not ok 4  - runner without DATABASE_URL emits BLOCKED artifacts and executes no PostgreSQL case
not ok 5  - runner refuses a configured URL until non-production target is explicitly confirmed
not ok 13 - authoritative documents remain byte-identical to frozen candidate
  error: Command failed: git show a48d2c5683550859c1b4e19e9d06750616adc0a2:docs/architecture/SPEC-FIN-02-SNAPSHOT-CONCURRENCY.md
         fatal: path 'docs/architecture/SPEC-FIN-02-SNAPSHOT-CONCURRENCY.md' exists on disk, but not in 'a48d2c56…'
```

The run recorded below was made with full history: every remote branch and every `refs/pull/*/head` was fetched, so the frozen commit is reachable through 13 refs, and the harness answers **16/16**. Note that `git fetch --all` alone is **not** sufficient in this clone (its refspec is single-branch); the branches must be fetched explicitly, exactly as `actions/checkout@v4` with `fetch-depth: 0` does in CI.

## What changed

`apps/api/src/auth-routes.ts` — +51 / −11:

1. **Safe-method set corrected.** A module-level `SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])` replaces the `request.method.toUpperCase() === 'GET'` exemption in `requireAccess`, matching `isBrowserSafeRequest` and RFC 9110 §9.2.1.
2. **New `onRequest` guard for the pre-session writes.** `requireBrowserSafeWrite` applies the same-origin / Fetch Metadata half of the Milestone 04 defense — the only half that can apply without a session — and is registered as `onRequest` on `register`, `verification/resend`, `verify-email`, `login`, `password/reset-request` and `password/reset`. The six in-handler checks were removed.
3. **The session-bound writes resolve their guard at `onRequest`.** `logout`, `logout-all`, `DELETE sessions/:id` and `password/change` now declare `onRequest: requireAccess`; their handlers read the principal the guard stored through a new `requirePrincipal` accessor instead of re-authenticating. The guard's logic — authentication, same-origin, session-bound digest, double-submit verification — is unchanged.
4. Explanatory comments only, no other executable change.

`apps/api/test/auth-write-defense.test.ts` — **new, 581 lines, 88 tests.**

`docs/implementation/MILESTONE-10-AUTH-WRITE-DEFENSE.md` — new. `docs/evidence/2026-10-09-MILESTONE-07-VERIFICATION.md` and `docs/evidence/2026-10-10-MILESTONE-08-VERIFICATION.md` were **not** touched: E-5 was recorded in the Milestone 09 record, and only that record receives the closure pointer.

**No contract edit.** `403` was already published for all ten routes by the shared `authResponses()` helper. The new suite asserts it stays published for each route rather than assuming it.

## Measured behaviour: before and after

Every row is an executed request through `app.inject` against the real route table. The "before" rows were measured on unmodified `main` `28ee85f` before any edit was made, and the last two of them were re-measured in a second pass with the change temporarily reverted, so that no cell in this table is an inference from reading the code. `POST /auth/logout` unauthenticated with a well-formed (empty) body was measured `401` on both sides, which is why the malformed-body row isolates the parse ordering and nothing else.

| Request | Before | After |
|---|---|---|
| `POST /auth/login`, foreign `Origin`, valid body | `403` | `403` |
| `POST /auth/login`, foreign `Origin`, schema-invalid body | `400` | **`403`** |
| `POST /auth/login`, foreign `Origin`, malformed JSON | `500` | **`403`** |
| `POST /auth/login`, foreign `Origin`, `x-www-form-urlencoded` | `500` | **`403`** |
| `POST /auth/password/change`, foreign `Origin`, malformed JSON | `500` | **`403`** |
| `POST /auth/logout`, unauthenticated, malformed JSON | `500` | **`401`** |
| `HEAD /auth/me`, same-origin, valid session, no CSRF header | `403` | **`200`** |
| `GET /auth/me`, same-origin, valid session, no CSRF header | `200` | `200` |
| `POST /auth/login`, same-origin, valid body | `200` | `200` |

## Route-by-route result

All ten write routes, from the new suite. Every cell is an executed assertion, not an expectation.

| Route | 401 unauth | 4-case 403 matrix | 4 body shapes rejected 403 **before parsing** | same-site happy path | same-site Fetch Metadata, no `Origin` | fail-closed (no digest) | service not called on rejection | `403` in OpenAPI |
|---|---|---|---|---|---|---|---|---|
| `POST /auth/register` | n/a | ✓ | ✓ | ✓ 202 | ✓ | n/a | ✓ | ✓ |
| `POST /auth/verification/resend` | n/a | ✓ | ✓ | ✓ 200 | ✓ | n/a | ✓ | ✓ |
| `POST /auth/verify-email` | n/a | ✓ | ✓ | ✓ 200 | ✓ | n/a | ✓ | ✓ |
| `POST /auth/login` | n/a | ✓ | ✓ | ✓ 200 | ✓ | n/a | ✓ | ✓ |
| `POST /auth/password/reset-request` | n/a | ✓ | ✓ | ✓ 200 | ✓ | n/a | ✓ | ✓ |
| `POST /auth/password/reset` | n/a | ✓ | ✓ | ✓ 200 | ✓ | n/a | ✓ | ✓ |
| `POST /auth/logout` | ✓ | ✓ | ✓ | ✓ 200 | ✓ | ✓ | ✓ | ✓ |
| `POST /auth/logout-all` | ✓ | ✓ | ✓ | ✓ 200 | ✓ | ✓ | ✓ | ✓ |
| `DELETE /auth/sessions/{id}` | ✓ | ✓ | ✓ | ✓ 200 | ✓ | ✓ | ✓ | ✓ |
| `POST /auth/password/change` | ✓ | ✓ | ✓ | ✓ 200 | ✓ | ✓ | ✓ | ✓ |

The four unsafe browser contexts are: foreign `Origin`; scheme-less lookalike `Origin` (`https://api.kfin.test.evil.example`); `sec-fetch-site: cross-site`; and neither `Origin` nor Fetch Metadata. The four body shapes are: malformed JSON, `application/x-www-form-urlencoded`, `text/plain`, and a schema-invalid body carrying an injected `userId`. Every one of them answers `403 AUTH_CSRF_FAILED` with the service never called.

**Scoping proved, not assumed.** `GET /auth/me`, `GET /auth/sessions` and `GET /auth/security-events` are asserted to answer `200` on plain session authentication with no CSRF header, and `HEAD /auth/me` is asserted to answer `200` and to mirror the cross-site `GET`.

## Gates executed

| Gate | Command | Result |
|---|---|---|
| Typecheck (app **and** tests) | `corepack pnpm run typecheck` | clean, no output |
| Evidence harness check | `corepack pnpm run evidence:check` | 25 modules, 29 harness files checked |
| Evidence harness tests | `corepack pnpm run evidence:test` | **16 passed, 0 failed, 0 skipped** |
| Unit + API tests | `corepack pnpm run test:unit` | **573 passed, 0 failed, 0 skipped** (23 files) |
| Real-PostgreSQL integration | `KFIN_INTEGRATION_TARGET=non-production … corepack pnpm run test:integration` | **64 passed, 0 failed** (7 files) on PostgreSQL 17.6 |

Baseline before this milestone on the same parent commit `28ee85f` was **485 passed** across 22 files, measured in this sandbox before any edit. The delta is exactly the new 88-test file; the E-4 suite (136 tests), the M08 snapshot suite and the M07 regression block all still pass, untouched.

> **These figures are the E-5 milestone's own, recorded at `de91113` and left unchanged for auditability.** Milestone 10's E-6 addendum, committed on the same branch afterwards, raises the unit total to **626 passed across 24 files** and leaves every other gate as it stands above; see [the E-6 addendum](#e-6-addendum--unreadable-bodies-are-client-errors-2026-10-12) for its own gate table.

## Mutation checks

Each mutation was applied to the source, the new suite was run, and the mutation was reverted (verified afterwards with `git diff --stat`: only `auth-routes.ts` remains modified). All five were killed.

| # | Mutation | Result |
|---|---|---|
| A | `POST /auth/login` reverted to the in-handler `isBrowserSafeRequest` check | **Killed** — 1 targeted failure: *rejects sign-in with 403 before body parsing* |
| B | `requireAccess` exempts only `'GET'` again | **Killed** — 2 failures: *does not demand a CSRF token for HEAD of an authenticated read*, *makes HEAD mirror GET for a cross-site caller* |
| C | `POST /auth/password/change` reverted to `await requireAccess(request)` in the handler | **Killed** — 1 targeted failure: *rejects a cross-site password change with 403 before body parsing* |
| D | `POST /auth/login` loses its guard entirely | **Killed** — 5 failures: the four unsafe-context cases plus the before-parsing case |
| E | `403: errorResponseSchema` removed from the shared `authResponses()` | **Killed** — 10 failures, one per route, from the OpenAPI contract assertions |

Mutation C is the one that pins the finding itself: with the guard back in the handler, the ordering assertion fails, which is the proof that the new test detects the defect rather than merely describing it. Mutation E proves the published-contract half is independently tested.

## Findings deliberately left open (not fixed here, out of confirmed scope)

- ~~**Malformed JSON from a same-site caller still answers `500`.**~~ **CLOSED BY E-6 (2026-10-12), in the same branch and the same PR.** The generic error handler mapped every body-layer client error to `500`; it now answers the `4xx` Fastify's own parsers already attach, with the stable code `REQUEST_BODY_UNREADABLE` and a safe message. See [the E-6 addendum](#e-6-addendum--unreadable-bodies-are-client-errors-2026-10-12). The original wording is kept for auditability. **What remains open from that finding:** `413` and `415` are returned correctly on the wire but are not enumerated in any route's published OpenAPI response list — a contract-completeness gap that predates this work and is recorded in the addendum rather than fixed by editing the specification.
- **The safe-method set now exists in two places.** `SAFE_METHODS` in `auth-routes.ts` and the short-circuit inside `isBrowserSafeRequest`. Consolidating them would add a sixth file to a change set held to five, so it is disclosed rather than done. The new suite pins the two definitions to agree at `GET`, `HEAD` and `OPTIONS`; a future divergence that breaks the agreement will fail the suite.
- **A cross-site `HEAD` of a read route answers `200`.** This is intended, and it is the point of the safe-method fix: `HEAD` is a safe method, carries no state change, and its response body — like `GET`'s — is not readable to a cross-origin caller. It now mirrors the `GET` behaviour that already existed. Recorded explicitly so QA does not read it as an oversight.
- **The integration run used a repackaged PostgreSQL 17.6, not the CI image.** See the environment caveat above. The version matches the CI service; the build does not.
- **No client-facing change.** No web/PWA client exists in this repository, so the guard is verified at the API boundary only; end-to-end browser behaviour remains unverified until a client exists.
- No specification, SDD, ADR, roadmap, test-strategy or governance document was created or modified by the code change. `docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md` does not track milestone evidence and was left untouched. No `SPEC-*` blocker is closed.

## Erratum E-5 status

**Closed.** The access-surface writes now run the Milestone 04 browser state-change defense at the same lifecycle point as every other mutation in the API — fourteen registrations covering fifteen URLs — and `requireAccess` exempts exactly the safe methods, matching `isBrowserSafeRequest`. `403` stays published in the contract for all ten URLs. A closure pointer was appended to `docs/evidence/2026-10-10-MILESTONE-09-VERIFICATION.md`, the record that raised the finding; the M09 wording itself is deliberately left unchanged for auditability.

## Not claimed

No owner approval, ADR acceptance, blocker closure, production readiness, Supabase result, or `FIN-RACE` PASS is implied. The phantom commit's figures do not exist and appear nowhere in this record as results. This milestone does not claim that the access surface is exhaustively reviewed — it closes the specific finding Milestone 09 raised. The auth routes' rate limiting, abuse limits, generic-outcome properties and session-rotation semantics were not re-audited here and remain as Milestone 04 left them.

---

## E-6 addendum — unreadable bodies are client errors (2026-10-12)

**Committed on:** the same branch `arena/bfaf5019-kfin-know-your-money-keep-your`, as a second commit on PR #10. **Base for this addendum:** `de91113f8991d5f2023e064dfb92fc113866b102`.<br>
**Production readiness:** Not claimed

### What was closed

The finding recorded above — *malformed JSON from a same-site caller still answers `500`* — was not new to this milestone. The Milestone 05 QA fix recorded it five milestones earlier in the same words (*"Pre-existing and out of scope: the generic error handler still maps Fastify content-type and JSON-parse errors to `500` on every route"*). Both records said the fix belonged in the shared error handler. This addendum makes it there.

**Cause, measured rather than assumed.** Fastify's content-type parsers reject a request before any handler or schema validation, and the error already carries the correct client status. The application's `setErrorHandler` recognised only `KfinServiceError` and `validation` errors, so every body-layer error fell through to its catch-all `500 INTERNAL_ERROR`. The framework codes and their correct statuses, read from the running parser:

| Framework code | Correct status | Meaning |
|---|---|---|
| `FST_ERR_CTP_INVALID_JSON_BODY` | `400` | Not valid JSON — also raised for `__proto__` payloads `secure-json-parse` refuses (SEC-APP-11) |
| `FST_ERR_CTP_EMPTY_JSON_BODY` | `400` | Empty body with a JSON content type |
| `FST_ERR_CTP_INVALID_MEDIA_TYPE` | `415` | Content type with no registered parser |
| `FST_ERR_CTP_BODY_TOO_LARGE` | `413` | Over the 64 KiB `bodyLimit` |

**The change:** `apps/api/src/app.ts` **+47 / −0** — one branch in the shared error handler, placed after the validation branch and before the catch-all `500`, plus a narrow predicate `isBodyLayerClientError` that accepts only `FST_ERR_CTP_*` codes carrying a status in `[400, 500)`. It responds with `error.statusCode`, the stable code `REQUEST_BODY_UNREADABLE`, the fixed message `The request body could not be read.`, and the correlation ID. The framework message is never echoed — the client response cannot contain `FST_ERR_*`, the parser wording, or the content type; only the bounded framework code and correlation ID reach the server log, at `warn`. No route, guard, schema, service, migration, dependency or lockfile changed, and **no OpenAPI contract was edited**: `400` was already published everywhere, and this change makes the API honour it.

### Measured before and after

Every row is an executed request against the real route table. "Before" was produced on this branch with the new branch reverted and nothing else changed; "after" with it applied. The last four rows are the precedence evidence — they prove the fix did not trade away the E-5 or E-4 guarantees.

| Same-origin request | Before | After |
|---|---|---|
| `POST /auth/login`, malformed JSON | `500 INTERNAL_ERROR` | **`400 REQUEST_BODY_UNREADABLE`** |
| `POST /auth/login`, truncated JSON | `500 INTERNAL_ERROR` | **`400 REQUEST_BODY_UNREADABLE`** |
| `POST /auth/login`, empty JSON body | `500 INTERNAL_ERROR` | **`400 REQUEST_BODY_UNREADABLE`** |
| `POST /auth/login`, `x-www-form-urlencoded` | `500 INTERNAL_ERROR` | **`415 REQUEST_BODY_UNREADABLE`** |
| `POST /auth/login`, body over 64 KiB | `500 INTERNAL_ERROR` | **`413 REQUEST_BODY_UNREADABLE`** |
| `POST /auth/login`, `__proto__` payload | `500 INTERNAL_ERROR` | **`400 REQUEST_BODY_UNREADABLE`** |
| `POST /auth/logout`, malformed JSON | `500 INTERNAL_ERROR` | **`400 REQUEST_BODY_UNREADABLE`** |
| `POST /transactions`, malformed JSON | `500 INTERNAL_ERROR` | **`400 REQUEST_BODY_UNREADABLE`** |
| `POST /auth/login`, schema-invalid JSON | `400 REQUEST_VALIDATION_FAILED` | `400 REQUEST_VALIDATION_FAILED` |
| `POST /auth/login`, `text/plain` body | `400 REQUEST_VALIDATION_FAILED` | `400 REQUEST_VALIDATION_FAILED` |
| `POST /auth/login`, cross-site, malformed JSON | `403 AUTH_CSRF_FAILED` | `403 AUTH_CSRF_FAILED` |
| `POST /auth/logout`, unauthenticated, malformed JSON | `401 AUTHENTICATION_REQUIRED` | `401 AUTHENTICATION_REQUIRED` |

### Regression suite

`apps/api/test/request-body-error-mapping.test.ts` — **new, 509 lines, 53 tests**, over four routes chosen so the mapping is proved to be a property of the shared handler rather than of one route family: `POST /auth/login` (pre-session write), `POST /auth/password/change` (session-bound write with a body), `POST /auth/logout` (session-bound write with **no** body contract), and `POST /transactions` (financial mutation). It covers the four parser rejections, the `__proto__` payload, a *never 500* sweep, envelope shape and non-leakage, `400` presence in each route's published contract, and the precedence cases above.

One assumption of the suite was corrected by its own first run and is recorded rather than quietly changed: `POST /auth/logout` declares no body contract, so a body that *parses* is ignored and the request is served (`200`), while a body that cannot be parsed is still `400`. Two assertions were therefore scoped to the routes that actually declare a body contract, and the asymmetry is now pinned by its own test.

### Gates re-executed for E-6

| Gate | Command | Result |
|---|---|---|
| Typecheck (app **and** tests) | `corepack pnpm run typecheck` | clean, no output |
| Evidence harness check | `corepack pnpm run evidence:check` | 25 modules, 29 harness files checked |
| Evidence harness tests | `corepack pnpm run evidence:test` | **16 passed, 0 failed, 0 skipped** |
| Unit + API tests | `corepack pnpm run test:unit` | **626 passed, 0 failed, 0 skipped** (24 files) |
| Real-PostgreSQL integration | `KFIN_INTEGRATION_TARGET=non-production … corepack pnpm run test:integration` | **64 passed, 0 failed** (7 files) on PostgreSQL **17.6** |

Baseline at `de91113` was **573 passed across 23 files**; the delta is exactly the new 53-test file. The E-4 suite, the M08 snapshot suite, the M10 E-5 suite and the M07 regression block all still pass, untouched.

### Mutation checks

Each mutation was applied to `apps/api/src/app.ts`, the new suite was run, and the mutation was reverted (final state re-verified with `git diff --stat`).

| # | Mutation | Result |
|---|---|---|
| A | Remove the new branch entirely (restore the pre-fix `500` catch-all) | **Killed** — 28 failures |
| B | Exclude `FST_ERR_CTP_EMPTY_JSON_BODY` from the classified family | **Killed** — 8 failures |
| C | Echo the framework `message` instead of the safe message | **Killed** — 12 failures |
| D | Always answer `400`, ignoring the framework status | **Killed** — 8 failures |
| E | Broaden the prefix from `FST_ERR_CTP_` to `FST_ERR_` | **Survived** — see below |
| E′ | Broaden the prefix **and** remove the earlier validation branch | **Killed** — 6 failures |

**Mutation E survived, and this is reported rather than hidden.** Broadening the prefix changes nothing observable, because `FST_ERR_VALIDATION` is already intercepted by the existing `validation` branch that runs one branch earlier: the narrow prefix and the branch order are two independent protections for the same property, so removing either one alone is a semantically equivalent mutant. Mutation E′ removes both at once and is killed by the six validation-precedence assertions, which is what proves those assertions detect a real regression rather than describing one. The lesson is recorded here so that a future reviewer who sees E survive does not read it as a dead test.

### Findings left open by this addendum

- **`413` and `415` are returned correctly but are not published in any route's OpenAPI response list.** Measured on this branch: no route in `packages/contracts/src/` or `apps/api/src/` declares either status, so both were already outside the published contract for every route before this change — this addendum only replaced a wrong `500` with the correct client status. Adding them means editing the shared response helpers for the whole API, which is a specification change, not a bug fix, and it is deliberately not made here. Recorded so QA can decide the contract question separately.
- **The `text/plain` body on a JSON-contract route is a validation error, not a parser error** (`400 REQUEST_VALIDATION_FAILED`), because Fastify registers a built-in `text/plain` parser: the body parses to a string and then fails the object contract. Measured and pinned by test, and unchanged by this work.
- **No client-facing change.** No web/PWA client exists in this repository, so the mapping is verified at the API boundary only.

### Not claimed (E-6)

No owner approval, ADR acceptance, blocker closure, production readiness, Supabase result or `FIN-RACE` PASS is implied. The integration run used the same repackaged PostgreSQL 17.6 described in the environment section above — the version matches the CI service, the distribution does not; CI remains the authority. This addendum closes one error-mapping defect and claims nothing about the correctness of any other error status in the API.
