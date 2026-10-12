# ADR-002 — Authentication Strategy

**Status:** Blocked (revised 2026-10-12 for OQ-20; still not Accepted)<br>
**Date:** 2026-10-07 (OQ-20 revision 2026-10-12)<br>
**Decision owners:** Product Owner (`SPEC-AUTH-01` accountable); Security Owner (`SPEC-AUTH-02` accountable and `SPEC-AUTH-01` mandatory co-approver); Architecture Owner (consulted/technical evidence)<br>
**Exact blocker:** OQ-11’s mandatory single-use expiring invitation-code mechanism is Accepted, and email-allowlist admission is rejected. OQ-20 (2026-10-12) fixes registration admission without an email OTP and reserves the emailed OTP for password reset, which removes the subject of `SPEC-AUTH-01` (its retirement still needs Product + Security ratification) and leaves `SPEC-AUTH-02` (invitation/password/reset-OTP/abuse/session policy values) decision-ready but unapproved. `RC-PROV-01` remains the email-provider gate; required auth race/threat/benchmark/UX evidence does not exist.<br>
**Related:** [Security requirements](../../security/SECURITY-REQUIREMENTS.md), [ADR-004](ADR-004-session-management.md)

## Context

KFin stores highly sensitive personal financial information. Private Beta needs invitation-admitted registration, password login, password recovery/change, persistent access, abuse protection, and future MFA compatibility. Since OQ-20 the only emailed OTP is the password-reset OTP: registration neither verifies the address nor sends an OTP. It must avoid permanent tokens, account enumeration, plaintext/reversible passwords, and unnecessary identity-provider dependence.

Private Beta uses expiring, single-use invitation codes and a Vietnamese-first UI. Invitation operating values/provisioning, the email provider, legal terms, and MFA roadmap still require their stated reviews or due gates.

## Decision

Use first-party **invitation-admitted email + password** authentication, with the address explicitly unverified unless a verification challenge is consumed (OQ-20), and these boundaries:

- Private Beta registration requires a high-entropy, expiring, single-use invitation code stored only as a digest; it may be bound to a normalized recipient email, and invitation consumption plus pending-account creation are atomic. A server-side email allowlist is not an admission mechanism or fallback.
- Normalize email consistently while preserving a presentation form.
- Hash passwords using Argon2id with unique salts and parameters benchmarked to current OWASP guidance on production hardware. Store the encoded hash only.
- Enforce a reviewed password policy, permit paste/password managers, reject common/known-compromised passwords through a privacy-safe mechanism, and do not force arbitrary periodic password changes.
- Admit registration through the mandatory single-use, expiring invitation code alone (OQ-20). Registration creates an immediately usable `active` account, creates no authentication challenge, sends or enqueues no email, and issues no authenticated session; the user signs in with the credentials just chosen.
- Represent an account whose email was never verified explicitly: `email_verified_at` stays NULL with an explicit `unverified` verification state. Neither registration, invitation consumption, login, password reset, nor support may mark the address verified, and email possession is never treated as identity proof.
- Password reset requires an emailed, cryptographically random, purpose-bound (`password_reset`), expiring, attempt-limited, single-use OTP whose numeric entropy is low, so only a keyed digest/hash is stored — never a plain fast hash. The OTP is typed into the application: no reset link containing a secret is issued in MVP.
- Send the reset OTP immediately after the challenge digest is committed, while plaintext exists only in request-process memory. The ordinary durable outbox must never contain that plaintext. Provider failure/uncertainty leads to generic guidance and a controlled resend that supersedes the previous challenge without resetting the account's cumulative failed-verification budget. An asynchronous encrypted secret envelope is not selected without a separate key-management decision.
- Registration, login, reset request, and reset verification apply layered IP + normalized-account/target + device/risk abuse controls with generic errors, and a reset request answers identically whether or not the address exists.
- Password reset revokes every active session. Known-password change reauthenticates, revokes other sessions, and rotates the current session under the proposed policy.
- Record sanitized security events; ownership-implying security notices are not sent to an unverified address, and only the password-reset OTP is emailed to it.
- Design user/challenge/session records so TOTP/WebAuthn MFA can be added through a future specification, but do not implement MFA in MVP.

Proposed initial policy values (not accepted until security/UX review):

- minimum 12 characters, maximum at least 128 characters;
- reset-OTP lifetime 10 minutes, at most 5 verification attempts per challenge, and a cumulative cap of 10 failed verifications per account per hour across superseded challenges;
- resend cooldown 60 seconds, at most 3 challenge issuances per account per hour and 6 per 24 hours, plus per-IP/network and global email-cost caps;
- reset completion revokes every session, invalidates the account's other challenges, and issues no session, so the user signs in explicitly;
- no security-question recovery, and no reset secret in a URL.

Limits are centrally configurable within secure bounds, monitored, and tuned without revealing account existence.

### Round 3 unresolved decision packet

This ADR remains **Blocked**. The following choices are not part of the proposed authentication direction until approved:

