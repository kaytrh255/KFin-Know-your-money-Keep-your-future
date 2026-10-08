# Milestone 04 — Trusted Private Beta access — verification record

**Recorded:** 2026-10-08<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Implementation head:** `c0f52c9e544275352d36c477eb00ec809e655aad`<br>
**Purpose:** Record only evidence that was actually executed. This record does not approve a value, close a blocker, accept an ADR, or claim production readiness.

## Commands actually executed

```text
corepack pnpm install --frozen-lockfile
corepack pnpm run evidence:check
corepack pnpm run evidence:test
corepack pnpm run typecheck
corepack pnpm run test:unit
KFIN_INTEGRATION_TARGET=non-production \
TEST_DATABASE_URL='postgresql://…' \
corepack pnpm run test:integration
corepack pnpm run test
MIGRATION_DATABASE_URL='postgresql://…' corepack pnpm run db:migrate
NODE_ENV=development … corepack pnpm --filter @kfin/api start   # live HTTP smoke
```

Observed results on the implementation head:

- frozen install resolved `114` root packages plus the added `@node-rs/argon2` runtime dependency;
- the standalone FIN-02 harness static check completed (`25` JavaScript modules and `29` harness files checked);
- the FIN-02 harness unit/static suite executed `16` tests: `16` passed, `0` failed;
- `tsc -b` and the separate tests project typecheck completed with no diagnostic;
- credential-free suites: `12` contract, `13` domain, `10` transport, `15` API route, `6` migration-contract (total suite) and `7` configuration cases passed;
- real-PostgreSQL integration suites: `15` new Trusted Private Beta access cases plus the `15` pre-existing foundation/correction/schedule cases passed — `30` total;
- full `vitest run` with the database configured: **173 tests, 173 passed**.

A live end-to-end smoke test ran the wired server (`apps/api/src/server.ts`) against a migrated disposable database with secure cookies disabled for local HTTP. Observed status codes: `/health/live` and `/health/ready` `200`; `/api/v1/auth/me` and `/api/v1/financial-account` without a cookie `401`; with the session cookie `/api/v1/auth/me`, `/api/v1/auth/sessions`, and `/api/v1/auth/security-events` `200` (user-visible history only) and `/api/v1/financial-account` `404` from the financial service for an account that does not exist yet; `POST /api/v1/auth/logout` `403` without a CSRF token, `403` with a wrong token, `403` from a foreign origin, and `200` with the bound token and same origin, after which the same cookie returned `401`; `POST /api/v1/auth/register` with an unissued code `400`; `POST /api/v1/auth/login` for an unknown account `401`; `POST /api/v1/auth/password/reset-request` `200` with a generic accepted body. The smoke database and scratch files were dropped afterwards and are not part of the change set.

The evidence-harness commands initially failed `3` of `16` cases in this sandbox because the working clone did not contain the frozen baseline commit (`git show a48d2c56…:docs/architecture/SPEC-FIN-02-SNAPSHOT-CONCURRENCY.md` failed with "exists on disk, but not in …"). After fetching that baseline commit the same commands passed `16/16`. The failure was a clone artifact of the sandbox, not a code defect, and no PASS was claimed for it.

## Credential-free coverage

| Area | Cases | What it proves |
|---|---|---|
| Access contracts (`packages/contracts/test/auth.test.ts`) | `12` | Strict bodies/responses, invitation-code shape, six-digit OTP, high-entropy reset secret, no `sessionToken`/`password` field, generic registration shape, user-visible event shape, CSRF header openness |
| Access domain (`packages/domain/test/auth.test.ts`) | `13` | Email normalization, password policy bounds and denylist, entropy minimums, code normalization, event visibility, fixed-window bucketing, bounded device summary, constant-time comparison |
| Session transport (`apps/api/test/session-transport.test.ts`) | `10` | `__Host-` prefix only when secure, `HttpOnly`/`Secure`/`Path=/`/`SameSite` flags, CSRF cookie readable but `Secure; Strict`, cookie clearing, same-origin and Fetch-Metadata decisions |
| Access routes (`apps/api/test/auth-routes.test.ts`) | `15` | Route registration, one-time OTP delivery and delivery-failure recording, host cookie + CSRF cookie on issue, cross-origin/missing-origin/wrong-token rejection, allowlisted origin, fail-closed principal, owner scope from the session, bounded pagination, cookie clearing on logout/reset, rotation on password change, identical generic envelopes for known/unknown failures, `Retry-After`, unknown-field and oversized-body rejection |
| Migration text (`packages/database/test/migration-contract.test.ts`) | `6` new | Digest-only columns, Argon2id-only hash, invitation terminality, one active challenge, monotonic attempts, revocation/rotation/grace, append-only history without secret metadata, bounded counters |
| Configuration (`packages/config/test/index.test.ts`) | `7` | No default auth secret, exact allowlisted origins, pinned candidate access bounds, 128-bit minimum entropy |

