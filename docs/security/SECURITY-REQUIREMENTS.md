# KFin Security Requirements

**Status:** Draft — review required<br>
**Version:** 0.1<br>
**Applies to:** Web/PWA, API, worker, PostgreSQL, edge, CI/CD, providers, operator access<br>
**Risk posture:** Sensitive personal and financial data; fail closed for identity, authorization, and financial writes

No control in this document is currently implemented or verified. Requirement language defines the release target; evidence is required by the test strategy and release checklist.

## 1. Security objectives

1. **Confidentiality:** A user, attacker, provider, or operator cannot access financial/security data beyond explicitly authorized need.
2. **Integrity:** Financial/authentication state cannot be changed, duplicated, or falsely represented without authorized, attributable action.
3. **Availability:** Abuse and ordinary failures do not make the service unrecoverable or corrupt committed data.
4. **Accountability:** Security-sensitive and high-integrity actions have sanitized, reviewable evidence.
5. **Privacy:** Collect, expose, retain, and share the minimum data required for the approved product.
6. **Recoverability:** Backups and releases can be restored/rolled back through tested procedures.

## 2. Security principles

- Deny by default and least privilege.
- Authenticate and authorize on the server for every private request.
- Never trust client identifiers, totals, status, ownership, or derived values.
- Layer controls at edge, application, database, session, provider, and operations boundaries.
- Use vetted cryptographic libraries and platform primitives; no custom crypto.
- Do not weaken a control to make a test or demo pass.
- Generic external errors; specific sanitized internal evidence.
- Secrets are replaceable and short-lived where practical.
- Financial truth and notification delivery are separate.
- Security-relevant configuration changes are reviewed and auditable.

## 3. Data classification

| Class | Examples | Minimum handling |
|---|---|---|
| Restricted secrets | Password input/hash, OTP/reset/session/invite token, cookie, provider/API keys, DB credentials, signing/encryption keys | Never log/analytics; encrypted transit/storage; tightly scoped access; digest-only bearer/challenge storage; rotation/revocation |
| Highly sensitive personal/financial | Email, financial amounts/records/notes, debt, balances, goals, IP/security history, backup contents | Authenticated owner/approved operator only; no shared cache; encryption; minimal provider exposure; auditable access |
| Sensitive operational | Internal user/resource IDs, job/error context, deployment metadata, audit metadata | Restricted tools/logs; retention; no public errors |
| Public | Marketing/public auth copy, static assets, approved policies | Integrity controls and safe caching still apply |

Financial values and note text MUST NOT be sent to session replay, advertising, third-party product analytics, or routine logs.

## 4. Governance and security assurance

| ID | Requirement |
|---|---|
| SEC-GOV-01 | Every implementation issue MUST link relevant security and threat IDs. |
| SEC-GOV-02 | Security-sensitive architecture decisions MUST have an accepted ADR and named owner. |
| SEC-GOV-03 | Production access, incident response, vulnerability triage, backup, restore, and secret rotation MUST have named accountable owners before beta. |
| SEC-GOV-04 | Risk acceptance MUST document scenario, compensating controls, owner, expiry/review date, and approver; critical data-isolation risk cannot be silently accepted. |
| SEC-GOV-05 | Providers handling user/security data MUST be inventoried with purpose, location, access, retention, contract/subprocessor status, and exit plan. |
| SEC-GOV-06 | Privacy/legal requirements, consent/terms, deletion, retention, and user-rights handling MUST be approved before external beta. |
| SEC-GOV-07 | Threat model MUST be reviewed for every material auth, data, deployment, provider, or mobile change. |

## 5. Transport, edge, and network security

