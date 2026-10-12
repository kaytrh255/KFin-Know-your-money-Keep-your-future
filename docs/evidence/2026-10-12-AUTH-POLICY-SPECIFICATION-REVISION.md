# Authentication specification revision — OTP reserved for password reset (OQ-20)

**Date:** 2026-10-12<br>
**Type:** Specification-only change (no application code, no migration, no deployment)<br>
**Decision:** [OQ-20](../product/DECISION-LOG.md) in the Product Decision Log<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2` (unchanged; this revision edits the living specifications, not the frozen financial baseline)<br>
**Repository baseline for this record:** `28ee85f2c0137a97d52133bff471526d8b661926` plus the open branch that this revision is committed to<br>
**Production readiness:** Not claimed

## 1. Decision being specified

Product decision OQ-20 (2026-10-12), recorded in the decision log rather than by silent text
replacement:

1. Normal registration must not send an OTP and must not require email OTP verification.
2. A user registers with the required fields plus a valid invitation code and can then sign in
   with the credentials they chose.
3. Email OTP delivery is reserved for the forgot-password/password-reset flow.
4. Password reset must verify a valid, unexpired, single-use OTP before a new password is
   accepted.
5. Password policy, invitation controls, login rate limits, session security, and abuse
   protections are preserved.

## 2. How this revision specifies it

| Area | Specification outcome |
|---|---|
| Registration | Invitation code + required fields only. Atomic invitation consumption and `active` account creation. **Zero** authentication challenges, **zero** emails sent or enqueued, **zero** sessions issued. A generic accepted result directs the user to sign in. |
| Unverified representation | `users.email_verified_at` stays NULL and an explicit `email_verification_state` (`unverified \| verified`) records the truth; the two are constrained to agree. No flow — registration, invitation consumption, login, reset, password change, or operator support — may set a verified state. `pending_verification` is retired rather than reused as a way to describe an unverified address. |
| OTP scope | `auth_challenges.purpose` is `{password_reset}` in MVP. A future verification flow needs a new approved decision, and an outstanding non-reset challenge must never be reinterpreted as a reset challenge. |
| Reset request | Identical status, body shape, and bounded timing for existing, non-existing, ineligible (`locked`/`disabled`/`deletion_pending`) and rate-limited addresses. A message is sent only for an eligible existing account; nothing is sent otherwise. |
| Reset OTP | Cryptographically random numeric code, purpose-bound, keyed-digest only, single-use. Candidate values pending `SPEC-AUTH-02` approval: 10-minute expiry, five attempts per challenge, cumulative cap of ten failed verifications per account per hour across superseded challenges, 60-second resend cooldown, three issuances per account per hour and six per 24 hours, plus per-IP/network and global cost caps. A resend supersedes the previous challenge and does **not** reset the cumulative budget. An eight-digit code remains an open alternative. |
| Reset completion | One atomic or fail-safe unit: consume the challenge, replace the credential, revoke **every** session, clear the cookie, invalidate the account's other challenges, record a security event, and issue **no** session. The user signs in explicitly; the old password no longer works. |
| Delivery | The OTP is typed into the application, not embedded in a URL: no reset secret in a link, referrer, redirect, or browser history. It is submitted immediately from request-process memory after digest-only commit and never enters the ordinary outbox, logs, analytics, or error payloads. |
| API contract | The MVP authentication surface is register, login, logout, logout-all, session list/revoke, reset request, reset completion, password change, current session/profile, and security events. `/auth/verify-email` and `/auth/verification/resend` must not be part of the MVP OpenAPI contract, and no response may echo the address, the OTP, or a challenge identifier. |
| Preserved unchanged | Argon2id and password policy, invitation-code mechanism and controls, login abuse/rate limits, session lifetimes/rotation/revocation and CSRF/origin defense, security-event recording, and retention baselines. |

## 3. Documents synchronized in this revision

Normative specifications:

- `docs/product/DECISION-LOG.md` — OQ-20 entry, summary row, traceability row, change-control record;
- `docs/product/PRD.md` — PRD-AUTH-01/02/03/04/06, analytics, email-delivery constraint, blocker rows;
- `docs/product/USER-FLOWS.md` — first-use map, `UF-AUTH-01`, `UF-AUTH-04`, validation scenarios, closure register;
- `docs/product/MVP-SCOPE.md`, `docs/product/ROADMAP.md` — scope and phase wording;
- `docs/security/SECURITY-REQUIREMENTS.md` — SEC-AUTH-04/05/06/08/11/13/14/16/17 revised, SEC-AUTH-18/19/20 added, SEC-ABUSE-03, SEC-LOG-04, SEC-DATA-01, §21 register;
- `docs/security/THREAT-MODEL.md` — A-02, abuse cases, data-flow label, TM-03/04/09/24/31, RQ-TM-04, §13 register;
- `docs/architecture/ARCHITECTURE.md` — stack table, §9 MVP auth surface and oracle rule, §11 atomic operations, §13 authentication architecture, §18 failure behavior, §21 register;
- `docs/architecture/DATABASE.md` — §4.1 `users`, §4.4 `auth_challenges`, new §16.1 required migration;
- `docs/architecture/ADR/ADR-002`, `ADR-004`, `ADR-005`, `ADR-008`, `ADR/README.md` — decision text, policy values, blocker tables, index row;
- `docs/ux/UX-SPEC.md`, `docs/ux/SCREEN-INVENTORY.md`, `docs/ux/UI-DESIGN-SYSTEM.md` — reset-OTP entry rules, retired verification screen, content honesty rules, evidence rows;
- `docs/testing/TEST-STRATEGY.md` — new §3.4.1 case families (`AUTH-REG`, `AUTH-RST`, `AUTH-UNV`), §3.5/§5.4/§5.6/§5.7/§13 updates;
- `docs/testing/RELEASE-CHECKLIST.md` — §1 and §4 criteria;
- `docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md` — blocker rows, authentication limit row, evidence manifest;
- `docs/README.md` — version, revision note, summary points, decision and blocker registers;
- `docs/reviews/SPECIFICATION-REMEDIATION-ROUND-3.md` — dated revision note and supersession markers, original Round 3 text retained as history.

Orientation records: root `README.md`, `docs/development/LOCAL-DEVELOPMENT.md`.

Evidence tooling (one deliberate, disclosed change — see §5.1): `evidence/spec-fin-02/src/constants.mjs`,
`evidence/spec-fin-02/src/runner.mjs`, `evidence/spec-fin-02/test/static-contract.test.mjs`,
`evidence/spec-fin-02/README.md`.

## 4. Contradictions found and how each was resolved

| Statement, where it was | Conflict with OQ-20 | Resolution |
|---|---|---|
| "The user MUST verify control of the email address with an expiring, single-use OTP before full account access" (PRD-AUTH-02) | Registration would still require an OTP | Requirement rewritten to forbid registration/sign-in verification requirements and to require honest unverified representation |
| "Full application access requires `active` + verified email" (`DATABASE` §4.1) | No MVP account would ever have a verified email, so no one could use the product | Access now requires `active` plus a valid session; admission is the consumed invitation code |
| `users.status` included `pending_verification` (`DATABASE` §4.1) | Would be the natural place to park unverified accounts, which would make "unverified" mean "blocked" | Value retired; unverified state is carried by the explicit verification field, and MVP registration creates an `active` account |
| "One purpose-bound model for email verification and password reset" (`DATABASE` §4.4) | Implies a verification challenge exists | Model limited to `password_reset`; other purposes are retired, and cross-purpose reinterpretation is forbidden |
| "Password reset uses a high-entropy single-use URL secret or separately approved challenge" (ADR-002) | The decision names an emailed OTP, and a URL secret reintroduces referrer/history exposure | MVP uses an emailed OTP typed in the app; a URL-secret variant needs a new decision and its removal rule (SEC-AUTH-06) |
| "Successful verification MUST follow exactly one approved `SPEC-AUTH-01` branch" (SEC-AUTH-16) | There is no verification step to follow | Replaced: neither registration nor reset issues a session; reset revokes every session and the user signs in explicitly |
| "If verification creates a session…" (`ARCHITECTURE` §21, `ADR-002`, `ADR-004` register rows) | Same stale subject | Rows marked superseded with the replacement criterion and the ratification still owed to Product + Security |
| "The user MUST be able to request password recovery, reset a password with an expiring single-use token/challenge" (PRD-AUTH-06) | Did not require OTP verification before the new password | Rewritten to require presenting a valid, unexpired, single-use emailed OTP first |
| "Purpose-bound verification/recovery email may contain only the required short-lived OTP/reset secret" (`UX-SPEC` §14) | Implied a verification email exists | Narrowed to the password-reset email; registration emails nothing |
| Screens `AUTH-03 /verify-email` and the §2 map's "Verify email" entry (`SCREEN-INVENTORY`) | Specified a screen for a flow that no longer exists | Marked retired, with the state set a future reintroduction would need |
| `AUTH-VRF-01`–`06` as the closure suite for `SPEC-AUTH-01` (`TEST-STRATEGY` §3.5) | Tests a flow that no longer exists | Superseded by `AUTH-REG-01`–`06` and `AUTH-RST-01`–`12`; `AUTH-VRF` applies only if verification returns |
| Release criteria "post-verification sign-in/session behavior match approved policy" (`RELEASE-CHECKLIST` §4) | Unreachable criterion | Replaced with registration-no-challenge/no-email/no-session, unverified representation, and reset-OTP criteria |
| `eligible verified account receives a reset` (`USER-FLOWS` UF-AUTH-04) | No MVP account is verified, so reset would be impossible | Eligibility no longer depends on `email_verified_at`; ineligible states are enumerated and answers stay identical |
| Account-deletion "identity verification" (PRD-AUTH-10, SEC-DATA-01, `DATABASE` §4.6) | Email possession was implicitly available as a verification factor; after OQ-20 it is unavailable for every account | Deletion identity verification is now explicitly the live session plus recent authentication, and email possession must not be used |
| "Registration, login, verification, resend, and reset apply layered abuse controls" (ADR-002) | Lists a flow that no longer exists | Revised to registration, login, reset request, reset verification |

Deliberately **not** changed: historical records. `docs/evidence/2026-10-08-MILESTONE-04-VERIFICATION.md`,
`docs/implementation/MILESTONE-04-TRUSTED-PRIVATE-BETA-ACCESS.md`, and the other dated milestone
records describe what was built and verified at their commit. They are history, not current
specification, and rewriting them would destroy the audit trail. The Round 3 report keeps its
original text and carries an explicit dated supersession note.

## 5. Implementation gap created by this revision (open, not hidden)

This task is specification-only. The code in this repository still implements the pre-revision
flow, so the specification and the implementation now disagree, and that disagreement is
recorded here rather than left implicit:

- `POST /api/v1/auth/register` still issues an `email_verification_otp` challenge and sends the
  code (`apps/api/src/auth-routes.ts`, `apps/api/src/email-delivery.ts`);
- `POST /api/v1/auth/verify-email` and `POST /api/v1/auth/verification/resend` still exist and
  are still in the generated OpenAPI document, which OQ-20 now excludes from the MVP contract;
- registration still leaves the account `pending_verification`, a status OQ-20 retires;
- the required data migration in `DATABASE` §16.1 has not been written;
- password reset already revokes every session, but the revised reset-OTP bounds (cumulative
  budget, issuance caps) are not implemented or tested.

Required follow-up, in its own task: the implementation change, its migration, its OpenAPI
change, and its tests. This revision does not authorize it, and no environment may begin
presenting an unverified address as verified in the meantime.

## 5.1 The authoritative-document pin had to be re-pointed, and why that is not a weakened check

The SPEC-FIN-02 evidence harness verifies that five authoritative documents are the exact
reviewed text the concurrency candidate depends on (`AUTHORITATIVE_DOCS` in
`evidence/spec-fin-02/src/runner.mjs`). Until this revision all five had been byte-identical to
the frozen baseline `a48d2c5…`, and three of them —
`docs/architecture/DATABASE.md`, `docs/testing/TEST-STRATEGY.md`, and
`docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md` — are shared specification documents that
this revision must change to stay consistent with OQ-20. A byte-comparison against the frozen
commit therefore had to fail, and the repository offered no path to amend a shared specification
document while the candidate is unfrozen.

The resolution keeps the check exact rather than relaxing it:

- the candidate's own documents (`SPEC-FIN-02-SNAPSHOT-CONCURRENCY.md`,
  `ADR-009-per-account-financial-serialization.md`) are still compared **byte-for-byte** with
  `FROZEN_SOURCE_COMMIT`;
- the three shared documents are pinned to the **SHA-256 of their reviewed amended content** in
  `AMENDED_AUTHORITATIVE_DOCS`, together with the decision id, date, and record path, so any
  later edit fails exactly as before until a new dated revision records new digests;
- the test suite now asserts the pinning map itself: the amended list must be exactly those
  three documents, each digest must be a 64-character hash, and every other authoritative
  document must still equal the frozen commit's content. The check never compares a document
  against itself.

Verified by negative control: appending one comment line to `docs/architecture/DATABASE.md`
makes `verifyFrozenAuthoritativeDocs()` fail with the revision message, and restoring the file
makes it pass again. `FROZEN_SOURCE_COMMIT` is unchanged, so every generated artifact still
records the original SPEC-FIN-02 candidate commit as its specification source.

## 5.2 Closure: the follow-up implementation landed (2026-10-12, Milestone 11)

*Editorial note (2026-10-12): this subsection was originally inserted before §5.1 and was moved after
it so the numbering reads in order. No content changed; the move is recorded here because this file is
under change control (pre-merge review
[`docs/reviews/2026-10-12-PRE-MERGE-REVIEW-PR-10.md`](../reviews/2026-10-12-PRE-MERGE-REVIEW-PR-10.md), finding F-6).*

The §5 gap was closed by its own task on branch `arena/bfaf5019-…`, recorded in
[`docs/implementation/MILESTONE-11-OTP-RESET-ONLY.md`](../implementation/MILESTONE-11-OTP-RESET-ONLY.md).
Point by point:

| §5 gap | Closed by |
|---|---|
| registration still issued an OTP challenge and sent the code | registration issues no challenge and sends nothing; the API route answers `202 {"accepted":true}` |
| `/auth/verify-email` and `/auth/verification/resend` still existed and were published | both routes and their schemas are deleted; both answer `404` |
| registration still left the account `pending_verification` | migration 0007 retires the status, converts those accounts to `active`, and adds the explicit `email_verification_state`; login and session resolution gate on `status='active'` alone |
| the required data migration in `DATABASE` §16.1 had not been written | `0007_otp_only_for_password_reset.sql`, rehearsed against seeded legacy data and pinned by checksum in `migration-contract.test.ts` |
| the revised reset-OTP bounds were not implemented or tested | six-digit OTP, 10-minute expiry, five attempts, 60-second cooldown, cumulative 10-per-hour budget, 3/6 issuance caps, single-use consumption, and the four byte-identical request outcomes — all covered by the AUTH-RST suite |

Two things stayed open on purpose and are unchanged by this closure: `SPEC-AUTH-01` and
`SPEC-AUTH-02` remain unratified owner decisions, and nothing was merged or deployed. One consequence
the revision did not enumerate was found during implementation — three write guards in
`identity.ts` and `savings-repository.ts` also required `email_verified_at`, which the revised
`DATABASE.md` text ("email verification gates nothing") settles; it is recorded in the Milestone 11
record §4. This file's §5.1 pinning is untouched: no authoritative document was edited by the
implementation, so no digest moved.

## 6. Checks run for this change

Specification-only change; the repository's required specification and evidence checks were run
in this workspace (Node 22, pnpm through Corepack, PostgreSQL 17.6 for the integration gate):

| Check | Command | Result |
|---|---|---|
| Specification/evidence scan | `corepack pnpm run evidence:check` | PASS — "Checked 25 JavaScript modules and 29 harness files." |
| Evidence harness tests | `corepack pnpm run evidence:test` | PASS — 17 tests, 17 pass, 0 fail (16 before this revision; the added test is the pinning-map self-check in §5.1) |
| Typecheck | `corepack pnpm run typecheck` | PASS, exit 0 — no build/type output changed, and no application source is in this change set |
| Unit tests | `corepack pnpm run test:unit` | PASS — 691 tests / 30 files |
| Integration tests | `corepack pnpm run test:integration` | PASS — 64 tests / 7 files, PostgreSQL 17.6 (local disposable cluster, `KFIN_INTEGRATION_TARGET=non-production`) |
| Aggregate gate | `corepack pnpm run check` | PASS, exit 0 — evidence:check, evidence:test, typecheck, and the complete Vitest run (37 files / 755 tests) |
| Authoritative-document pin | negative control in §5.1 | PASS — one appended line to a pinned document fails the check; restoring it passes |
| Consistency scan | `grep` for the retired flows' requirement IDs and phrases (`verify email`, `email verification`, `verification OTP`, `verified email`, `pending_verification`, `post-verification`, `AUTH-VRF`) | PASS — every remaining mention is either a dated historical record, an explicit supersession/retirement statement, or unrelated prose (`verify same-user ownership`, `verify signature`) |

## 7. Open product and security decisions recorded by this revision

1. **`SPEC-AUTH-01` retirement** — needs Product + Security ratification. The subject is gone;
   the register row is marked `SUPERSEDED`, not closed by documentation.
2. **Reset OTP strength** — the six-digit candidate is retained from the previous baseline, with
   the cumulative-budget control added. An eight-digit code (or another alphabet) remains an
   alternative and, if chosen, changes the copy, the input component, and the `AUTH-RST` cases.
3. **Reset-OTP bounds** — expiry, attempts, cumulative budget, resend cooldown, issuance caps,
   and provider-cost caps are candidate values requiring `SPEC-AUTH-02` approval and threat
   evidence; nothing here is approved policy.
4. **Reset eligibility for `locked` accounts** — specified as not eligible, with a sanitized
   operator-facing event. Whether a locked account should be self-recoverable is a Security
   decision, and the alternative would need its own flow and tests.
5. **Unverified-email consequences** — support recovery for a mistyped address, deliverability of
   reset OTP to an unverified address, and the absence of an ownership-proof channel all remain
   accepted-but-unowned beta risks. `THREAT-MODEL` records them; no owner has accepted them.
6. **Representation choice** — `email_verified_at` plus an explicit verification state was chosen
   over reusing `status` or adding an "admission basis" column. If a future verification flow
   needs per-challenge provenance, that is a new decision.
7. **Password transport bound** — `packages/contracts/src/auth.ts` still publishes `1–200` while
   the service enforces `12–128` + common/similarity refusal. Unrelated to OQ-20, still open from
   `docs/implementation/MILESTONE-10-VALIDATION-ERROR-DETAIL.md`.
