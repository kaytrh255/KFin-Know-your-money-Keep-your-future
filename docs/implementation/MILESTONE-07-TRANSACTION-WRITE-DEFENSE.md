# Milestone 07 — One-time transaction write defense

**Implementation date:** 2026-10-09<br>
**Base:** `main` at `94e2d0b3b83342678b0ca9e33145e252756d49f4` (Milestone 06 merged as PR #6)<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Scope:** Verification and defense hardening of the manual one-time transaction write path (`POST /api/v1/transactions`)<br>
**Production readiness:** Not claimed

> **Erratum added by Milestone 08 (2026-10-10):** the "Explicit non-goals" section below misnames the snapshot route as `POST /api/v1/snapshots`, misattributes it to Milestone 05 (it shipped in Milestone 01), and the introduction's claim that `POST /api/v1/transactions` was the *only* mutation left on plain `requireAuthentication` is false — eight others were. Corrections and proof are in `docs/evidence/2026-10-09-MILESTONE-07-VERIFICATION.md` § Erratum (E-1…E-4). The original text is kept unchanged for auditability.

Milestone 01 shipped the transaction domain, repository method, and the `POST /api/v1/transactions` route; Milestone 02 added corrections and re-verified the create path end-to-end. When Milestone 04 introduced the browser-write defense (same-origin check plus double-submit CSRF at `onRequest`, before body parsing) and Milestones 05–06 applied it to every new mutation, `POST /api/v1/transactions` was left as the only authenticated mutation still running plain `requireAuthentication` at `preHandler`. This milestone closes that gap and surfaces the idempotency replay marker that the persistence layer already computed. It does **not** modify any specification, SDD, ADR, test-strategy, or governance document. It adds no migration and changes no persisted schema.

## What changed

1. **Browser defense on the transaction write.** The route now runs `onRequest: requireCsrfProtectedAuthentication`. An unauthenticated request answers `401`; a browser request without a matching origin and `x-kfin-csrf` token answers `403` before the body is parsed — including a cross-site `text/plain` HTML form, which is rejected without ever reaching the body parser. The guard fails closed when the session carries no CSRF digest or the auth service lacks a verifier. A `403` entry was added to the route's response contract.
2. **Idempotency replay marker.** `CreateTransactionResult` now carries `readonly replayed: boolean`, which the serializer had already been computing on the command envelope. A same-key replay returns `replayed: true` and the route answers it with the header `Idempotency-Replayed: true`. The response body is unchanged — the strict `createTransactionResponseSchema` (`{ transactionId, financialStateVersion }`) would reject any extra field with a 500 — so the handler now sends those two fields explicitly. Receipts stored in `idempotency_results` still contain only identifiers and versions, never amounts, and do not store the marker.

Both changes conform to the conventions established in Milestones 04–06; the M06 QA addendum records "mutation route uses `requireAuthentication` instead of the CSRF guard" as a critical, test-killed mutation. This milestone applies that accepted convention to the one route that predated it.

## What was verified, not re-implemented

- Mass assignment is dead code: the strict body schema strips `userId`/`ownerId`; the handler reads the owner only from `request.principal.userId`, and an injected `userId` never reaches the repository (regression-tested).
- Deterministic failures for malformed bodies, invalid amounts, unknown classifications, future dates, and cross-user reads (the full matrix already existed in M01/M02 suites and still passes).
- Balance reconciliation with the snapshot model and historical-only backfill behavior are covered by the M01/M02 integration suites, re-run here on real PostgreSQL 16.2 with all 59 checks green.

## Explicit non-goals

- `POST /api/v1/snapshots` [sic — actually `POST /api/v1/financial-account/snapshots`, and a Milestone 01 route; see Erratum E-1/E-3] still runs plain `requireAuthentication`. That route is the frozen Milestone 05 onboarding contract; this milestone's integration constraint was to harden the transaction path **without** changing the M05 snapshot surface. The gap is recorded as a deferred observation in the verification evidence.
- Corrections, voids, and previews (Milestone 02) and schedule occurrences (Milestone 03) are untouched.
- Recurring definitions, schedule generation, debt payments, and planned-purchase linking remain out of scope behind their open SPEC blockers.

## Quality gates (all executed, none claimed)

- TypeScript typecheck: clean.
- Unit/evidence gate (`pnpm run check`): 19 passed, 6 skipped test files; 286 passed, 59 skipped tests.
- Integration on real PostgreSQL 16.2 (`test:integration`): 59/59, including a strengthened replay assertion that proved on a live database that the same-key replay returns the original identifiers with `replayed: true` while the stored receipt is unchanged.
- Fresh-schema migration ledger: `0001`–`0006` applied cleanly to a new database; all six checksums recorded; M07 adds no migration.
- Mutation check: removing the guard/wiring change from `apps/api/src/app.ts` produced exactly 11 targeted failures (defense matrix, fail-closed cases, replay assertions, and the strict-contract happy path); the change was restored and the suite is green again.

The full acceptance-criteria traceability table, commands, and outputs are in `docs/evidence/2026-10-09-MILESTONE-07-VERIFICATION.md`.