| Blocker | Exact decision required | Fixed constraints | Required evidence | ADR acceptance condition |
|---|---|---|---|---|
| `SPEC-AUTH-01` | **Superseded by OQ-20 (2026-10-12):** the post-verification outcome no longer exists — registration has no verification step, and reset consumption revokes every session and issues none. What remains is ratification of the retirement, not a branch selection | No pre-auth identifier survives; generic external behavior; no session from registration or reset | Ratification record; fixation/retry/multi-tab tests for register→sign-in and reset→sign-in; updated Vietnamese copy review | Product + Security ratify the retirement; ADR-004, flows, security and tests contain one deterministic outcome |
| `SPEC-AUTH-02` | Approve expiry/binding/issuance/revocation for invitation; password normalization/bounds/check; reset-OTP lifetime/attempts/cumulative budget/resend/issuance caps/supersession/failure; login abuse; session lifetime/rotation/replay; known-password-change revocation | Invitation code only; Argon2id; password-manager/paste support; digest-only secrets; reset revokes all sessions and issues none; registration sends no email; no security questions | Threat/abuse review, Argon2 benchmark, provider assumptions, UX/accessibility and replay/concurrency tests | Security + Product approve every dimension/value/range/change owner; no proposed/default value remains unlabeled |

The exact checklist and evidence metadata are in the [Round 3 report](../../reviews/SPECIFICATION-REMEDIATION-ROUND-3.md) and [Approval and Evidence Register](../../governance/APPROVAL-AND-EVIDENCE-REGISTER.md). Documenting this table is not acceptance.

## Alternatives considered

### Managed identity provider

**Benefits:** mature MFA/social login/risk tools, lower cryptographic implementation burden.<br>
**Not selected yet because:** cost, data residency, provider lock-in, UI/session integration, and beta requirements are unknown. It must be fairly reassessed when ADR-002 is reviewed; accepting this ADR selects first-party authentication for MVP.

### Passwordless email magic links only

**Benefits:** no user password database, simple UX for some users.<br>
**Rejected for MVP proposal because:** email account availability becomes the sole recurring factor; link scanning/delivery delays and device transfer can confuse users; the explicit requirement calls for email/password login.

### Social sign-in

**Benefits:** convenient and delegated credential security.<br>
**Rejected now because:** not required, introduces providers/tracking/account-linking complexity, and does not remove need for recovery/security policy.

### Home-grown reversible encryption or fast password hashes

Rejected categorically: compromise would expose credentials and violates security requirements.

## Reasoning

- Meets explicit product requirements with understood controls.
- Argon2id limits offline password-cracking rate.
- Generic, rate-controlled workflows reduce enumeration and automated abuse.
- Separate purpose-bound challenges reduce cross-flow token replay; limiting the MVP to one purpose (`password_reset`) removes the registration-time delivery dependency that made first-run completion depend on a provider.
- Session mechanics remain independently testable under ADR-004.
- Future MFA is possible without complicating the first release now.

## Consequences

### Positive

- Familiar consumer experience and password-manager support.
- Full server-side control over verification, revocation, and audit.
- No dependency on social identities.

### Negative / risks

- KFin owns high-risk credential and recovery implementation.
- Email delivery and provider reputation become availability dependencies.
- Immediate secret-bearing delivery adds bounded provider latency and a commit/send uncertainty window; controlled resend must resolve it without revealing account state. The blast radius is now limited to password reset, and the registration path no longer depends on email delivery at all.
- Password-reset endpoints attract abuse, guessing, and cost attacks.
- Because no MVP account has a verified address (OQ-20), email possession cannot prove identity: email-based recovery is unavailable for a mistyped address, and only the audited operator/support procedure can recover that account.
- Invite/email normalization and account-enumeration details are easy to implement incorrectly.
- Password compromise remains possible before MFA exists.

### Required controls

- Vetted crypto libraries only; no custom cryptography.
- Security test matrix for timing/content enumeration, brute force, replay, resend, expiry, concurrency, and session invalidation.
- Credential secrets never logged/analysed.
- Email templates never include passwords/OTPs in observability payloads.
- Incident and compromised-account recovery procedure before beta.

## Validation before acceptance

- Approve invitation expiry/issuance/revocation/email-binding values and the audited provisioning procedure; select and review the email provider/residency before Release Candidate under OQ-17.
- Test invitation wrong-email, expiry, revoke, replay, parallel consumption, digest-only storage, generic-error, and transaction-rollback paths.
- Benchmark Argon2id under intended runtime and concurrency.
- Threat review all auth state transitions and race conditions.
- Test password manager, autofill, reset-OTP paste, screen reader, rate-limit, and email failure behavior, and assert that registration creates no challenge row, sends no email, and issues no session.
- Determine breached-password service/privacy approach.
- Complete all `AUTH-POL`, `AUTH-REG`, `AUTH-RST`, and `AUTH-UNV` evidence specified by the Test Strategy with versioned PASS/accepted-risk results; `AUTH-VRF` applies only if a future verification flow is approved, since MVP has none.
- Record named Product/Security approvers, date, source versions, evidence links, rejected alternatives, and review trigger; a role label alone is insufficient.

## Revisit when

- MFA is promoted;
- account takeover signals show password-only risk is unacceptable, or an unverified-email consequence (support recovery volume, misdelivered reset OTP, deliverability) proves material;
- managed identity total risk/cost becomes lower;
- native clients or a new regulatory requirement change authentication assurance.
