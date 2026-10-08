# ADR-002 — Authentication Strategy

**Status:** Blocked<br>
**Date:** 2026-10-07<br>
**Decision owners:** Product Owner (`SPEC-AUTH-01` accountable); Security Owner (`SPEC-AUTH-02` accountable and `SPEC-AUTH-01` mandatory co-approver); Architecture Owner (consulted/technical evidence)<br>
**Exact blocker:** OQ-11’s mandatory single-use expiring invitation-code mechanism is Accepted, and email-allowlist admission is rejected. Round 3 makes `SPEC-AUTH-01` (post-verification outcome) and `SPEC-AUTH-02` (complete invitation/password/OTP/reset/abuse/session policy) decision-ready but approves neither. `RC-PROV-01` remains the email-provider gate; required auth race/threat/benchmark/UX evidence does not exist.<br>
**Related:** [Security requirements](../../security/SECURITY-REQUIREMENTS.md), [ADR-004](ADR-004-session-management.md)

## Context

KFin stores highly sensitive personal financial information. Private Beta needs registration, email OTP verification, password login, recovery/change, persistent access, abuse protection, and future MFA compatibility. It must avoid permanent tokens, account enumeration, plaintext/reversible passwords, and unnecessary identity-provider dependence.

Private Beta uses expiring, single-use invitation codes and a Vietnamese-first UI. Invitation operating values/provisioning, the email provider, legal terms, and MFA roadmap still require their stated reviews or due gates.

## Decision

Use first-party **verified email + password** authentication with these boundaries:

- Private Beta registration requires a high-entropy, expiring, single-use invitation code stored only as a digest; it may be bound to a normalized recipient email, and invitation consumption plus pending-account creation are atomic. A server-side email allowlist is not an admission mechanism or fallback.
- Normalize email consistently while preserving a presentation form.
- Hash passwords using Argon2id with unique salts and parameters benchmarked to current OWASP guidance on production hardware. Store the encoded hash only.
- Enforce a reviewed password policy, permit paste/password managers, reject common/known-compromised passwords through a privacy-safe mechanism, and do not force arbitrary periodic password changes.
- Verify email through cryptographically random, purpose-bound, expiring, attempt-limited, single-use OTP challenges. Because numeric OTP entropy is low, store a keyed digest/hash, not a plain fast hash.
- Password reset uses a high-entropy single-use URL secret or separately approved challenge, with digest-only storage, short expiry, strict attempt/use limits, and generic request response.
- Send secret-bearing OTP/reset email immediately after the challenge digest is committed, while plaintext exists only in request-process memory. The ordinary durable outbox must never contain that plaintext. Provider failure/uncertainty leads to generic guidance and a controlled resend that supersedes according to policy. An asynchronous encrypted secret envelope is not selected without a separate key-management decision.
- Registration, login, verification, resend, and reset apply layered IP + normalized-account/target + device/risk abuse controls with generic errors.
- Password reset revokes every active session. Known-password change reauthenticates, revokes other sessions, and rotates the current session under the proposed policy.
- Record sanitized security events and send safe account-security notifications where appropriate.
- Design user/challenge/session records so TOTP/WebAuthn MFA can be added through a future specification, but do not implement MFA in MVP.

Proposed initial policy values (not accepted until security/UX review):

- minimum 12 characters, maximum at least 128 characters;
- OTP lifetime 10 minutes, at most 5 verification attempts;
- resend cooldown 60 seconds plus hourly/daily caps;
- reset link lifetime no more than 30 minutes;
- no security-question recovery.

Limits are centrally configurable within secure bounds, monitored, and tuned without revealing account existence.

### Round 3 unresolved decision packet

This ADR remains **Blocked**. The following choices are not part of the proposed authentication direction until approved:

| Blocker | Exact decision required | Fixed constraints | Required evidence | ADR acceptance condition |
|---|---|---|---|---|
| `SPEC-AUTH-01` | Select fresh rotated authenticated session after OTP consumption **or** no session + explicit sign-in; define result/onboarding, cookie/CSRF, security event, multi-tab and uncertain-response behavior | Atomic single-use OTP; no pre-auth identifier survives; generic external behavior | Threat review of both branches; fixation/retry/multi-tab tests; compact/expanded flow and Vietnamese content review | Product + Security record one branch; ADR-004, flows, security and tests contain one deterministic outcome |
| `SPEC-AUTH-02` | Approve expiry/binding/issuance/revocation for invitation; password normalization/bounds/check; OTP/reset limits/supersession/failure; login abuse; session lifetime/rotation/replay; known-password-change revocation | Invitation code only; Argon2id; password-manager/paste support; digest-only secrets; reset revokes all sessions; no security questions | Threat/abuse review, Argon2 benchmark, provider assumptions, UX/accessibility and replay/concurrency tests | Security + Product approve every dimension/value/range/change owner; no proposed/default value remains unlabeled |

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
- Separate purpose-bound challenges reduce cross-flow token replay.
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
- Immediate secret-bearing delivery adds bounded provider latency and a commit/send uncertainty window; controlled resend must resolve it without revealing account state.
- OTP endpoints attract abuse and cost attacks.
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
- Test password manager, autofill, OTP paste, screen reader, rate-limit, and email failure behavior.
- Determine breached-password service/privacy approach.
- Complete all `AUTH-VRF` and `AUTH-POL` evidence specified by the Test Strategy with versioned PASS/accepted-risk results.
- Record named Product/Security approvers, date, source versions, evidence links, rejected alternatives, and review trigger; a role label alone is insufficient.

## Revisit when

- MFA is promoted;
- account takeover signals show password-only risk is unacceptable;
- managed identity total risk/cost becomes lower;
- native clients or a new regulatory requirement change authentication assurance.
