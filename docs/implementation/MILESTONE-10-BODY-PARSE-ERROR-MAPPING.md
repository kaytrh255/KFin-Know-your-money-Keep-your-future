# Milestone 10 addendum — E-6, mapping unreadable request bodies to their client status

**Implemented:** 2026-10-12<br>
**Base:** Milestone 10, `de91113f8991d5f2023e064dfb92fc113866b102` on `arena/bfaf5019-kfin-know-your-money-keep-your` (`main` at `28ee85f2c0137a97d52133bff471526d8b661926`)<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2` (unchanged)<br>
**Scope:** Close erratum **E-6** — the generic error handler answered `500` for bodies its own parsers had already rejected with the correct `4xx`<br>
**Production readiness:** Not claimed

## Why this addendum exists

Milestone 10's verification record listed, under *"Findings deliberately left open"*:

> **Malformed JSON from a same-site caller still answers `500`.** Measured identically before and after this milestone: `POST /api/v1/auth/login` with `Content-Type: application/json` and body `{"email":` from a same-origin caller answers `500`, while every route's published contract declares `400`. … This is a **pre-existing** defect, it is not specific to the access surface, it is not a CSRF issue, and fixing it belongs in the shared error handler rather than in this five-file change set.

It was not new. The Milestone 05 QA fix had already recorded the same thing five milestones earlier, in the same words:

> **Pre-existing and out of scope:** the generic error handler still maps Fastify content-type and JSON-parse errors to `500` on every route, including Milestone 01–04 routes on `main`.

This addendum closes it, in the shared error handler, which is where both records said the fix belonged.

## Cause

Fastify's content-type parsers reject a request **before any route handler or schema validation runs**, and the error they raise already carries the status the client should receive. The application's `setErrorHandler` inspected exactly two things — `error instanceof KfinServiceError`, and `'validation' in error && error.validation` — and sent everything else to its catch-all `500 INTERNAL_ERROR`. Body-layer errors are neither, so they were all reported as server faults.

Measured on `de91113` with the fix temporarily reverted, every same-origin case below answered `500 INTERNAL_ERROR`:

| Framework code | Correct status | Framework meaning |
|---|---|---|
| `FST_ERR_CTP_INVALID_JSON_BODY` | `400` | Body is not valid JSON for an `application/json` content type — also raised for payloads `secure-json-parse` refuses, such as a `__proto__` key (SEC-APP-11) |
| `FST_ERR_CTP_EMPTY_JSON_BODY` | `400` | Empty body with a JSON content type |
| `FST_ERR_CTP_INVALID_MEDIA_TYPE` | `415` | A content type with no registered parser |
| `FST_ERR_CTP_BODY_TOO_LARGE` | `413` | Body over the configured `bodyLimit` (64 KiB) |

## The change

`apps/api/src/app.ts` — **+47 / −0**, no behaviour removed:

1. **One branch in the shared error handler**, placed after the existing validation branch and before the catch-all `500`. It answers `error.statusCode` with the stable code `REQUEST_BODY_UNREADABLE`, the fixed safe message `The request body could not be read.`, and the request correlation ID.
2. **The framework message is deliberately not echoed.** The response never contains `FST_ERR_*`, the parser's wording, or the content type. Only the bounded framework code and the correlation ID reach the server log, at `warn`.
3. **A narrow predicate**, `isBodyLayerClientError`, that accepts an error only when its code starts with `FST_ERR_CTP_` **and** the framework supplied a status in `[400, 500)`. It can therefore never capture a `5xx`, an application error, or `FST_ERR_VALIDATION`.

**What did not change.** No route, guard, schema, service, migration, dependency or lockfile was touched. `403`/`401` precedence is untouched: the browser defense and authentication guards still run at `onRequest`, before the parser, so a cross-site request is still `403 AUTH_CSRF_FAILED` and an unauthenticated one still `401 AUTHENTICATION_REQUIRED` regardless of what the body looks like. A body that parses but does not match the contract is still `400 REQUEST_VALIDATION_FAILED`, because `FST_ERR_VALIDATION` is not a content-type-parser error. Nothing was added to or removed from any OpenAPI contract — `400` was already published by every route, and this change makes the API honour it.

## Measured before and after

Every row is an executed request against the real route table. "Before" was measured on this branch with the new branch reverted and nothing else changed; "after" with it applied. The four unchanged rows are the precedence evidence.

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

## Quality gates (all executed, none claimed)

- TypeScript typecheck (`pnpm run typecheck`): clean, application **and** tests.
- Evidence harness (`pnpm run evidence:check`, `pnpm run evidence:test`): 25 modules / 29 harness files checked; **16/16 passing** with the frozen commit reachable.
- Credential-free unit and API suite (`pnpm run test:unit`): **626 passed, 0 failed, 0 skipped** across 24 files. Baseline at `de91113` was **573 passed** across 23 files; the delta is exactly the new 53-test file.
- Real-PostgreSQL integration suite (`pnpm run test:integration`): **64 passed** across 7 files on PostgreSQL 17.6.

## Files

| File | Change |
|---|---|
| `apps/api/src/app.ts` | +47 / −0 |
| `apps/api/test/request-body-error-mapping.test.ts` | new, 509 lines, 53 tests |
| `docs/implementation/MILESTONE-10-BODY-PARSE-ERROR-MAPPING.md` | new |
| `docs/evidence/2026-10-12-MILESTONE-10-VERIFICATION.md` | E-6 addendum, finding closed, gates re-run |
| `docs/implementation/MILESTONE-05-FINANCIAL-ACCOUNT-ONBOARDING.md` | closure pointer appended to the note that first recorded the defect |
| `docs/implementation/MILESTONE-10-AUTH-WRITE-DEFENSE.md` | closure pointer appended to the open finding that re-raised it |

Six files. Only the first two are code; no document was edited to change a specification, and no test was skipped or weakened — the one test change made in this addendum was a **correction of a wrong assumption in this addendum's own new suite** (bodies on a route with no body contract), recorded above rather than hidden.
