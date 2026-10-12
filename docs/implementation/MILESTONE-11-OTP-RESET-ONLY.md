# Milestone 11 — the emailed OTP is reserved for password reset (OQ-20)

**Date:** 2026-10-12
**Depends on:** the OQ-20 specification revision
[`docs/evidence/2026-10-12-AUTH-POLICY-SPECIFICATION-REVISION.md`](../evidence/2026-10-12-AUTH-POLICY-SPECIFICATION-REVISION.md)
(commit `9456067`, clarified by `ac715dc`), which revised the authentication specification and left
the implementation gap recorded in its §5.
**Status:** implemented, tested, and committed on the `arena/bfaf5019-…` branch. **Not merged and not
deployed.** `SPEC-AUTH-01` and `SPEC-AUTH-02` remain open owner decisions (§7) and nothing here
closes them.

This record closes §5 of the revision record: the specification and the code now agree.

## 1. What the specification required, and what the code now does

| Specification requirement (revision §5) | Implementation |
|---|---|
| Registration is admitted by the invitation code alone: no challenge, no email, no session | `PostgresAuthRepository.register` creates the account `status='active'`, `email_verification_state='unverified'`, writes the credential, consumes the invitation, and records `registration_requested`. It issues no challenge and returns `{accepted: true, userId}` — no delivery handle, no session, no resend window (`packages/database/src/auth-repository.ts`). |
| `pending_verification` is retired; an unverified address is represented explicitly | Migration `0007_otp_only_for_password_reset.sql` adds `users.email_verification_state` with the agreement constraint `(state = 'verified') = (email_verified_at IS NOT NULL)`, backfills `unverified` from missing evidence, converts `pending_verification` accounts to `active`, and narrows `users_status_check` to `active, locked, disabled, deletion_pending`. |
| `/auth/verify-email` and `/auth/verification/resend` leave the MVP contract | Both routes, both contract schemas, both client methods, the `verifyEmailView` screen, and the `email_verification_otp` template are deleted. Registration's 202 body is exactly `{"accepted":true}`. |
| The emailed OTP is a password-reset OTP: six digits, 10 minutes, five attempts, 60-second resend cooldown, cumulative failure budget, issuance caps | `requestPasswordReset` issues a six-digit OTP challenge (`purpose='password_reset'`, `otpLifetimeMs`, `maximumAttempts`); `resetPassword` verifies it against the purpose-separated digest, retires the challenge on expiry or attempt exhaustion, spends a cumulative per-account failure budget **before** reading any challenge, and revokes every session (`reason='password_reset'`) without issuing one. |
| Reset must not disclose whether an address exists | Four request outcomes — unknown address, non-active account, live cooldown, exhausted issuance cap — return the same `{accepted:true}` body and issue nothing; the cumulative budget is spent before the account lookup, so a throttled unknown address is indistinguishable from a throttled known one. |
| A never-verified address is never presented as verified | No writer sets `email_verified_at`; the database refuses `email_verification_state='verified'` without a verification instant and refuses a `pending_verification` status; the only challenge purpose that can be inserted is `password_reset` (issuance guard trigger); the session screen reports "Not verified — no verification email is sent in this beta, and none is required to use the account." |

## 2. Policy values implemented (approved as D2/D3; `SPEC-AUTH-02` still owns them)

`packages/config/src/index.ts` → `authPolicy.challenge`:

| Bound | Value |
|---|---|
| OTP shape | numeric, 6 digits |
| OTP lifetime | 10 minutes |
| Attempts per challenge | 5 |
| Resend cooldown | 60 seconds |
| Cumulative failed-verification budget | 10 per account per hour, shared across superseded challenges |
| Issuance caps | 3 per account per hour, 6 per account per 24 hours |

Password transport bound stays at the contract's `min(1).max(200)` with the service's own 12–128
policy unchanged (approved as D7). The retired `verificationMaximumAttempts` abuse limit is gone;
per-IP and per-account `reset_target`/`reset_ip` windows remain.

## 3. Migration 0007 and its safety rehearsal

The migration runner executes each file in one transaction under `lock_timeout='5000ms'` and
`statement_timeout='30000ms'`, so a blocked lock aborts and rolls back instead of hanging a
deployment. 0007 is deliberately bounded: two `ALTER TABLE users` constraint/column changes, one
bounded backfill `UPDATE`, one bounded `UPDATE` that supersedes outstanding verification challenges,
one function, one trigger, and two comments. No table rewrite, no index build, no `VACUUM`/`CLUSTER`.

