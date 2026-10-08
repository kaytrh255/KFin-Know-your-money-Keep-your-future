# Milestone 04 — Trusted Private Beta access

**Implementation date:** 2026-10-08<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Scope:** Invitation-gated registration, email verification, opaque sessions, credential recovery, and security history<br>
**Production readiness:** Not claimed

This milestone implements the Trusted Private Beta access vertical against the frozen SDD semantics. It does **not** modify any specification, ADR, test-strategy, or governance document, and it does not resolve `SPEC-AUTH-01`, `SPEC-AUTH-02`, `SPEC-SEC-01`, or `SPEC-SEC-02`. Every unapproved value used by the code is a labelled candidate recorded in one place.

## Scope boundary agreed for this milestone

Included: invitation issuance and atomic consumption, Argon2id registration, email-verification OTP challenges with resend supersession, one post-verification session branch, login, session rotation/expiry/replay containment, session list and revocation, known-password change, password reset, sanitized security history, layered abuse controls, and the cookie/CSRF/origin browser contract.

Excluded and deliberately not implemented: account-deletion request/cancel/purge state machine (`SPEC-DEL-01`, legal review), MFA enrollment/recovery (SEC-AUTH-12), profile-settings mutation (PRD-AUTH-09), notification/reminder delivery (ADR-008 `SPEC-REM-01`), an HTTP invitation-provisioning endpoint, and provider selection for email (OQ-17 / `RC-PROV-01`).

## Delivered behavior

- **Invitations.** High-entropy Crockford-base32 codes (160 bits) are generated server-side, returned once to the audited operator caller, and stored only as a purpose-separated keyed HMAC digest. `beta_invitations` is bound to an optional normalized email; consumption is `SELECT … FOR UPDATE` plus update in the same transaction as user creation, and a consumed/revoked invitation is terminal. There is no HTTP route that mints or lists invitations.
- **Registration.** Email is normalized (presentation form preserved, NFKC lowercase comparison form), the password is validated against the candidate policy (12–128 characters, built-in common/email-similar denylist, no silent truncation) and stored as Argon2id with a policy version. Registration returns one generic `accepted` outcome for a new account and for an existing email; a duplicate leaves the invitation unconsumed and records a blocked operator-only event.
- **Email verification.** One active challenge per user and purpose is enforced by a partial unique index; resend supersedes the previous challenge and a 60-second cooldown suppresses re-issuance. OTPs are six random digits stored only as a keyed digest, limited to five attempts and a 10-minute lifetime. Expiry, mismatch, and exhausted attempts are externally indistinguishable in kind but generic in content. On success the challenge is consumed, the account becomes `active`, and **one fresh rotated session is issued** — the `SPEC-AUTH-01` branch selected for this milestone. No pre-authenticated identifier exists, so nothing can be promoted.
- **Sessions.** Opaque 256-bit tokens are stored as digests in `session_tokens` with a generation counter, idle/absolute expiry, and a bounded prior-token grace window for concurrent tabs. A retired token used outside the grace window revokes the session family and records a user-visible replay event. `authenticate` re-checks revocation, both expiries, and current account status plus verified-email state on every call.
- **Browser transport.** The bearer token travels only in a host-prefixed `HttpOnly; Secure; SameSite=Lax; Path=/` cookie (`__Host-kfin_session`; the prefix and `Secure` are used when secure cookies are enabled). The CSRF token is a readable `Secure; SameSite=Strict` cookie echoed in `x-kfin-csrf`; its digest is bound to the session row. State-changing requests must additionally show an allowlisted/same `Origin` or `Sec-Fetch-Site: same-origin|none`. Authenticated responses keep `Cache-Control: no-store`.
- **Recovery.** Password reset issues a single-use 256-bit secret (digest-only, 30 minutes, attempt-limited), consumes it atomically, replaces the hash, and revokes **every** session; no session is issued until the next sign-in. A known-password change requires the current password, rejects reuse, revokes other sessions, and rotates the current token and CSRF value.
- **Security history.** Events are append-only, metadata is allowlisted and size-bounded, and a database `CHECK` rejects keys that could carry a secret. Each event carries a candidate `user | operator | both` visibility; the API exposes only `user`/`both` rows and only identifier, type, outcome, time, and session reference.
- **Abuse controls.** Fixed-window counters keyed by digest only (`login_target`, `login_ip`, `verification_target`, `verification_ip`, `reset_target`, `reset_ip`, `registration_ip`) are committed on their own connection, so a rolled-back operation can never erase abuse evidence. Unknown accounts perform the same Argon2id decoy work, and every denial is generic with safe `Retry-After` guidance.
- **Ownership.** No access route accepts a user identifier in a body, path, or query. Session list, revocation, history, and profile reads derive the owner from the authenticated session only.

## HTTP surface