| ID | Requirement |
|---|---|
| SEC-NET-01 | Production MUST use HTTPS for every public request; HTTP redirects safely to HTTPS and no sensitive endpoint is served in plaintext. |
| SEC-NET-02 | TLS MUST use currently supported secure protocol/ciphers (minimum TLS 1.2, prefer TLS 1.3) with automated certificate renewal and expiry alerting. |
| SEC-NET-03 | HSTS MUST be enabled after domain/subdomain readiness is verified; preload requires separate review to avoid irreversible outage. |
| SEC-NET-04 | Cloudflare (or approved equivalent) MUST provide DDoS protection, WAF baseline, request/body limits, and coarse abuse controls; edge controls do not replace app controls. |
| SEC-NET-05 | Origin bypass MUST be prevented where practical through private networking, firewall/allowlist, authenticated origin pull, or equivalent. Trusted proxy headers MUST be accepted only from trusted hops. |
| SEC-NET-06 | PostgreSQL MUST NOT be publicly exposed. App-to-database traffic MUST use private/restricted network paths and TLS. |
| SEC-NET-07 | Egress to email/telemetry/package/deployment providers SHOULD be constrained to required destinations where platform capability permits. |
| SEC-NET-08 | Staging and production MUST use distinct credentials, databases, domains/origins, and access controls. |

## 6. Authentication requirements

| ID | Requirement |
|---|---|
| SEC-AUTH-01 | Passwords MUST be hashed with Argon2id using unique salts and benchmarked current OWASP-aligned parameters; plaintext/reversible/fast hashes are forbidden. |
| SEC-AUTH-02 | Password input MUST support paste, managers, and autofill; policy MUST reject common/compromised values through a privacy-reviewed method and MUST NOT force arbitrary periodic changes. |
| SEC-AUTH-03 | Proposed password bounds are minimum 12 and maximum at least 128 Unicode characters; normalization/truncation behavior MUST be explicit and lossless to the user. Final values require review. |
| SEC-AUTH-04 | Login/register/recovery responses and timing MUST not reliably reveal whether an email exists, is verified, invited, locked, or disabled. |
| SEC-AUTH-05 | Email verification OTP MUST be cryptographically random, purpose-bound, single-use, expiring, attempt-limited, supersession-aware, and stored only as a keyed digest/hash. |
| SEC-AUTH-06 | Password-reset secret MUST have high entropy, be purpose-bound, single-use, short-lived, and digest-only at rest. It MUST be removed from browser URL/history as early as safely possible. |
| SEC-AUTH-07 | OTP/reset/invite secrets MUST NOT appear in logs, analytics, referrers, error trackers, support tools, or provider callback URLs. |
| SEC-AUTH-08 | Password reset MUST atomically or fail-safely replace credentials, consume the challenge, revoke all sessions, and create a security event. |
| SEC-AUTH-09 | Password change MUST require current-password verification or approved recent step-up, apply abuse controls, revoke other sessions, and rotate/end current session per approved policy. |
| SEC-AUTH-10 | Authentication success MUST not preserve any pre-authenticated session identifier (session fixation prevention). |
| SEC-AUTH-11 | Account status and verified-email requirements MUST be checked during session use, not only login. |
| SEC-AUTH-12 | MFA MUST NOT be improvised into MVP; schema/interfaces MAY preserve an extension point and a future specification MUST threat-model enrollment/recovery. |
| SEC-AUTH-13 | Plaintext OTP/reset secrets MUST NOT be stored in the ordinary outbox. Under the proposed MVP path they exist only in request-process memory for immediate provider submission after digest-only challenge commit; any asynchronous encrypted-envelope alternative requires a separate key-management review. |

Proposed OTP baseline—10-minute expiry, five attempts, 60-second resend cooldown, target/IP hourly and daily caps—is pending validation and tuning. Rate-limit messages remain generic.

## 7. Session and CSRF requirements

