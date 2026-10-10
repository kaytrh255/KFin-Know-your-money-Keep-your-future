# Milestone 09 verification — E-4 closure, CSRF defense on the correction, void and schedule mutations (2026-10-10)

**Branch:** `arena/8c6730b5-kfin-know-your-money-keep-your`, based on `main` at `32a70e018e485666a9a37e2b2f5bc60a71edeb06` (PR #8 merged)<br>
**Recorded:** 2026-10-10 (Asia/Saigon)<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2` (unchanged)<br>
**Production readiness:** Not claimed

> **Provenance warning — read first.** This work was commissioned as the delivery of an existing commit `3f2ad5e9467cc0caf99581b9c3aa530f39882bac` on a branch `feature/csrf-guard-remaining-mutations`. **Neither exists.** Verification performed before any code was written:
>
> | Check | Command | Result |
> |---|---|---|
> | Object present locally | `git cat-file -t 3f2ad5e9467cc0caf99581b9c3aa530f39882bac` | `fatal: could not get object info` |
> | Fetchable from remote | `git fetch origin 3f2ad5e9467cc0caf99581b9c3aa530f39882bac` | `fatal: remote error: upload-pack: not our ref` |
> | Present on GitHub | `gh api repos/kaytrh255/KFin-Know-your-money-Keep-your-future/commits/3f2ad5e…` | `HTTP 422` — `No commit found for SHA` |
> | Branch exists on remote | `git ls-remote origin` (8 branches listed) | name absent |
> | Branch exists (API) | `gh api …/branches?per_page=100` | name absent |
> | Present anywhere in history | `git rev-list --all --objects` over **43** reachable commits, every branch and every `refs/pull/2,4,5,6,7,8/head` | 0 matches |
> | Recoverable from stash/reflog/dangling | `git stash list`, `git reflog --all`, `git fsck --lost-found` | nothing |
>
> **No figure from that phantom commit is reused, restated, or relied on as evidence anywhere in this record.** Milestone 09 was implemented from scratch against `main`, and every result below was produced by the commands shown, on this branch, on 2026-10-10. This is the second confirmed occurrence of this failure mode — see the identical provenance warning in `docs/evidence/2026-10-10-MILESTONE-08-VERIFICATION.md` (phantom commit `c97bc89`).

## Scope statement

One item, confirmed against `main` before implementation. No feature work beyond it.

| # | Item | State at `main` before this milestone |
|---|---|---|
| 1 | CSRF defense on the seven correction, void and schedule mutation registrations (eight URLs) | **Gap.** All seven ran plain `preHandler: requireAuthentication` while the M05 onboarding route, the M07 transaction route, all six M06 savings mutations and (after M08) the snapshot route ran `onRequest: requireCsrfProtectedAuthentication`. Recorded as open by M08 under erratum **E-4**. |

**No migration and no persisted-schema change.** `git status --porcelain packages/database/migrations/ package.json pnpm-lock.yaml` is empty — migrations, manifest and lockfile are byte-identical to `main`.

## Environment

- Node.js `v22.22.3`, pnpm `10.34.6` via Corepack, `corepack pnpm install --frozen-lockfile`.
- **No PostgreSQL instance was available in this sandbox** (`psql`, `pg_ctl`, `postgres`, `pg_isready` all absent; no package manager access). The PostgreSQL integration suite was therefore **not executed locally** and is **not claimed** here. It is executed by CI, which provisions `postgres:17.6-alpine`. See [Not claimed](#not-claimed).
- No Supabase or production database was contacted. There is no `.env` file; `DATABASE_URL` is unset.

## What changed

`apps/api/src/app.ts` — +35 / −7:

1. **Seven registrations moved to `onRequest`.** Each `preHandler: requireAuthentication` became `onRequest: requireCsrfProtectedAuthentication` for `transactions/:id/correction-preview`, `transactions/:id/void-preview`, `transactions/:id/corrections`, `transactions/:id/void`, `schedule/one-off`, `schedule/occurrences/:id/confirm`, and the shared `schedule/occurrences/:id/{skip,cancel}` registration. That is seven guard swaps covering eight URLs.
2. **`403` added to the shared response contract.** One line, `403: errorResponseSchema`, added inside `correctionResponses()`, which also backs `scheduleResponses()`. All seven registrations use these helpers; no read route does, so the contract change is exactly co-extensive with the guard change.
3. Explanatory comments only, no other executable change.

`apps/api/test/app.test.ts` — +36 / −21. Three pre-existing cases that exercise these routes were re-wired to send the browser headers the guard now requires (`buildProtectedTransactionApp` for the correction case; a new `buildProtectedScheduleApp` helper for the two schedule cases). **Their intent and assertions are unchanged** — the same owner-scoping, preview-then-commit and strict-boundary assertions hold. A `PROTECTED` header set was added to the affected requests.

`apps/api/test/correction-schedule-write-defense.test.ts` — **new, 704 lines, 144 tests.**

`docs/implementation/MILESTONE-09-CORRECTION-SCHEDULE-WRITE-DEFENSE.md` — new.

## Route-by-route result

All eight URLs, from the new suite. Every row is an executed assertion, not an expectation.

| URL | 401 unauth | 6-case 403 matrix | 3 cross-site body shapes | fail-closed (no digest) | fail-closed (no verifier) | same-site w/o Origin | 200/201 happy path | `403` in OpenAPI | Idempotency-Key still required |
|---|---|---|---|---|---|---|---|---|---|
| `/transactions/{id}/correction-preview` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ 200 | ✓ | n/a |
| `/transactions/{id}/void-preview` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ 200 | ✓ | n/a |
| `/transactions/{id}/corrections` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ 201 | ✓ | ✓ |
| `/transactions/{id}/void` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ 200 | ✓ | ✓ |
| `/schedule/one-off` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ 201 | ✓ | ✓ |
| `/schedule/occurrences/{id}/confirm` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ 201 | ✓ | ✓ |
| `/schedule/occurrences/{id}/skip` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ 200 | ✓ | ✓ |
| `/schedule/occurrences/{id}/cancel` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ 200 | ✓ | ✓ |

The 403 matrix cases are: missing CSRF header; wrong CSRF token; foreign `Origin`; scheme-less lookalike `Origin` (`https://api.kfin.test.evil.example`); `sec-fetch-site: cross-site`; and neither `Origin` nor Fetch Metadata. The three cross-site body shapes are `application/x-www-form-urlencoded`, `text/plain` and malformed JSON, each sent from `https://evil.example` — all rejected `403` **before body parsing**, i.e. before the body parser could ever see them.

**Scoping proved, not assumed.** A dedicated block asserts the three relevant read routes still answer `200` on plain authentication with no CSRF header — `GET /api/v1/schedule/occurrences`, `GET /api/v1/schedule/occurrences/:id` and `GET /api/v1/transactions/:id/correction-history`. This demonstrates the change did not over-guard reads.

## Gates executed

| Gate | Command | Result |
|---|---|---|
| Typecheck (app **and** tests) | `corepack pnpm run typecheck` | clean, no output |
| Evidence harness check | `corepack pnpm run evidence:check` | 25 modules, 29 harness files checked |
| Evidence harness tests | `corepack pnpm run evidence:test` | **16 passed, 0 failed** |
| Unit + API tests | `corepack pnpm run test:unit` | **485 passed, 0 failed, 0 skipped** (22 files) |

Baseline before this milestone on the same parent commit was **341 passed** across 21 files. The delta is exactly the new 144-test file. The Milestone 07 regression block remains **22/22** and the Milestone 08 snapshot suite **18/18**, both untouched.

## Mutation checks

Each mutation was applied to `apps/api/src/app.ts`, the suite was run, and the mutation was reverted. All three were killed.

| # | Mutation | Result |
|---|---|---|
| A | Revert `POST /transactions/:id/corrections` to `preHandler: requireAuthentication` | **Killed** — 11 targeted failures (6-case matrix, 3 cross-site body shapes, 2 fail-closed) |
| B | Revert the shared `schedule/occurrences/:id/{skip,cancel}` registration to `preHandler: requireAuthentication` | **Killed** — 22 failures, covering both URLs |
| C | Remove `403: errorResponseSchema` from `correctionResponses()` | **Killed** — 8 failures, one per URL, from the OpenAPI contract assertions |
| D | Derive the owner on `correction-preview` from the `x-user-id` header instead of the principal (`(request.headers['x-user-id'] as string) ?? requireUserId(request)`) | **Killed** — the valid-request owner test fails |
| E | Relax `correctionPreviewBodySchema` from `z.strictObject` to `z.object`, so an injected owner passes validation to the handler | **Killed** — the malicious-owner test fails |

Mutation C matters specifically because it proves the published-contract half of the change is independently tested, not merely the runtime behaviour.

**Mutations D and E exist because of a QA finding against this record's own tests.** The original owner-derivation test injected `userId`/`ownerId` into the request body. Since every body contract here is a `z.strictObject`, that request was rejected `400` before the handler ran, so the test always took its `else` branch (`expect(spy).not.toHaveBeenCalled()`) and the `toHaveBeenCalledWith(USER_ID, …)` assertion was **unreachable dead code** — the test never proved owner derivation at all.

This was confirmed empirically rather than assumed: with mutation D applied, the **original** test passed **136/136**, i.e. it did not detect a live owner-injection regression in the implementation. After the split, the corrected test fails under mutation D and the schema test fails under mutation E. **No implementation defect was found** — only the test was at fault.

## Findings deliberately left open (not fixed here, out of confirmed scope)

- **The PostgreSQL integration suite was not executed locally.** No PostgreSQL instance was available in this sandbox and none could be provisioned (no package manager access). This is reported as a gap, not as a pass. The change is confined to `apps/api/src/app.ts` and its tests — no repository, migration, or SQL change — so no integration behaviour is expected to move, but **that expectation is not verified here** and CI's integration job is the first execution of it.
- **The auth routes' CSRF posture was not re-audited.** `apps/api/src/auth-routes.ts` applies `isBrowserSafeRequest` and a double-submit check inline per route rather than via `requireCsrfProtectedAuthentication`. That is pre-existing and outside E-4, which is scoped to the correction, void and schedule mutations. It was left untouched and should be independently reviewed.
- **No client-facing change.** No web/PWA client exists in this repository, so nothing consumes the CSRF cookie or sets `x-kfin-csrf` today. The guard is therefore verified at the API boundary only; end-to-end browser behaviour remains unverified until a client exists.
- No specification, SDD, ADR, roadmap, test-strategy, or governance document was created or modified. `docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md` does not track milestone evidence and was left untouched. No `SPEC-*` blocker is closed by this milestone.

## Erratum E-4 status

**Closed.** The seven registrations recorded as open by Milestone 08 now run the Milestone 04 defense at `onRequest`, publish `403`, and fail closed. The M07 erratum text itself is deliberately left unchanged for auditability; closure pointers were appended to `docs/evidence/2026-10-09-MILESTONE-07-VERIFICATION.md` and `docs/evidence/2026-10-10-MILESTONE-08-VERIFICATION.md`, and the pointer in `docs/implementation/MILESTONE-07-TRANSACTION-WRITE-DEFENSE.md` was extended.

## Not claimed

No owner approval, ADR acceptance, blocker closure, production readiness, Supabase result, or `FIN-RACE` PASS is implied. **No PostgreSQL integration result is claimed** — that suite did not run here. The phantom commit's figures do not exist and appear nowhere in this record as results.
