# ADR-004 — Session Management

**Status:** Blocked<br>
**Date:** 2026-10-07<br>
**Decision owners:** Product Owner (`SPEC-AUTH-01` and `SPEC-SEC-02` accountable); Security Owner (`SPEC-AUTH-02` accountable and mandatory co-approver); Privacy/Legal Owner (`SPEC-SEC-02` mandatory co-approver); Architecture Owner (consulted/technical evidence)<br>
**Exact blocker:** Round 3 makes `SPEC-AUTH-01`, `SPEC-AUTH-02`, and `SPEC-SEC-02` decision-ready but leaves post-verification behavior, session/replay values, known-password-change consequences, and event visibility/disclosure unapproved. Browser/PWA cookie, CSRF, tab-race, privacy/content, and lookup-load evidence is also absent.<br>
**Related:** [ADR-002](ADR-002-authentication-strategy.md), [Security requirements](../../security/SECURITY-REQUIREMENTS.md)

## Context

KFin requires a consumer-style persistent login while sessions remain revocable, observable, resistant to theft/replay, and compatible with logout-all and password-change policies. The primary MVP client is same-origin Web/PWA. Permanent tokens and plaintext password storage are prohibited. Future Capacitor packaging should remain possible without weakening browser security.

## Decision

Use **opaque server-side sessions** backed by PostgreSQL.

### Token and storage

- Generate at least 256 bits of cryptographically secure random token material.
- Send the browser token only in a host-only cookie named with the `__Host-` prefix where deployment permits: `HttpOnly`, `Secure`, `Path=/`, no `Domain`, and `SameSite=Lax` by default.
- Store only a cryptographic digest of the bearer token, never plaintext.
- Do not place session tokens in localStorage, sessionStorage, IndexedDB, service-worker cache/messages, URLs, or logs.
- A session row represents the device/login; token-generation rows support rotation and replay detection.

### Lifetime and rotation

- Enforce both idle and absolute expiry server-side.
- Proposed initial values are 30-day idle and 90-day absolute lifetime, configurable only within reviewed security bounds.
- Update last-seen with write throttling to avoid a database write per request.
- Rotate after login/verification as applicable, password change, privilege/security changes, and periodically on a reviewed cadence.
- Handle concurrent tabs with an atomic generation change and a tightly bounded prior-token grace strategy. A retired token used outside policy is treated as possible replay and can revoke the session family.

### Revocation policy

- Logout revokes the current session before clearing the cookie.
- Logout everywhere revokes all user sessions atomically.
- Password reset revokes all sessions and requires fresh login.
- Known-password change revokes other sessions and rotates current session under the proposal; product/security may choose all-session revocation.
- Disabled/locked/deletion-pending accounts cannot continue through existing sessions under the approved status policy.

### Request protections

- Validate session on every private request; sensitive operations may require recent authentication.
- State-changing browser requests require a CSRF defense: trusted Origin/Fetch Metadata enforcement plus an unpredictable CSRF token bound to session/request context. SameSite alone is insufficient.
- CORS is same-origin by default; any exception is explicit and never wildcard with credentials.
- Apply `Cache-Control: no-store` to authenticated responses.
- Session list exposes only privacy-approved device/browser/time context, not token material.

### Future native client

Capacitor/native transport requires a new security review. It may use the same opaque server-side session concept but stores bearer material in platform secure storage and uses an explicit authorization transport with origin-independent CSRF reasoning. Browser tokens must not simply be copied into JavaScript storage.

### Round 3 unresolved decision packet

