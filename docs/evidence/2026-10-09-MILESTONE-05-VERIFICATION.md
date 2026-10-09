# Milestone 05 — Financial-account onboarding — verification record

**Recorded:** 2026-10-09<br>
**Base:** `e111f674cb7d56dd31063cb8b67280cc381dfbb2`<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Purpose:** This record covers only evidence that was actually executed. It does not approve a value, close a blocker, accept an ADR, or claim production readiness.

## Environment

- Node.js `22.22.3`, pnpm `10.34.6` via Corepack, frozen lockfile.
- PostgreSQL `17.6`: a disposable local instance started from the `@embedded-postgres/linux-x64` binaries, outside the repository, used only for this run. Every suite creates and drops its own isolated schema.
- The `evidence:test` frozen-document checks need commit `a48d2c5…` in the object store. The first run was on a shallow clone and three of its tests failed. The failure was identical on unmodified `main`. After `git fetch --unshallow`, all 16 tests passed. CI already checks out with `fetch-depth: 0`.

## Commands actually executed

```text
corepack pnpm install --frozen-lockfile
corepack pnpm run evidence:check
corepack pnpm run evidence:test
corepack pnpm run typecheck
corepack pnpm run test:unit
KFIN_INTEGRATION_TARGET=non-production TEST_DATABASE_URL='postgresql://…' corepack pnpm run test:integration
KFIN_INTEGRATION_TARGET=non-production TEST_DATABASE_URL='postgresql://…' corepack pnpm run test
corepack pnpm run test        # without a database: integration suites report skipped
```

## Observed results

- `evidence:check`: 25 JavaScript modules and 29 harness files checked.
- `evidence:test`: 16 tests, 16 passed.
- `typecheck`: no diagnostics.
- `test:unit`: 17 files, **209 passed**. This includes 53 new tests:
  - 32 API route tests;
  - 19 opening-balance validation tests;
  - 2 contract tests.
- `test:integration` on real PostgreSQL: 5 files, **45 passed**. This is the 10 new onboarding/listing cases plus the 35 existing access, foundation, correction, and schedule cases.
- Full `vitest run` with the database configured: **254 passed**. Without a database: 209 passed and 45 skipped, with none reported as passed.

## Live HTTP smoke on real auth and real PostgreSQL

A temporary harness, not committed, ran `buildApp` with the real `PostgresAuthRepository` and `PostgresFinancialRepository` on a migrated disposable schema, using the recording email adapter. Two users registered with real invitations and verified with the issued OTP. Each received a real session cookie and CSRF token. Observed results:

| Request | Status |
|---|---|
| `POST /financial-account` without cookie | `401 AUTHENTICATION_REQUIRED` |
| missing `x-kfin-csrf` | `403 AUTH_CSRF_FAILED` |
| another user's CSRF token | `403 AUTH_CSRF_FAILED` |
| foreign `Origin` with valid token | `403 AUTH_CSRF_FAILED` |
| body with `ownerId` | `400 REQUEST_VALIDATION_FAILED` |
| `openingBalanceMinor: "12.5"` | `422 FIN_OPENING_BALANCE_INVALID` |
| future `effectiveAt` | `422 FIN_OPENING_BALANCE_INVALID` |
| valid request | `201` |
| same key and body | `201`, `Idempotency-Replayed: true` |
| same key, different body | `409 IDEMPOTENCY_KEY_REUSED` |
| new key | `409 FIN_ACCOUNT_ALREADY_EXISTS` |
| second user onboarding (`-5000`) | `201` |
| `GET /financial-accounts` (user A) | `200`, 1 item, balance `1000000` |
| `GET /financial-accounts?ownerId=<A>` as user B | `200`, 1 item, B's own account, balance `-5000` |
| `GET /financial-accounts` without cookie | `401` |

The `404` owner-unavailable path cannot be reached through real sessions, because unverified or disabled accounts cannot authenticate. It is covered at the repository level against PostgreSQL.

The smoke schema and harness were removed afterwards.

## Not claimed

No browser/PWA validation, Supabase or production database, load or concurrency benchmark, penetration test, or approval of any open item (`SPEC-AUTH-*`, `SPEC-SEC-*`, ADR acceptance, release gates).
