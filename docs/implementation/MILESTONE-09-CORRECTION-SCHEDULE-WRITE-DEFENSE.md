# Milestone 09 — Correction, void and schedule write defense (E-4 closure)

**Implementation date:** 2026-10-10<br>
**Base:** `main` at `32a70e018e485666a9a37e2b2f5bc60a71edeb06` (Milestone 08 merged as PR #8)<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2` (unchanged)<br>
**Scope:** Close erratum **E-4** — apply the Milestone 04 browser state-change defense to the correction, void and schedule mutations<br>
**Production readiness:** Not claimed

> **Provenance warning — read first.** This work was requested as the delivery of an existing commit `3f2ad5e9467cc0caf99581b9c3aa530f39882bac` on a branch `feature/csrf-guard-remaining-mutations`. Neither exists. `git cat-file -t 3f2ad5e…` is fatal locally, `git fetch origin 3f2ad5e…` returns `upload-pack: not our ref`, the GitHub API answers `HTTP 422 "No commit found for SHA"`, and a full sweep of all 43 reachable commits across every local and remote branch plus every `refs/pull/*/head` contains no object with that prefix. The branch name does not appear in `git ls-remote` or in the branch list API. No stash, no reflog entry beyond the clone, no dangling object, and no patch file exists. **No result from that phantom commit is reused, restated, or relied on anywhere in this record.** Milestone 09 was implemented from scratch against `main`, and every result below was produced by the commands shown, on this branch, on 2026-10-10. This is the second confirmed occurrence of this failure mode; Milestone 08 was re-implemented under the identical condition (phantom commit `c97bc89`).

## Why this milestone exists

The Milestone 07 verification record claimed that `POST /api/v1/transactions` was *"the only authenticated mutation still running plain `requireAuthentication`"*. That claim was false at the Milestone 07 commit itself. Milestone 08 raised it as erratum **E-4** and proved it by auditing `8765e6a`: **eight other mutation routes** ran plain `requireAuthentication` in that commit.

Milestone 08 closed one of them (`POST /api/v1/financial-account/snapshots`) and explicitly recorded that the remaining seven stayed open, *"so QA does not read the M07 wording as evidence that they are protected."* This milestone closes all seven — eight URLs, because `skip` and `cancel` are registered by one shared handler.

## Routes changed

Every route below moved from `preHandler: requireAuthentication` to `onRequest: requireCsrfProtectedAuthentication`. All seven registrations are in `apps/api/src/app.ts`.

| # | Route | Why it is a write surface |
|---|---|---|
| 1 | `POST /api/v1/transactions/:id/correction-preview` | Mints the authoritative signed review context that route 3 later accepts. |
| 2 | `POST /api/v1/transactions/:id/void-preview` | Mints the authoritative signed review context that route 4 later accepts. |
| 3 | `POST /api/v1/transactions/:id/corrections` | Appends an immutable correcting entry and moves the authoritative current balance. |
| 4 | `POST /api/v1/transactions/:id/void` | Withdraws a posted amount from the authoritative current balance. |
| 5 | `POST /api/v1/schedule/one-off` | Creates a scheduled item owned by the victim account. |
| 6 | `POST /api/v1/schedule/occurrences/:id/confirm` | Posts a real transaction against the authoritative balance. |
| 7 | `POST /api/v1/schedule/occurrences/:id/skip` | Advances the occurrence state machine under an optimistic version. |
| 8 | `POST /api/v1/schedule/occurrences/:id/cancel` | Same registration as #7; `skip` and `cancel` share one handler. |

**Response contract.** `403` was added to the shared `correctionResponses()` helper, which also backs `scheduleResponses()`. All seven registrations use these helpers and no read route does, so the contract change is exactly co-extensive with the guard change. The change makes `403` part of the published OpenAPI contract for all eight URLs.

**What did not change.** No read route was touched: `GET /api/v1/transactions`, `GET /api/v1/transactions/:id`, `GET /api/v1/transactions/:id/correction-history`, `GET /api/v1/schedule/occurrences`, `GET /api/v1/schedule/occurrences/:id`, `GET /api/v1/reports/monthly-actuals` and the savings read routes all still run plain `requireAuthentication`. Guard placement is deliberate: `onRequest`, i.e. **before** content-type parsing, so a cross-site HTML form or malformed-JSON body is rejected with `403` without ever reaching the body parser — the same convention Milestones 05–08 apply.

No migration, no persisted-schema change, no dependency or lockfile change. `packages/database/migrations/`, `package.json` and `pnpm-lock.yaml` are byte-identical to `main`.

## Behaviour after the change

An unauthenticated request answers `401 AUTHENTICATION_REQUIRED`. An authenticated browser request answers `403 AUTH_CSRF_FAILED` when any of the following holds, in every case **before the service is called**:

- the `x-kfin-csrf` header is missing;
- the presented token does not verify against the session-bound digest;
- `Origin` is foreign, or a scheme-less lookalike of the host;
- Fetch Metadata says `sec-fetch-site: cross-site`;
- neither `Origin` nor Fetch Metadata is present.

The guard **fails closed**: when the principal carries no session-bound `csrfDigest`, or when no auth service (verifier) is configured, the answer is `403`, not a pass-through. A same-site request that satisfies Fetch Metadata but sends no `Origin` header is accepted.

## Explicit non-goals

- **No behaviour change beyond the guard and its published contract.** Request/response bodies, idempotency semantics, optimistic-version conflicts, owner scoping and error envelopes are unchanged. The three pre-existing `app.test.ts` cases that exercise these routes were re-wired for the new guard; their intent and assertions are unchanged.
- **Auth routes are out of scope.** `apps/api/src/auth-routes.ts` applies its own `isBrowserSafeRequest` plus double-submit check inline per route and was not modified.
- **No change to the snapshot, transaction, savings or reporting routes.**
- No specification, SDD, ADR, roadmap, test-strategy, or governance document was created or modified by the code change. This document and the matching verification record are the only additions, plus closure pointers appended to the M07 and M08 evidence records.

## Quality gates (all executed, none claimed)

- TypeScript typecheck (`pnpm run typecheck`): clean, application **and** tests.
- Evidence harness (`pnpm run evidence:check` and `pnpm run evidence:test`): 25 modules / 29 harness files checked; 16/16 passing.
- Unit and API tests (`pnpm run test:unit`): **485 passed, 0 skipped, 0 failed** across 22 files. Baseline before this milestone was 341 passed; the delta is the new 144-test `apps/api/test/correction-schedule-write-defense.test.ts`. The Milestone 07 regression block is untouched at 22/22.
- Mutation checks A/B/C/D/E were all killed (see the verification record).

> **QA correction (2026-10-10).** Independent QA found the owner-derivation test unsound: it injected `userId`/`ownerId` into the request body, and because every body contract in this set is a `z.strictObject`, the request was rejected `400` before the handler ran. The assertion that the owner came from the principal therefore sat behind an unreachable branch and **never executed**. The test was split in two — one that sends a **valid** body and asserts the owner argument the service actually receives is the principal's, and one that sends the **malicious** body and pins the strict-schema `400`. Mutation D proves the correction: with a header-derived owner injected into the implementation, the original test passed **136/136** while the corrected test fails. No implementation defect was found — the fault was in the test only.

The full acceptance-criteria traceability table, commands, and outputs are in `docs/evidence/2026-10-10-MILESTONE-09-VERIFICATION.md`.
