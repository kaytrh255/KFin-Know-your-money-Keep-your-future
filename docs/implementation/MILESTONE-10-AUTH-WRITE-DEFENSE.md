# Milestone 10 — Browser state-change defense on the trusted-beta access surface (E-5 closure)

**Implementation date:** 2026-10-12<br>
**Base:** `main` at `28ee85f2c0137a97d52133bff471526d8b661926` (Milestone 09 merged as PR #9)<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2` (unchanged)<br>
**Scope:** Close erratum **E-5** — place the Milestone 04 browser state-change defense on the trusted-beta access write surface at the same lifecycle point every other mutation uses<br>
**Production readiness:** Not claimed

> **Provenance warning — read first.** This work was commissioned as the delivery of an existing commit `cf38b0eb8633e49333dd05006d2b8c30bfde248d` and a recovery directory `m10-recovery/` (a bundle, a patch and `RESTORE.md`) said to hold the Milestone 10 change set. **Neither exists.** Verification performed before any code was written:
>
> | Check | Command | Result |
> |---|---|---|
> | Object present locally | `git cat-file -t cf38b0eb8633e49333dd05006d2b8c30bfde248d` | `fatal: could not get object info` |
> | Present on GitHub | `gh api repos/kaytrh255/KFin-Know-your-money-Keep-your-future/commits/cf38b0eb…` | `HTTP 422` — `No commit found for SHA` |
> | Present anywhere in history | `git rev-list --all --objects` over **46** reachable commits, every local and remote branch, and every `refs/pull/*/head` | 0 matches |
> | Recovery artifact in the workspace | `find /` for `m10-recovery`, `RESTORE.md`, `*.bundle`, `*.patch*`; `grep -rl 'cf38b0eb' /` | nothing |
> | Recoverable from stash/reflog/dangling | `git stash list`, `git reflog --all`, `git fsck --lost-found`, `git cat-file --batch-all-objects` | nothing |
> | Branch exists on the remote | `git ls-remote origin`, branch-list API, repository event log | absent; no Milestone 10 branch was ever created |
> | Pull request exists | `gh pr list --state all` | PRs #2, #4, #5, #6, #7, #8, #9 only — all merged, none for Milestone 10 |
> | Actions artifacts / releases / gists | API | none |
>
> This is the **third** confirmed occurrence of this failure mode: Milestone 08 was commissioned from phantom commit `c97bc89`, Milestone 09 from phantom commit `3f2ad5e` and a non-existent branch `feature/csrf-guard-remaining-mutations`. As in both prior cases, **no figure from the phantom commit is reused, restated or relied on anywhere in this record.** Milestone 10 was implemented from scratch against `main`; its scope is the open item Milestone 09 itself recorded, and the authority for that scope is the owner's decision to reconstruct the milestone from the repository's own open findings rather than from the missing artifact.

## Why this milestone exists

The Milestone 09 verification record closed E-4 and then recorded, under *"Findings deliberately left open (not fixed here, out of confirmed scope)"*:

> **The auth routes' CSRF posture was not re-audited.** `apps/api/src/auth-routes.ts` applies `isBrowserSafeRequest` and a double-submit check inline per route rather than via `requireCsrfProtectedAuthentication`. That is pre-existing and outside E-4, which is scoped to the correction, void and schedule mutations. It was left untouched and should be independently reviewed.

This milestone is that independent review, and the closure of what it found. The review was performed against the code **before** any change, by measuring the running application rather than reading it:

| Request against the pre-Milestone-10 code | Observed |
|---|---|
| `POST /api/v1/auth/login`, foreign `Origin`, valid body | `403 AUTH_CSRF_FAILED` |
| `POST /api/v1/auth/login`, foreign `Origin`, schema-invalid body | `400 REQUEST_VALIDATION_FAILED` |
| `POST /api/v1/auth/login`, foreign `Origin`, malformed JSON | `500` |
| `POST /api/v1/auth/login`, foreign `Origin`, `application/x-www-form-urlencoded` | `500` |
| `POST /api/v1/auth/password/change`, foreign `Origin`, malformed JSON | `500` |
| `HEAD /api/v1/auth/me`, same-origin, valid session, no `x-kfin-csrf` | `403 AUTH_CSRF_FAILED` |
| `GET /api/v1/auth/me`, same-origin, valid session, no `x-kfin-csrf` | `200` |

Two distinct defects follow, and **neither is an authentication or authorization bypass** — an authenticated cross-site write was already refused. Both are defense *placement* defects, and both are observable from outside the process:

1. **The check ran inside the handler instead of at `onRequest`.** Every other mutation in this repository — fourteen registrations covering fifteen URLs, shipped by Milestones 04–09 across `apps/api/src/app.ts` and `apps/api/src/savings-routes.ts` — runs its browser state-change defense at `onRequest`, i.e. **before content-type parsing**. The ten access-surface writes ran it as the first statement of the handler body, i.e. **after** the body had already been parsed and Zod-validated. In the three cases measured above the parse/validation outcome decided the response and the browser-safety check was never reached at all, so the defense was not the first thing evaluated and a cross-site caller could tell its request apart from a same-site one by the status code alone.
2. **`HEAD` was treated as a state-changing method.** `requireAccess` exempted only `request.method.toUpperCase() === 'GET'`, while `isBrowserSafeRequest` treats `GET`, `HEAD` and `OPTIONS` as safe — the RFC 9110 §9.2.1 safe methods it short-circuits on. Fastify auto-exposes `HEAD` for every declared `GET` route, so a same-origin `HEAD` of an authenticated read answered `403` unless the caller also sent the CSRF header, while the equivalent `GET` answered `200`.

## Routes changed

All ten registrations are in `apps/api/src/auth-routes.ts`. Six are reachable without a session, so only the same-origin / Fetch Metadata half of the Milestone 04 defense can apply to them (there is no session-bound digest to double-submit yet). Four are session-bound and already required the token; they now resolve it at `onRequest`.

| # | Route | Before | After |
|---|---|---|---|
| 1 | `POST /api/v1/auth/register` | inline `isBrowserSafeRequest`, in handler | `onRequest: requireBrowserSafeWrite` |
| 2 | `POST /api/v1/auth/verification/resend` | inline, in handler | `onRequest: requireBrowserSafeWrite` |
| 3 | `POST /api/v1/auth/verify-email` | inline, in handler | `onRequest: requireBrowserSafeWrite` |
| 4 | `POST /api/v1/auth/login` | inline, in handler | `onRequest: requireBrowserSafeWrite` |
| 5 | `POST /api/v1/auth/password/reset-request` | inline, in handler | `onRequest: requireBrowserSafeWrite` |
| 6 | `POST /api/v1/auth/password/reset` | inline, in handler | `onRequest: requireBrowserSafeWrite` |
| 7 | `POST /api/v1/auth/logout` | `await requireAccess(request)` in handler | `onRequest: requireAccess` |
| 8 | `POST /api/v1/auth/logout-all` | `await requireAccess(request)` in handler | `onRequest: requireAccess` |
| 9 | `DELETE /api/v1/auth/sessions/:id` | `await requireAccess(request)` in handler | `onRequest: requireAccess` |
| 10 | `POST /api/v1/auth/password/change` | `await requireAccess(request)` in handler | `onRequest: requireAccess` |

The session-bound guards stay the same code path: `requireAccess` still authenticates, still applies `isBrowserSafeRequest`, still requires a session-bound `csrfDigest`, and still verifies the double-submit token through `authService.verifyCsrfToken`. Only *where* it runs changed. Handlers no longer re-authenticate; they read the principal the guard already stored, through a `requirePrincipal` accessor that throws `401 AUTHENTICATION_REQUIRED` if it is ever reached without one — it cannot be, because the guard runs first.

**Safe-method set corrected.** `requireAccess` now exempts the methods that carry no state change — `GET`, `HEAD` and `OPTIONS` — matching `isBrowserSafeRequest`'s own definition and RFC 9110 §9.2.1.

**What did not change.** No body contract, response schema or error envelope changed. `403` was **already** published for all ten routes by the shared `authResponses()` helper, so no contract edit was needed; the new suite asserts that it stays published rather than assuming it. No idempotency rule, session-rotation rule, cookie attribute, email-delivery path or service interface changed. No migration, no persisted-schema change, no dependency or lockfile change: `packages/database/migrations/`, `package.json` and `pnpm-lock.yaml` are byte-identical to `main`. The four read routes (`GET /auth/sessions`, `GET /auth/security-events`, `GET /auth/me`, and the `HEAD` Fastify auto-exposes for each) keep running on session authentication alone, unchanged.

## Behaviour after the change

- A cross-site request to any of the ten write routes answers `403 AUTH_CSRF_FAILED` **before its body is parsed**, whatever that body is: valid, schema-invalid, malformed JSON, an unsupported media type, or an HTML form. The service is never called.
- An unauthenticated request to a session-bound write route answers `401 AUTHENTICATION_REQUIRED` before body parsing.
- A request from a session-bearing principal with no `csrfDigest`, or with a missing or wrong `x-kfin-csrf` header, answers `403`. The guard still fails closed.
- A safe-method request (`GET`, `HEAD`, `OPTIONS`) to a read route is governed by session authentication alone, exactly as `GET` already was. **This means a cross-site `HEAD` of a read route answers `200`, mirroring the pre-existing `GET` behaviour** — a safe method carries no state change, and a cross-origin caller cannot read the response body of either. `HEAD` is no longer singled out for a `403` the equivalent `GET` never received.
- Same-site callers see no change to any success path.

## Explicit non-goals

- **No authentication or authorization change.** Owner scoping, session validation, principal resolution, generic unauthenticated outcomes, token rotation and cookie handling are untouched.
- **No change outside the access surface.** The financial, snapshot, transaction, correction, schedule, savings and reporting registrations are untouched; they already ran the shared guard at `onRequest` from Milestones 05–09.
- **Malformed JSON from a same-site caller still answers `500`.** This is a pre-existing error-mapping defect, not part of E-5, and it is recorded as an open finding with its reproduction in the verification record rather than quietly fixed here.
- **No new specification, SDD, ADR, roadmap, test-strategy or governance document.** This file and its matching verification record are the only new documents, plus a closure pointer appended to the Milestone 09 verification record. `docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md` does not track milestone evidence and was left untouched. No `SPEC-*` blocker is closed.
- **The safe-method set is now written in two places** — this module's `SAFE_METHODS` and `isBrowserSafeRequest`'s own short-circuit. Consolidating them (for example by exporting a predicate from `session-transport.ts`) would add a sixth file to a five-file change set, so it is disclosed as an open finding in the verification record instead. The two definitions are pinned to agree at `GET`/`HEAD`/`OPTIONS` by the new suite.

## Quality gates (all executed, none claimed)

- TypeScript typecheck (`pnpm run typecheck`): clean, application **and** tests.
- Evidence harness (`pnpm run evidence:check` and `pnpm run evidence:test`): 25 modules / 29 harness files checked; **16/16 passing**, with the frozen commit reachable.
- Credential-free unit and API suite (`pnpm run test:unit`): **573 passed, 0 failed, 0 skipped** across 23 files. Baseline before this milestone on the same parent commit was **485 passed** across 22 files; the delta is exactly the new 88-test file.
- Real-PostgreSQL integration suite (`pnpm run test:integration`): **64 passed** across 7 files against a genuine **PostgreSQL 17.6** server started for this milestone in the sandbox.

## Files

| File | Change |
|---|---|
| `apps/api/src/auth-routes.ts` | +51 / −11 |
| `apps/api/test/auth-write-defense.test.ts` | new, 581 lines, 88 tests |
| `docs/implementation/MILESTONE-10-AUTH-WRITE-DEFENSE.md` | new |
| `docs/evidence/2026-10-12-MILESTONE-10-VERIFICATION.md` | new |
| `docs/evidence/2026-10-10-MILESTONE-09-VERIFICATION.md` | closure pointer appended |