| ID | Requirement |
|---|---|
| SEC-SES-01 | Web/PWA sessions MUST use at least 256 bits of random opaque token material and store only token digest server-side. |
| SEC-SES-02 | Cookie MUST be host-only (`__Host-` where possible), `HttpOnly`, `Secure`, `Path=/`, and reviewed `SameSite` (proposed `Lax`); it MUST contain no personal claims. |
| SEC-SES-03 | Session token MUST NOT enter localStorage, sessionStorage, IndexedDB, service-worker cache/message, URL, DOM data attribute, or log. |
| SEC-SES-04 | Server MUST enforce idle and absolute expiration and revocation every request. Proposed values are 30-day idle / 90-day absolute pending review. |
| SEC-SES-05 | Token rotation MUST be atomic and race-safe across tabs; retired-token replay outside bounded grace MUST trigger containment/audit behavior. |
| SEC-SES-06 | Logout MUST revoke server state before/with cookie clearing. Logout-all and password-reset invalidation MUST be atomic and immediately enforceable. |
| SEC-SES-07 | State-changing browser requests MUST validate allowed Origin/Fetch Metadata and an unpredictable CSRF token bound to the session or equivalent approved pattern. SameSite alone is insufficient. |
| SEC-SES-08 | Sensitive operations MUST require recent authentication where threat review indicates, and MUST never rely solely on an old persistent session. |
| SEC-SES-09 | Authenticated responses MUST use `Cache-Control: no-store`; browser/service-worker/shared caches MUST NOT retain private API payload. |
| SEC-SES-10 | Session list/history MUST reveal no bearer secret and only privacy-approved approximate device/network metadata. |

## 8. Authorization and data isolation

| ID | Requirement |
|---|---|
| SEC-AZ-01 | Every private endpoint and background action MUST have an explicit authentication and authorization policy; default is deny. |
| SEC-AZ-02 | User identity MUST come only from validated server session/context. Client-provided `userId`, email, role, owner, or account scope MUST NOT determine access. |
| SEC-AZ-03 | Every financial/private query and mutation MUST scope by authenticated `user_id`, including nested resources, batch operations, exports if added, and error paths. |
| SEC-AZ-04 | Parent-child writes MUST verify same-user ownership; composite database constraints SHOULD enforce it. |
| SEC-AZ-05 | Unowned and nonexistent identifiers MUST return equivalent safe behavior and MUST NOT leak existence through content/timing where practical. |
| SEC-AZ-06 | Mass-assignment MUST be prevented through explicit input schemas and field allowlists. Ownership, audit, status, derived totals, and privileged fields are never client-settable. |
| SEC-AZ-07 | Operator/support access MUST use separate least-privilege identity, MFA at provider/control plane, explicit purpose, and immutable audit; no shared admin account. |
| SEC-AZ-08 | Automated BOLA/IDOR tests MUST cover every resource × method × nested relation using at least two users. |
| SEC-AZ-09 | PostgreSQL RLS is proposed as defense in depth; if omitted, accepted ADR/risk documentation and compensating architecture tests are required. |

## 9. Input, API, and application security

| ID | Requirement |
|---|---|
| SEC-APP-01 | Server MUST validate path/query/header/body type, format, length, range, enum, relationship, and semantic invariant before use. Client validation is UX only. |
| SEC-APP-02 | SQL MUST use parameterized query/ORM bindings. Dynamic identifiers/order/filter fields MUST be allowlisted; raw interpolation is forbidden. |
| SEC-APP-03 | React/default output encoding MUST be preserved. Any rich HTML rendering requires explicit sanitizer and security review; `dangerouslySetInnerHTML` is prohibited by default. |
| SEC-APP-04 | Financial values MUST use checked integer arithmetic, currency consistency, positive magnitude rules, and overflow bounds. Client-supplied aggregate/balance is never authoritative. |
| SEC-APP-05 | Financial create/confirm requests MUST support idempotency; same key/different payload is rejected and uncertain response can be recovered safely. |
| SEC-APP-06 | Linked multi-record financial/security actions MUST use database transactions and version/concurrency checks. |
| SEC-APP-07 | API request bodies, headers, query strings, uploads (if ever added), result pages, and error messages MUST have bounded sizes. File upload is not in MVP. |
| SEC-APP-08 | API MUST use stable safe errors and correlation IDs. Production MUST NOT expose stack trace, SQL, filesystem, secret, provider credential, or another user’s data. |
| SEC-APP-09 | Collection APIs MUST use bounded pagination; report/date ranges and occurrence generation MUST have hard limits. |
| SEC-APP-10 | CORS MUST deny cross-origin access by default. If allowed later, exact origins/methods/headers are allowlisted and credentialed wildcard is forbidden. |
| SEC-APP-11 | Content types MUST be explicit; unexpected/mixed content is rejected; JSON parser/prototype pollution risks are tested. |
| SEC-APP-12 | Redirects and return URLs MUST be local/allowlisted to prevent open redirect and secret leakage. |
| SEC-APP-13 | Email/template output MUST escape untrusted content and prohibit header injection. User notes are not included by default. |