| Method | Path | Contract |
|---|---|---|
| `POST` | `/api/v1/auth/register` | Generic `202 accepted`; creates a pending account and issues an OTP when permitted |
| `POST` | `/api/v1/auth/verification/resend` | Generic `accepted`; supersedes the active challenge after the cooldown |
| `POST` | `/api/v1/auth/verify-email` | Consumes the OTP, activates the account, issues a fresh rotated session and CSRF token |
| `POST` | `/api/v1/auth/login` | Issues a session and CSRF token; generic failure for unknown and known accounts |
| `POST` | `/api/v1/auth/logout` | Revokes the current session and clears both cookies |
| `POST` | `/api/v1/auth/logout-all` | Revokes every session atomically, keeping the current one available |
| `GET` | `/api/v1/auth/sessions` | Owner-scoped bounded list; marks the current session |
| `DELETE` | `/api/v1/auth/sessions/{id}` | Owner-scoped revocation of one other session |
| `POST` | `/api/v1/auth/password/change` | Verifies current password, revokes other sessions, rotates the current session |
| `POST` | `/api/v1/auth/password/reset-request` | Generic `accepted`; issues a single-use reset secret when eligible |
| `POST` | `/api/v1/auth/password/reset` | Consumes the reset secret, replaces the hash, revokes all sessions |
| `GET` | `/api/v1/auth/security-events` | Owner-scoped bounded user-visible history |
| `GET` | `/api/v1/auth/me` | Authenticated profile plus current session context |

Every access route uses strict request/response schemas, returns a stable error envelope with a correlation id, and never returns a token, OTP, reset secret, or password hash in a JSON body.

## Additive migration

`0004_trusted_private_beta_access.sql` adds `beta_invitations`, `password_credentials`, `auth_challenges`, `sessions`, `session_tokens`, `security_events`, and `auth_attempt_counters` plus the guards that make the invariants executable: terminal invitations, monotonic challenge attempts, immutable challenge purpose/secret, one active challenge per user and purpose, terminal session revocation, grace-only token retirement, append-only security events, secret-free event metadata, and bounded digest-only abuse counters. No earlier table, column, or constraint is modified.

## SDD traceability

| SDD requirement / invariant | Implementation | Automated verification |
|---|---|---|
| PRD-AUTH-01; SEC-AUTH-14/15; DATABASE §4.2 | `PostgresAuthRepository.register` locks and consumes the invitation in the user-creation transaction; email binding is restrictive only | PostgreSQL single-use, parallel-consumption, wrong-email, and duplicate-email tests |
| PRD-AUTH-02; SEC-AUTH-05/13 | `issueChallenge` in one transaction; OTP returned once for immediate ephemeral delivery | Contract, API-delivery, and PostgreSQL resend/supersession/attempt tests |
| PRD-AUTH-03; SEC-AUTH-04; SEC-ABUSE-01/02/08/09 | Decoy verification, generic envelopes, fixed-window digest counters recorded on their own connection *before* the operation transaction opens | PostgreSQL identical-failure, rate-limit, and single-connection-pool tests; fake-pool nested-checkout unit tests; API generic-envelope and `Retry-After` tests |
| PRD-AUTH-04/05; SEC-SES-01..06 | Opaque digest-only rotating tokens, idle/absolute expiry clamped to the absolute expiry, replay containment | PostgreSQL rotation-grace, replay, idle-expiry, renewal/rotation clamp, and logout tests; transport cookie tests |
| SEC-SES-07; SEC-APP-10/12 | `isBrowserSafeRequest` (same-origin only, no origin allowlist) plus session-bound CSRF digest | API cross-origin, previously-allowlisted-origin, missing-origin, and wrong-token tests; transport unit tests |
| SEC-SES-09 | Request hook sets `Cache-Control: no-store` for `/api/v1/*` | API session-cookie test |
| PRD-AUTH-06/07; SEC-AUTH-08/09 | `resetPassword` revokes all sessions; `changePassword` revokes others and rotates the current session | PostgreSQL reset and password-change tests |
| PRD-AUTH-08; SEC-SES-10 | Allowlisted metadata, append-only events, candidate visibility classification | Migration contract assertions; PostgreSQL user/operator visibility test |
| SEC-AUTH-01/02 | `@node-rs/argon2` Argon2id with unique salt and policy version; rehash on policy change | PostgreSQL credential-shape and reuse tests |
| SEC-AUTH-11 | `authenticate` re-checks status and verified email on every use | PostgreSQL disabled-account test |
| SEC-AUTH-16 | Verification mints a brand-new session; no pre-auth identifier exists | PostgreSQL verify-then-authenticate test |
| SEC-APP-01/07/09 | Strict contracts, bounded bodies, keyset pagination for both collections | Contract strictness tests and API pagination test |
| SEC-APP-15 ownership rule | Owner derived from the session principal on every route | API owner-scope test and PostgreSQL cross-owner revocation test |

## Code review fixes (2026-10-08)

Four findings from the automated review of the Milestone 04 PR were fixed without changing the agreed scope. Each carries a focused regression test; each test was confirmed to fail when the fix is reverted.

