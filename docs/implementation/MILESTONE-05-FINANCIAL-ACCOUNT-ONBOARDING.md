# Milestone 05 — Authenticated financial-account onboarding

**Implementation date:** 2026-10-09<br>
**Base:** `main` at `e111f674cb7d56dd31063cb8b67280cc381dfbb2` (Milestone 04 merged as PR #4)<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Scope:** HTTP onboarding of the aggregate financial account for an authenticated, verified user, plus owner-scoped account listing<br>
**Production readiness:** Not claimed

This milestone adds the onboarding and listing routes for the authenticated user's financial account. It does **not** modify any specification, SDD, ADR, test-strategy, or governance document. It does not change Milestone 04 authentication, sessions, or CSRF behavior. It adds no migration.

> This is a fresh implementation on top of current `main`. The earlier Milestone 05 commit `6c93de5b08c9d423a15e2e723820782f5239d6ec` could not be recovered and is not part of this history.

## Delivered behavior

- **`POST /api/v1/financial-account`** onboards the single aggregate liquid account for the authenticated principal. The account, the `onboarding` balance snapshot, the digest-only idempotency receipt, and the audit event are written in one `READ COMMITTED` transaction by the existing `FinancialAccountBootstrapService` (Milestone 01). Concurrent onboarding is serialized with `SELECT … FOR UPDATE` on the owner's `users` row.
  - **Replay.** A request with the same `Idempotency-Key` and the same payload returns the stored result with `201` and an `Idempotency-Replayed: true` header. The body is unchanged and no rows are written. The same key with a different payload returns `409 IDEMPOTENCY_KEY_REUSED`.
  - **Duplicate account.** A new key for an owner who already has an account returns `409 FIN_ACCOUNT_ALREADY_EXISTS`.
  - **Owner unavailable.** An owner that does not exist, is not `active`, or has no verified email returns `404 FINANCIAL_RESOURCE_UNAVAILABLE`.
  - **Invalid opening balance.** Any of the following returns `422 FIN_OPENING_BALANCE_INVALID`, and the check runs before any database checkout:
    - an opening balance that is not a canonical signed integer minor-unit string;
    - an amount outside the PostgreSQL `bigint` range;
    - an unparseable instant;
    - an instant in the future.
  - **Contract failures.** A JSON number, an unknown field, or a missing `Idempotency-Key` returns `400 REQUEST_VALIDATION_FAILED`.
  - **CSRF.** Before the body is validated, the route requires the Milestone 04 browser defense: a same-origin `Origin`, or `Sec-Fetch-Site: same-origin|none`, plus the session-bound double-submit token in `x-kfin-csrf`. A failure returns `403 AUTH_CSRF_FAILED`. The check fails closed when the principal has no CSRF digest or no verifier is configured.
- **`GET /api/v1/financial-accounts`** lists only the authenticated owner's accounts (at most 100). It returns name, type, currency, financial-state version, the latest snapshot, current-segment income and expense, and the current balance. Balances come from the authoritative `financial_current_balances` view, so each list item matches `GET /api/v1/financial-account`. An owner without an account receives `{ "items": [] }`.
- **Ownership.** The owner is always `request.principal.userId` from the authenticated session. The strict body contract rejects `ownerId`, `userId`, `accountId`, `currency`, and version fields. Query-string and header ownership hints are ignored.

## HTTP surface

| Method | Path | Success | Errors |
|---|---|---|---|
| `POST` | `/api/v1/financial-account` | `201 { accountId, snapshotId, financialStateVersion }`; `Idempotency-Replayed: true` on replay | `400`, `401`, `403 AUTH_CSRF_FAILED`, `404`, `409 FIN_ACCOUNT_ALREADY_EXISTS` / `IDEMPOTENCY_KEY_REUSED`, `422 FIN_OPENING_BALANCE_INVALID`, `503` |
| `GET` | `/api/v1/financial-accounts` | `200 { items: FinancialAccountSummary[] }` | `401` |

Request body: `{ "openingBalanceMinor": "<signed integer string>", "effectiveAt": "<ISO-8601 instant>" }`. `effectiveAt` is required so that the idempotency request digest stays deterministic across retries.

## Code changes

| Area | Change |
|---|---|
| `packages/contracts` | `openFinancialAccountBodySchema`, `openFinancialAccountResponseSchema`, `financialAccountSummarySchema`, `financialAccountListResponseSchema` |
| `packages/domain` | New error code `FIN_OPENING_BALANCE_INVALID` |
| `packages/database` | `PostgresFinancialRepository.openFinancialAccount` reuses `FinancialAccountBootstrapService`; `listFinancialAccounts` reads `financial_current_balances`; `parseOpeningBalance`; shared `mapBalance` |
| `apps/api` | Two routes; `requireCsrfProtectedAuthentication` at `preValidation`; `readCsrfHeader` helper in `session-transport.ts` (`auth-routes.ts` unchanged) |

No migration was required. `financial_accounts_user_uq`, the bootstrap idempotency operation, and the view already existed.

## Regression tests

| Concern | Tests |
|---|---|
| Authorization | `apps/api/test/financial-accounts.test.ts` — `401` on both routes; malformed principal id rejected |
| CSRF / origin | Same file — missing token, wrong token, foreign Origin, lookalike Origin, cross-site Fetch Metadata, no Origin and no Fetch Metadata, missing digest, no verifier; rejection happens before body validation |
| Principal-only ownership | Same file (body `ownerId`/`userId`/`accountId`/`currency`, query and header hints); `packages/contracts/test/financial.test.ts` |
| Validation (`422`) | `packages/database/test/financial-account-onboarding.test.ts` — 14 malformed or out-of-range or time cases, with no pool access; bigint boundaries accepted |
| Atomicity | `financial-accounts.integration.test.ts` — an injected failure on the last insert leaves 0 accounts, snapshots, receipts, and audits; the same key then succeeds |
| Idempotency | Integration — same-key replay; same-key different payload returns `IDEMPOTENCY_KEY_REUSED`; concurrent same-key retries produce one commit |
| Duplicate account | Integration — new key returns `409`; three concurrent different-key onboardings produce exactly one account and two `409`s |
| Owner unavailable | Integration — unknown and unverified owners return `404` with no writes |
| Owner isolation and balances | Integration — each owner lists only their own account; balances track posted transactions and equal the view and `getCurrentBalance` |

Each of the following deliberate mutations was confirmed to fail the suite:

- removing the CSRF guard fails 9 API tests;
- dropping the owner filter from the list query fails the isolation test;
- bypassing opening-balance validation fails 14 unit tests.

## Explicitly excluded

- Multiple accounts per user, account rename or close, and non-aggregate account types. The schema still enforces one `aggregate_liquid` account per user.
- Onboarding UX and the client.
- Clock-skew tolerance for `effectiveAt`. A client clock ahead of the server is rejected, consistent with the existing manual-snapshot rule.
- RLS/runtime-role decisions (`SPEC-SEC-01`). Application-side owner scope remains mandatory.

## Verification record

See [Milestone 05 — verification record](../evidence/2026-10-09-MILESTONE-05-VERIFICATION.md).