## 10. Browser security headers

Production responses MUST have route-appropriate headers. Proposed baseline:

- `Content-Security-Policy` with `default-src 'self'`, restrictive explicit script/style/connect/img/font sources, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, and no `unsafe-eval`; nonces/hashes preferred over unsafe inline code.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: no-referrer` for auth/reset/private routes (or equally protective reviewed policy).
- `Permissions-Policy` disabling unused camera, microphone, geolocation, payment, USB, etc.
- Clickjacking protection through CSP `frame-ancestors`; legacy `X-Frame-Options: DENY` may be added for defense in depth.
- COOP/CORP/COEP evaluated against required third parties; do not set blindly if it breaks legitimate integrations.
- Sensitive pages are `noindex` and are not embedded.

Header values require automated production-response tests and CSP reporting that does not leak user data.

## 11. Abuse, rate limiting, and availability

| ID | Requirement |
|---|---|
| SEC-ABUSE-01 | Layer Cloudflare/network limits with application subject-aware limits; one layer failing MUST NOT silently remove all protection. |
| SEC-ABUSE-02 | Login controls MUST combine IP/network, normalized-account digest, and global safeguards; successful login does not immediately erase all abuse evidence. |
| SEC-ABUSE-03 | OTP send/verify and password-reset request/consume MUST have separate cooldown, attempt, target, IP/network, and global cost limits. |
| SEC-ABUSE-04 | Expensive endpoints (dashboard ranges, schedule generation, history searches) MUST be bounded, paginated, indexed, and rate controlled. |
| SEC-ABUSE-05 | API body/header/timeouts and concurrent work MUST be bounded; slow-client and application-layer flooding behavior MUST be tested. |
| SEC-ABUSE-06 | Database pools, worker concurrency, queue size/age, recurrence horizon, retries, and email sends MUST have hard limits and alerts. |
| SEC-ABUSE-07 | CAPTCHA or challenge escalation MAY be used only after privacy/accessibility review and MUST not be the sole abuse control. |
| SEC-ABUSE-08 | Rate-limit storage MUST avoid plaintext target leakage and prevent attackers from turning counter creation into unbounded database growth. |
| SEC-ABUSE-09 | Denial responses SHOULD include safe retry guidance and MUST not reveal account state. |

Exact thresholds are configuration reviewed through abuse/load tests; they must not be presented here as proven.

## 12. Database security and integrity

| ID | Requirement |
|---|---|
| SEC-DB-01 | Use separate least-privilege runtime, migration, backup, and operator roles; application role MUST NOT own schema or bypass accepted RLS. |
| SEC-DB-02 | Database access MUST be private/restricted, TLS protected, rotated, and monitored. Shared human credentials are forbidden. |
| SEC-DB-03 | Constraints MUST enforce owner-consistent relationships, money bounds, status/link invariants, and uniqueness for idempotency/deduplication. |
| SEC-DB-04 | Migrations MUST be reviewed, tested from current production schema, bounded for lock duration, and have compatible rollback/forward plan. |
| SEC-DB-05 | Production data MUST NOT be copied to development/test. Test fixtures MUST be synthetic. |
| SEC-DB-06 | Database statements/transactions MUST have timeouts appropriate to endpoint/job and release locks reliably. |
| SEC-DB-07 | Reconciliation checks MUST detect orphan/link/dedup/money inconsistencies without logging private payload. |
| SEC-DB-08 | Direct production data changes MUST be exceptional, approved, scripted/reviewed, backed up, and audited. |

## 13. Secrets and cryptography

| ID | Requirement |
|---|---|
| SEC-KEY-01 | Secrets MUST be stored in managed secret storage/CI protected secrets, never Git, frontend code, image layers, logs, tickets, or docs. |
| SEC-KEY-02 | Secrets MUST be scoped per environment/purpose, least privilege, inventory-owned, rotatable, and have documented rotation/revocation procedures. |
| SEC-KEY-03 | Random values MUST use operating-system cryptographic RNG and vetted libraries. |
| SEC-KEY-04 | Password hashing, token digest, OTP keyed digest, and encryption keys MUST be purpose/domain separated. |
| SEC-KEY-05 | Key rotation MUST permit a bounded transition without permanent acceptance of old credentials. |
| SEC-KEY-06 | Suspected secret exposure MUST trigger immediate revocation/rotation, impact analysis, event review, and incident procedure. |

Application-level encryption of selected fields may be added only with a complete key-management/search/backup/rotation design; ad hoc encryption is prohibited.

## 14. Logging, audit, analytics, and monitoring

| ID | Requirement |
|---|---|
| SEC-LOG-01 | Logs MUST be structured and centrally searchable with environment, release, correlation, route template, safe result code, and timing. |
| SEC-LOG-02 | Passwords, OTP/reset/invite/session tokens, cookies, authorization headers, secrets, raw request/response bodies, notes, and financial values MUST NOT be logged. |
| SEC-LOG-03 | Error tracking and product analytics MUST use allowlisted fields and scrubbing tests. Session replay is disabled for authenticated KFin surfaces. |
| SEC-LOG-04 | Security audit events MUST cover credential/session changes, verification/recovery, access-control denials/signals, operator access, and critical configuration/release actions. |
| SEC-LOG-05 | Audit records MUST be append-oriented, access restricted, time synchronized, retained under policy, and protected from normal application update/delete. |
| SEC-LOG-06 | Alerts MUST be actionable, routed to named responders, tested, and avoid including private payload. |
| SEC-LOG-07 | Failed authorization, token replay, unusual auth volume, queue backlog, backup failure, database exhaustion, and deployment health MUST be observable. |

## 15. PWA and client requirements

| ID | Requirement |
|---|---|
| SEC-PWA-01 | Service worker MUST cache only approved versioned public assets/offline shell and MUST exclude API/auth/private content. |
| SEC-PWA-02 | Offline/Background Sync MUST NOT queue financial mutations in MVP. |
| SEC-PWA-03 | Source maps MUST not be publicly exposed unless safely uploaded to restricted error tooling and excluded from public artifact. |
| SEC-PWA-04 | Frontend bundles MUST contain no secret or privileged provider credential. Public configuration is explicitly classified. |
| SEC-PWA-05 | Dependency and service-worker update behavior MUST not discard an in-progress form or run an incompatible stale client indefinitely. |
| SEC-PWA-06 | Third-party browser scripts are prohibited by default. Any exception requires privacy/security review, CSP update, integrity/loading plan, and data-flow documentation. |

## 16. Email and provider security

| ID | Requirement |
|---|---|
| SEC-EMAIL-01 | Sending domain MUST configure SPF, DKIM, and DMARC and monitor deliverability/abuse. |
| SEC-EMAIL-02 | Email provider credentials/webhooks MUST be least-privilege, authenticated, rotated, and environment-separated. |
| SEC-EMAIL-03 | Provider callbacks MUST verify signature/timestamp, prevent replay, validate schema, and be idempotent. |
| SEC-EMAIL-04 | Email subjects/previews MUST minimize sensitive content; secrets expire and are single-use; reminder amount inclusion requires privacy approval. |
| SEC-EMAIL-05 | Provider message/log retention and subprocessor region MUST align with approved privacy/residency policy. |
| SEC-EMAIL-06 | Delivery status MUST never be treated as proof of payment or user action. |

## 17. Backup, recovery, and operational security

| ID | Requirement |
|---|---|
| SEC-OPS-01 | Production database MUST have automated encrypted backups with failure alerting and provider/account access controls. |
| SEC-OPS-02 | Restore MUST be tested in an isolated production-like environment before beta and on an approved recurring schedule; a backup is not considered valid without restore evidence. |
| SEC-OPS-03 | Proposed beta RPO ≤ 24h and RTO ≤ 8h require product approval and measured validation. |
| SEC-OPS-04 | Deployment MUST use immutable identified artifacts, gated CI, dependency lockfile, staging smoke/security checks, and a tested rollback/forward plan. |
| SEC-OPS-05 | Control-plane/production operator accounts MUST use MFA, least privilege, no sharing, periodic review, and audit logs. |
| SEC-OPS-06 | Break-glass access MUST be limited, monitored, tested, and reviewed after use. |
| SEC-OPS-07 | Incident response MUST define severity, triage, containment, evidence handling, communication, regulatory/user notification decision, recovery, and postmortem. |
| SEC-OPS-08 | Backup exports, restore environments, logs, and dead-letter payloads MUST receive the same classification/access/retention protection as source data. |

## 18. Secure development and supply chain

| ID | Requirement |
|---|---|
| SEC-SDLC-01 | Pull requests MUST receive review; protected branch/release permissions and required checks MUST prevent unreviewed production deployment. |
| SEC-SDLC-02 | CI MUST run formatting/lint/type/unit/integration checks, secret scanning, dependency vulnerability/license checks, and SAST appropriate to the stack. |
| SEC-SDLC-03 | Dependencies MUST be minimal, locked, provenance-reviewed, routinely updated, and monitored; install scripts and abandoned packages require scrutiny. |
| SEC-SDLC-04 | Container/base/runtime/database versions MUST be supported and patched under a documented severity SLA. |
| SEC-SDLC-05 | DAST and manual security testing MUST cover deployed staging; no scanner may target production without approval/rate bounds. |
| SEC-SDLC-06 | Test failures MUST be fixed or formally risk-accepted; security controls MUST NOT be disabled to obtain green CI. |
| SEC-SDLC-07 | Build artifacts SHOULD have integrity/provenance evidence and MUST be traceable to commit, dependencies, and CI run. |
| SEC-SDLC-08 | Synthetic test data MUST not contain copied user financial or credential data. |

Proposed remediation SLA: critical immediately/block release, high before release or formally time-bounded with release authority only where no user-isolation/credential risk, medium within 30 days, low within 90 days. Final policy requires owner approval.

## 19. Release security gates

Private Beta MUST NOT start unless:

- threat model and security requirements are reviewed;
- no unresolved critical/high vulnerability exists, especially auth/data-isolation issues;
- BOLA/IDOR matrix passes for all private resources;
- password/OTP/reset/session/CSRF/rate-limit test suites pass;
- production headers/TLS/cookies/CORS/cache behavior pass;
- dependency/secret/SAST/DAST results are triaged;
- database is private and roles/access reviewed;
- backup restore and deployment rollback are evidenced;
- logging redaction and error leakage tests pass;
- incident contacts/runbooks and security alert routing are tested;
- retention/privacy/provider decisions are approved.

## 20. Known decisions and limitations

- No MFA in MVP increases residual account-takeover risk; controls and beta invitation limit exposure but do not eliminate it.
- Manual financial data cannot be independently verified.
- Cloudflare/email/hosting/observability provider risks remain until selected and reviewed.
- RLS, exact auth/session thresholds, retention, reminder privacy, and native security are not accepted decisions yet.
- This document is not evidence of compliance with a regulation or security standard.