Rehearsed on the disposable local cluster (PostgreSQL 17.6, database `kfin_test`) against seeded
legacy data — one `pending_verification` account, one verified account, one active-unverified
account, one locked account, one outstanding verification challenge, one consumed verification
challenge — before the migration was applied to any other schema:

- the pending account became `active` + `unverified`; the verified account stayed `verified`; the
  active-unverified and locked accounts stayed `unverified`; the outstanding verification challenge
  was superseded, the consumed one untouched;
- four negative controls were each refused with SQLSTATE `23514`: claiming `verified` without
  `email_verified_at`, claiming `unverified` while `email_verified_at` is set, writing the retired
  `pending_verification` status, and inserting an `email_verification` challenge;
- `pnpm run db:migrate` reported `Applied 1 KFin migration(s)`.

History is preserved rather than rewritten: `email_verification` stays in the purpose `CHECK`, because
re-purposing a consumed challenge would both violate `kfin_auth_challenges_guard()` and falsify the
audit trail. The new `auth_challenges_issuance_guard_trg` refuses *new* challenges of any other
purpose, so issuance — not history — carries the guarantee.

## 4. Discovered consequence: two verified-email write guards had to go

`packages/database/src/identity.ts` (financial-account bootstrap) and
`packages/database/src/savings-repository.ts` (goal creation and goal locking) each gated owner
access on `status = 'active' AND email_verified_at IS NOT NULL`. With registration no longer
verifying anything, those predicates would have denied the entire product to every beta account —
including the account that just registered successfully.

The committed revision settles the question explicitly. `DATABASE.md` §users: *"`pending_verification`
is retired by OQ-20: every MVP registration creates an `active` account, because admission is the
consumed invitation code and **email verification gates nothing**."* The verification half of each
predicate was therefore removed and the account-status half kept. This is not a new policy decision:
it is the code conforming to the already-committed text, and it is recorded here because the
revision record did not enumerate it.

## 5. Changed files

Code:

- `packages/database/migrations/0007_otp_only_for_password_reset.sql` (new)
- `packages/database/src/auth-repository.ts` — register, login, authenticate, reset request/reset,
  issuance cap, abuse-attempt window, removal of `issueChallenge`/`resendVerification`/`verifyEmail`
- `packages/database/src/identity.ts`, `packages/database/src/savings-repository.ts` — owner guards (§4)
- `packages/contracts/src/auth.ts` — register/me schemas, reset body, removal of the verification schemas
- `packages/config/src/index.ts` — `authPolicy` bounds (§2)
- `apps/api/src/auth-routes.ts`, `apps/api/src/email-delivery.ts` — routes and the email template set
- `apps/web/src/{api.ts,main.ts,views/auth.ts}` and the rebuilt `apps/web/dist`

Tests:

- `packages/database/test/migration-contract.test.ts` — six new assertions on 0007, including a pinned
  checksum for the reviewed file
- `packages/database/test/auth-access.integration.test.ts` — registration/unverified/reset-OTP suites
  (AUTH-REG, AUTH-RST, AUTH-UNV), including the cumulative-budget, issuance-cap, cooldown,
  generic-outcome, locked-account, and database-negative-control cases
- `packages/database/test/{auth-abuse-counters,financial-accounts.integration}.test.ts`
- `apps/api/test/*`, `apps/web/test/*`, `packages/contracts/test/auth.test.ts`,
  `packages/config/test/index.test.ts`

Docs: this file; the revision record's §5.2; `README.md`; `docs/development/LOCAL-DEVELOPMENT.md` §4;
`docs/evidence/2026-10-12-LOCAL-APPLICATION-RUN.md` addendum.

## 6. Checks run

| Gate | Result |
|---|---|
| `pnpm run evidence:check` | PASS — 25 JavaScript modules and 29 harness files |
| `pnpm run evidence:test` | 17/17 PASS |
| `pnpm run typecheck` | exit 0 |
| `pnpm run test:unit` | 675/675 across 30 files |
| `pnpm run test:integration` (PostgreSQL 17.6, local disposable cluster, `KFIN_INTEGRATION_TARGET=non-production`) | 69/69 across 7 files |
| `pnpm run check` (aggregate) | exit 0 — 681 passed, 69 skipped, 750 total |
| Local HTTP run through the API origin, `EMAIL_DELIVERY_ADAPTER=file` (§7) | all rows as specified |

## 7. Wire-level verification of the acceptance criteria

Every row is a real HTTP exchange (`NODE_ENV=development`, PostgreSQL 17.6, migrations 0001–0007):