| # | Finding | Fix | Regression test |
|---|---|---|---|
| 1 (P1) | A renewed idle expiry could slide past the absolute expiry, on both last-seen renewal and token rotation | `clampIdleExpiry` in `@kfin/domain` clamps `now + idleLifetimeMs` to the absolute expiry; `authenticate` renewal and `rotateSessionRows` both use it | `packages/domain/test/auth.test.ts` (session lifetime clamping); `auth-access.integration.test.ts` "clamps a renewed idle expiry to the absolute expiry on use and on rotation" |
| 2 (P1) | Abuse counters were written on a second connection acquired *while* an operation transaction already held one, deadlocking the auth pool once every connection was in that state | Counters are recorded before `pool.connect()`; the operation transaction then uses a single connection | `packages/database/test/auth-abuse-counters.test.ts` (fake pool that refuses a nested checkout); `auth-access.integration.test.ts` "records abuse counters without a nested pool checkout on a single-connection pool" |
| 3 (P1) | `AUTH_COOKIE_SECURE=false` was accepted in production, putting the bearer token on the network in plaintext | `loadApiConfig` fails when `NODE_ENV=production` and the flag is not `true` | `packages/config/test/index.test.ts` production rejection, development allowance, production default |
| 4 (P2) | `AUTH_ALLOWED_ORIGINS` relaxed the CSRF origin check without a credentialed CORS layer, so no browser could legally complete such a request | The configuration is now explicitly unsupported: any non-empty value is rejected at startup, `isBrowserSafeRequest` is same-origin only, and `authAllowedOrigins` was removed from the config and transport | `packages/config/test/index.test.ts` rejection of configured origins; `session-transport.test.ts` and `auth-routes.test.ts` cross-origin regression cases |

Same-origin behaviour is preserved end to end: a request whose `Origin` equals `https://<Host>` or `http://<Host>`, or whose Fetch Metadata proves a same-site navigation, is still accepted. Implementing credentialed CORS remains out of scope: it needs a reviewed CORS layer, an explicit origin policy, and preflight handling, none of which Milestone 04 approved.

## Candidate values awaiting approval

All values below are **unapproved candidates** centralised in `authPolicy` (`packages/config`) and mirrored by the integration fixture. `SPEC-AUTH-02` requires named Security + Product approval with linked evidence for each one, and `SPEC-SEC-02` must approve the event visibility table.

- password: minimum 12, maximum 128 characters, Argon2id `m=19456, t=2, p=1`;
- invitation: 160-bit code, 14-day default lifetime;
- challenge: six-digit OTP, 10-minute lifetime, five attempts, 60-second resend cooldown, five hourly / twelve daily issuance cap;
- reset: 256-bit secret, 30-minute lifetime;
- session: 30-day idle, 90-day absolute, 30-second rotation grace, 60-second last-seen throttle;
- abuse: 15-minute fixed window with 10 login failures, 20 verification attempts, 10 reset requests, and 20 registrations per window;
- history: candidate `user | operator | both` classification per event type.

## Explicitly excluded semantics

- Account deletion, retention enforcement, and provider purge remain blocked by `SPEC-DEL-01` and Vietnamese legal/privacy review.
- MFA/TOTP/WebAuthn are not implemented; the schema keeps the extension point required by SEC-AUTH-12.
- Profile mutation (display name, locale, timezone, base currency) is not part of the access boundary and is not implemented.
- Email provider integration, deliverability, and residency remain Phase 6 work; only vendor-neutral non-production adapters exist.
- Reminder generation/delivery, safe-to-spend, and every financial feature remain outside this milestone.
- RLS/runtime-role decisions (`SPEC-SEC-01`) are unchanged: application-side owner scope remains mandatory.

## Verification record

The executed commands, per-case PostgreSQL results, and the CI run are recorded in [Milestone 04 — verification record](../evidence/2026-10-08-MILESTONE-04-VERIFICATION.md). The credential-free suites and the guarded real-PostgreSQL suite both pass; no approval, benchmark, browser, or provider evidence is claimed by that record.

## Evidence boundary and retained OPEN items

Credential-free suites verify contracts, pure domain rules, cookie/CSRF/origin behavior, route registration, owner scope, generic failures, and migration text. The guarded integration suite creates an isolated schema, applies the real migrations, and exercises the repository against PostgreSQL; absence of a database produces a reported skip rather than a fabricated PASS.

This milestone does **not** close: `SPEC-AUTH-01` (post-verification branch approval), `SPEC-AUTH-02` (every value above), `SPEC-SEC-01` (RLS), `SPEC-SEC-02` (event classification), `SPEC-DEL-01`, `RC-PROV-01`, ADR-002/004/008 acceptance, Argon2 benchmarking on production hardware, browser/PWA cookie and multi-tab validation, penetration/abuse testing, or any release gate. A passing implementation suite is not approved policy, not Supabase evidence, and not production readiness.