## Real-PostgreSQL coverage

Executed against a disposable, explicitly designated non-production PostgreSQL instance in an isolated schema with the reviewed migrations applied.

| Case | Observed result |
|---|---|
| Register → verify → authenticate | Pending account created, OTP shape confirmed, verification activates the account, session resolves to the owner, CSRF digest verifies only the issued token |
| Invitation single-use and parallel consumption | Second registration rejected with `AUTH_INVITATION_INVALID`; two concurrent registrations produce exactly one winner, invitation row terminal and bound |
| Invitation email binding | Wrong-email registration rejected; an unissued code rejected — no email-allowlist admission path |
| Digest-only storage | Invitation, challenge secret, and challenge target digests equal the purpose-separated HMACs, differ for a different OTP, are not plain text, and the credential record is an `$argon2id$` string without the password |
| Used / expired / exhausted codes | Replay rejected, expiry after the injected clock passes rejected, and the sixth wrong attempt returns `AUTH_CHALLENGE_ATTEMPTS_EXHAUSTED` |
| Resend supersession | Cooldown issues nothing; after the cooldown the new code verifies and the superseded one does not |
| Login failure equivalence and abuse | Known and unknown accounts return byte-identical `AUTH_INVALID_CREDENTIALS`; repeated attempts from a fresh source return `AUTH_RATE_LIMITED` with `Retry-After` |
| Idle expiry, rotation grace, replay, logout | Idle expiry revokes with reason `expired`; retired token works inside the grace window and, after it, nulls the principal and revokes with reason `token_replay`; the replay event appears in user-visible history; logout revokes and invalidates |
| Password reset | Reset revokes every session including the verification session, the secret cannot be reused, and the new password signs in |
| Generic reset request | Unknown and pending-verification accounts receive the identical `{ accepted: true, issued: false, delivery: null }` response |
| Owner isolation and event visibility | Session list and revocation are owner-scoped; a cross-owner revoke returns `false`; operator-only challenge events never appear in user-visible history |
| Account status re-check | Disabling the user immediately nulls the principal and login returns `AUTH_ACCOUNT_UNAVAILABLE` |
| Password policy and reuse | Short password rejected before any invitation consumption; reuse and wrong current password rejected |
| Duplicate registration | Generic `accepted` outcome, invitation left `active`, exactly one user row for the normalized email |
| Abuse-counter pruning | Active window retained; windows beyond the retention bound removed |

## GitHub Actions execution history

| Run | Head | Observed result | Disposition |
|---|---|---|---|
| [`37801117962`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37801117962) | `c0f52c9e544275352d36c477eb00ec809e655aad` | **SUCCESS**; all `10` job steps passed, including frozen install, evidence-harness validation, typecheck, credential-free tests, and the isolated real-PostgreSQL integration stage | Synthetic implementation evidence for this milestone and regression coverage for Milestones 01–03 |
| [`37801626110`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37801626110) | `38ef5e3c3a081e1355409c6eaa297742f98de6df` | **SUCCESS**; documentation-only head, same `10` steps passed | Confirms the verification record commit did not change behaviour |

The CI integration stage provisions ephemeral PostgreSQL `17.6`. The sandbox verification instance was PostgreSQL `16.2`; no PostgreSQL-version-specific behaviour is relied upon by this milestone.

## Current evidence status

| Area | Status |
|---|---|
| Credential-free implementation checks | **PASS — executed locally and in CI** |
| Real PostgreSQL access integration (`15` cases) | **PASS in CI run `37801117962`; also PASS locally on a disposable PostgreSQL instance** |
| Argon2id parameter benchmarking on production hardware | **OPEN — not executed** |
| Browser/PWA cookie, installed-mode, and multi-tab behaviour | **OPEN — not executed** |
| `AUTH-VRF-01..06` / `AUTH-POL-01..12` / `SEC-HIST-01..08` | **NOT RUN — OPEN**; the corresponding approvals do not exist |
| Email provider behaviour, deliverability, and residency | **OPEN — Phase 6 (OQ-17 / `RC-PROV-01`)** |

## Open items retained

- `SPEC-AUTH-01`: the post-verification branch implemented here (one fresh rotated session) is a candidate and is not approved.
- `SPEC-AUTH-02`: every invitation, password, OTP, reset, login-abuse, lifetime, rotation/replay, and known-password-change value above is a candidate awaiting named Security + Product approval and evidence.
- `SPEC-SEC-01` (RLS/runtime role), `SPEC-SEC-02` (event classification table), `SPEC-DEL-01` (deletion/retention), `RC-PROV-01` (email provider), and ADR-002/004/008 acceptance remain **OPEN**.
- Account-deletion, MFA, profile mutation, reminders, and all financial features remain unimplemented by design.
- Governance, security, legal, operational, accessibility, and release gates remain **OPEN**; a passing implementation suite is not production or Supabase evidence.