| Blocker | Session/security-history decision still required | Fixed boundary | Required evidence and ADR acceptance condition |
|---|---|---|---|
| `SPEC-AUTH-01` | Verification creates a fresh rotated session or creates none; cookie/CSRF/event/multi-tab/uncertain-response behavior for the selected branch | Never promote pre-auth token; OTP remains atomic/single-use | Product + Security approve one branch; fixation, multi-tab and timeout tests pass; ADR-002/flows/tests agree |
| `SPEC-AUTH-02` | Idle/absolute/recent-auth values, last-seen writes, rotation cadence, prior-token grace/replay containment, known-password-change revocation and account-status enforcement | Opaque digest-only server sessions; reset revokes all; logout semantics fixed | Security + Product approve every value/range; concurrent-tab/replay/load evidence passes; no proposed/default value is treated as policy |
| `SPEC-SEC-02` | Classify each session/auth/account event as user-visible, operator-only, both, or not retained; approve safe details, delivery/deep link and display/retention | No bearer secret, precise-location claim, internal rule, financial payload or enumeration leak | Product + Security + Privacy/Legal approve event table; API separation, threat/privacy/content/accessibility tests pass |

No row is selected by this ADR revision. The ADR remains **Blocked** until named approvers, source versions and evidence are recorded in the governance register.

## Alternatives considered

### Self-contained long-lived JWT access token

**Benefits:** validation without database lookup, common mobile pattern.<br>
**Rejected for MVP:** immediate per-session revocation, logout-all, credential-change invalidation, and replay response become more complex; scale does not require stateless validation.

### Short access JWT + rotating refresh token

**Benefits:** established distributed/mobile approach and limited access-token lifetime.<br>
**Not selected now:** two-token lifecycle, refresh races, revocation lists, storage, and replay-family logic add complexity with no multi-service need. Opaque rotating sessions provide the required behavior more directly.

### Framework-signed cookie containing session data

**Benefits:** no session lookup.<br>
**Rejected:** revocation and device/session management require additional server state anyway, and sensitive session context would be harder to centrally invalidate.

### Permanent bearer token

Rejected categorically because it is non-revocable/long-lived contrary to requirements.

## Reasoning

- PostgreSQL lookup is inexpensive at beta scale and enables immediate revocation.
- Opaque random tokens disclose no user/session claims to the client.
- Cookie flags reduce JavaScript token theft and same-origin architecture simplifies controls.
- Session families/generations provide a path to rotation and replay handling.

## Consequences

### Positive

- Simple authorization context and immediate revocation.
- Active-session UI is backed by authoritative rows.
- No JWT key rotation/claim-staleness problem.
- Password and account status policies can end sessions immediately.

### Negative / risks

- Every authenticated request depends on database/session availability unless a later safe cache is introduced.
- Rotation across tabs and uncertain responses requires careful concurrency design.
- Cookies require robust CSRF defenses.
- User-agent/IP information is approximate and privacy-sensitive.
- A database leak plus live cookie theft still demands monitoring and key/secret incident procedures.

### Required controls

- Constant-time digest comparison through vetted primitives/query behavior.
- Secure random generation; digest domain separation where needed.
- Session fixation, CSRF, replay, concurrent rotation, expiry, revocation, cookie, and cache tests.
- Least-privilege access and log redaction.
- Token/cookie secret rotation procedure and incident runbook.

## Validation before acceptance

- Threat-model token rotation race and previous-token grace precisely.
- Test current browser cookie limits/behavior, PWA installed mode, and same-origin proxy.
- Confirm CSRF design for every state-changing content type/method.
- Load test session lookup and last-seen throttling.
- Approve every lifetime/recent-auth/rotation/replay/password-change value and all selected-branch behavior under `SPEC-AUTH-01`/`02`.
- Approve the event-by-event owner/operator visibility and safe-detail table under `SPEC-SEC-02`; test output-schema separation and accessibility/content.
- Retain versioned `AUTH-VRF`, `AUTH-POL`, and `SEC-HIST` evidence with named approvers/date/review trigger; a role label or passing build is insufficient.

## Revisit when

- Native clients are promoted;
- API becomes cross-origin or third-party accessible;
- measured database session lookup becomes a bottleneck;
- MFA/step-up authentication changes assurance requirements.