| Flow | Result |
|---|---|
| `POST /api/v1/auth/register` | `202` with body exactly `{"accepted":true}` |
| files in the local email sink immediately after registration | **0** — no email is composed, queued, or sent |
| `POST /api/v1/auth/login` (the account never verified anything) | `200`, session + CSRF cookie |
| `GET /api/v1/auth/me` | `200` with `status=active`, `emailVerifiedAt=null` |
| `POST /api/v1/auth/password/reset-request` | `200 {"accepted":true}`; sink holds exactly one `password_reset` message whose secret is six digits |
| `POST /api/v1/auth/password/reset` with that OTP | `200`, `sessionsRevoked=1` |
| the same OTP again | `400 AUTH_CHALLENGE_INVALID` (single-use) |
| `GET /api/v1/auth/me` with the pre-reset cookie | `401 AUTHENTICATION_REQUIRED` |
| `POST /api/v1/auth/verify-email`, `POST /api/v1/auth/verification/resend` | `404` — not in the contract |
| reset request for an unknown address vs. a known one | byte-identical `{"accepted":true}` |
| `users` row after a completed reset | `status=active`, `email_verification_state=unverified`, `email_verified_at=null` |
| `POST /api/v1/auth/login` with the new password | `200` |

The one-time codes used in that run were read from the local sink inside the test process and were
never written to a report, a log, or the repository; the sink directory was deleted afterwards.

## 8. What this milestone deliberately does not do

- **No merge and no deployment.** The branch stays unmerged; nothing was applied to any shared or
  production database. Only the disposable local cluster was migrated.
- **No owner decision is closed.** `SPEC-AUTH-01` (ratification of the retired verification branch)
  and `SPEC-AUTH-02` (the candidate values in §2) still need owner signatures. The eight-digit OTP
  alternative recorded by the revision stays open; the six-digit code is bounded by the caps in §2.
- **No beta risk acceptance.** D5 (accepting the unverified-email beta risks with an operator process
  and no code) is a recorded decision, not code; it is not evidenced here.
- **No normative document was found to still describe the old flow.** `docs/architecture/ARCHITECTURE.md`
  and `docs/ux/SCREEN-INVENTORY.md` had **already been synchronized** by the OQ-20 revision commit
  `9456067` (revision record §3 and §4), so this milestone left them untouched because nothing needed
  changing. An earlier draft of this section claimed both documents still described the old flow; that
  claim was simply wrong and was corrected on 2026-10-12 after the pre-merge review
  ([`docs/reviews/2026-10-12-PRE-MERGE-REVIEW-PR-10.md`](../reviews/2026-10-12-PRE-MERGE-REVIEW-PR-10.md), finding F-2).
  The one residual sentence in `SCREEN-INVENTORY.md` that presupposed a URL-borne reset secret was
  clarified in the same follow-up changeset (P-1 of that review). Historical milestone and verification
  records are left as written, because they record what was true when they ran; where such a record's
  subject has since changed, it carries a dated supersession note instead of a rewrite — see
  [`docs/evidence/2026-10-12-MILESTONE-10-VERIFICATION.md`](../evidence/2026-10-12-MILESTONE-10-VERIFICATION.md)
  and [`docs/evidence/2026-10-12-LOCAL-APPLICATION-RUN.md`](../evidence/2026-10-12-LOCAL-APPLICATION-RUN.md) §2.1.
  `docs/architecture/DATABASE.md` and `docs/testing/TEST-STRATEGY.md` were already revised by OQ-20 and
  are pinned by digest in the SPEC-FIN-02 harness; this milestone did not edit them.
- **No new email provider.** `EMAIL_DELIVERY_ADAPTER=file` remains a development-only sink.

## 9. Traceability

- Specification: `docs/security/SECURITY-REQUIREMENTS.md` SEC-AUTH-18/19/20, `docs/architecture/DATABASE.md`
  §users and §auth_challenges, `docs/testing/TEST-STRATEGY.md` §3.4.1.
- Revision record: `docs/evidence/2026-10-12-AUTH-POLICY-SPECIFICATION-REVISION.md` §5 (closed by this
  file) and §5.1 (authoritative-document pinning, unchanged).
- Decisions implemented **in code**: D2, D3, D4, D7, D8 as recorded in the revision task.
- **D5 is not implemented and is not yet accepted in writing.** It is a risk-acceptance decision with
  no code, and it is one of the owner decisions requested in
  [`docs/evidence/2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md`](../evidence/2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md),
  which also carries the `SPEC-AUTH-01` ratification request (D1) and the `SPEC-AUTH-02` value approval
  request (D9). None of the three has a signature.
- Two findings from the pre-merge review are **open and not closed here**: F-3 (a reset-request
  availability weakness that is externally reachable) and F-8 (a reset-request timing difference).
  Both are analysed with options and costings in the same record, and neither may be closed by a risk
  note alone.
