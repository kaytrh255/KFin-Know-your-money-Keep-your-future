# KFin Security Requirements

**Status:** Draft — FIN-01/02 controls proposed; approval/evidence required<br>
**Version:** 0.6<br>
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
| SEC-NET-04 | Cloudflare MUST provide DDoS protection, WAF baseline, request/body limits, and coarse abuse controls; edge controls do not replace app controls. Replacing it requires a dated decision change. |
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
| SEC-AUTH-14 | Private Beta invitation codes MUST be high-entropy, purpose-bound, expiring, single-use, digest-only at rest, abuse-limited, and atomically consumed with pending-account creation. Invalid/expired/used/wrong-email states MUST remain generic externally. |
| SEC-AUTH-15 | Every Private Beta registration MUST present and consume a valid invitation code. Email binding may restrict a code, but a server-side email allowlist MUST NOT grant admission or bypass code validation. |
| SEC-AUTH-16 | Successful verification MUST follow exactly one approved `SPEC-AUTH-01` branch: issue a fresh rotated authenticated session or issue no authenticated session and require explicit sign-in. No pre-authenticated identifier may be promoted, and cookies/CSRF/events/multi-tab/uncertain-response behavior MUST be explicit before implementation. |
| SEC-AUTH-17 | Every `SPEC-AUTH-02` invitation, password, OTP, reset, login-abuse, lifetime, rotation/replay, and known-password-change value/behavior MUST have named Security + Product approval and linked evidence. Proposed examples/framework defaults are not approved policy. |

Proposed OTP baseline—10-minute expiry, five attempts, 60-second resend cooldown, target/IP hourly and daily caps—is pending validation and tuning. Rate-limit messages remain generic. `SPEC-AUTH-01` and `SPEC-AUTH-02` remain **OPEN — decision ready**; Round 3 did not select a verification outcome or approve these baseline values.

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
| SEC-APP-14 | Balance-snapshot identity/effect MUST be server validated. Clients MUST NOT arbitrarily mark a transaction historical/current or attach it to another user/segment. Under proposed `account_financial_serialization.v1`, snapshot/transaction/correction/domain writes lock the owner-scoped account row first at `READ COMMITTED`, then revalidate expected financial-state version/latest snapshot before child locks. |
| SEC-APP-15 | Historical-only transactions MUST never enter current-balance arithmetic; old snapshot segments MUST not be replayed into the latest balance. Proposed `snapshot_correction.v1` requires append-only void + replacement, immutable owner/account/currency/kind/anchor/effect, authoritative consequence preview, required reason, authorization, stale-state checks, idempotency, and audit. Cross-segment/effect requests are rejected without mutation. `SPEC-FIN-01` approval remains open. |
| SEC-APP-16 | Safe-to-spend MUST use the authoritative latest-snapshot-segment balance, eligible unpaid outgoing occurrences through current user-local month-end, and active goal current amounts only. Projected income inclusion and double subtraction of already-confirmed outgoings are forbidden; negative results remain signed. |
| SEC-APP-17 | Debt processing MUST NOT infer principal, interest, fee, accrued interest, amortization, payoff, or lender outstanding. Unsafe historical payment correction/recomputation MUST be blocked under `SPEC-DEBT-01`, not approximated. |
| SEC-APP-18 | Reminder workers MUST recheck current occurrence state and enforce occurrence + stage uniqueness. App lifecycle cannot trigger reminders or financial state; recovery from downtime/late creation/timezone change permits no multi-stage burst and remains subject to `SPEC-REM-01` selection policy. |
| SEC-APP-19 | Proposed `account_financial_serialization.v1` MUST produce one complete winner and operation-specific stale loser, increment `financial_state_version` once per logical winner, check compatible idempotency result before stale version after the account lock, and prohibit automatic refreshed-state replay. Only SQLSTATE `55P03`, `40P01`, and `40001` may retry once with unchanged request state. Non-retried `57014` and retryable `55P03`/`40P01`/`40001` MUST complete explicit `ROLLBACK` before pool release, timeout/busy return, or a fresh retry transaction; statement failure alone is never rollback proof. Lost commit acknowledgement MUST use same-key recovery or `FINANCIAL_RESULT_UNKNOWN`; it MUST NOT create a new-key duplicate. `SPEC-FIN-02` approval and executed evidence remain open. |

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
| SEC-DB-06 | Database statements/transactions MUST release locks reliably and never perform external I/O while holding the financial account lock. For any pre-`COMMIT` statement failure in an open transaction—including non-retried `57014` and retryable `55P03`/`40P01`/`40001`—explicit awaited `ROLLBACK` through a bounded cleanup scope that survives request cancellation is required before pool release, retry, or mapped response; every retry begins a new PostgreSQL transaction. A failed statement is not whole-transaction rollback proof, and an unconfirmed-clean connection MUST be evicted. Proposed bounds remain 2,000 ms lock wait, 5,000 ms statement timeout, 8,000 ms attempts/cleanup/backoff budget, one `25–75 ms` jittered retry, and one 2,000 ms uncertain-commit recovery attempt. |
| SEC-DB-07 | Reconciliation checks MUST detect orphan/link/dedup/money inconsistencies without logging private payload. |
| SEC-DB-08 | Direct production data changes MUST be exceptional, approved, scripted/reviewed, backed up, and audited. |
| SEC-DB-09 | `SPEC-SEC-01` MUST select either reviewed PostgreSQL RLS coverage/context/roles or explicit compensating controls with residual-risk acceptance. Under either branch, application authorization, same-user constraints, least privilege, deny-by-default, connection-reuse safety, and two-user tests remain mandatory. |
| SEC-DB-10 | Every user, worker, operator, migration/recovery tool, and owning-domain path that mutates covered account financial state MUST obey the same owner-scoped account-first lock/version protocol and global child-lock order. Elevated role, ORM helper, or maintenance path is not a concurrency bypass. |

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
| SEC-LOG-08 | Before any user-facing security-history implementation, `SPEC-SEC-02` MUST classify each event family as user-visible, operator-only, both, or not retained and approve delivery, display, safe fields, and retention. An audit event is not automatically safe or useful for user display. |
| SEC-LOG-09 | User-visible security history MUST NOT disclose passwords/tokens/OTPs, internal detection rules, precise location claims, financial amounts/notes, another user, or reliable account-existence signals. Operator-only fields MUST be excluded from owner-facing queries by explicit output schemas and authorization tests. |

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
| SEC-EMAIL-04 | Email subjects/previews MUST minimize sensitive content; secrets expire and are single-use. Payment-reminder email is prohibited in MVP. |
| SEC-EMAIL-05 | Provider message/log retention and subprocessor region MUST align with approved privacy/residency policy. |
| SEC-EMAIL-06 | Delivery status MUST never be treated as proof of payment or user action. |

### 16.1 Privacy, deletion, and retention

| ID | Requirement |
|---|---|
| SEC-DATA-01 | An account-deletion request MUST require recent authentication/identity verification, enter a 7-day cancellable pending state, and record no reusable authentication secret. |
| SEC-DATA-02 | Post-deadline purge MUST be idempotent, resumable, operator-observable, and driven by an approved first-party/provider deletion map. |
| SEC-DATA-03 | Maximum baselines are 90 days for encrypted backups, 90 days for application logs, and 24 months for minimized security/audit evidence. Legal review MAY shorten them; any extension requires a dated replacement of OQ-18 plus legal, privacy, product, and security approval before collection under the longer period. |
| SEC-DATA-04 | Retained security/audit evidence after purge MUST remove direct identity/financial payload where lawful and use minimum pseudonymous correlation under an approved legal basis. |
| SEC-DATA-05 | A protected restore-exclusion/tombstone register MUST be available independently of the application restore point and MUST prevent backup restoration from reactivating purged users. Restore tests MUST prove use of the current register before activation. |
| SEC-DATA-06 | A deletion cancellation before the deadline MUST be authenticated, audited, race-safe against purge claiming, and produce one unambiguous account state. |
| SEC-DATA-07 | Legal hold/incident exceptions MUST record authority, scope, access, review date, and expiry; they MUST NOT become indefinite informal retention. |
| SEC-DATA-08 | Vietnam-first processing, Southeast Asia region preference, cross-border transfer, and provider retention MUST receive Vietnamese legal/privacy review before external beta. |
| SEC-DATA-09 | `SPEC-DEL-01` cannot close until the request/cancel identity requirements, pending-account/session behavior, complete first-party/provider deletion map, retained-evidence legal basis/expiry, independent restore-exclusion design, legal-hold procedure, provider proof, and restore activation gate are approved and tested. |

The seven-day cancellation and post-deadline active-data purge baseline remains fixed. Round 3 does not decide the request channel, retained fields, legal basis, tombstone key/storage/expiry, legal-hold authority, or provider failure response. Those choices remain **OPEN — decision ready** under `SPEC-DEL-01`.

## 17. Backup, recovery, and operational security

| ID | Requirement |
|---|---|
| SEC-OPS-01 | Production database MUST have automated encrypted backups with failure alerting, provider/account access controls, and enforced maximum 90-day retention under the accepted baseline. |
| SEC-OPS-02 | Restore MUST be tested in an isolated production-like environment before beta and on an approved recurring schedule, using the current independently protected restore-exclusion register before activation; a backup is not considered valid without restore evidence. |
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
- Cloudflare/email/hosting/observability provider risks remain because specific vendors are intentionally deferred until before Release Candidate.
- The extended 90-day backup/log and 24-month security/audit baseline increases privacy/breach impact and remains subject to legal approval and automated deletion tests.
- RLS and exact auth/session thresholds remain architecture/security review decisions; payment reminders are in-app only and native security remains future scope.
- This document is not evidence of compliance with a regulation or security standard.

## 21. Round 3 security closure register

| Blocker | Security approval needed | Accountable / mandatory co-approvers | Required evidence | Security acceptance condition | Status |
|---|---|---|---|---|---|
| `SPEC-AUTH-01` | One post-verification outcome and complete cookie/CSRF/event/multi-tab/uncertain-response contract | Product / Security | Branch threat review; fixation, retry and multi-tab tests; content review | No pre-auth identifier survives; one deterministic outcome exists across flows, ADRs and tests | OPEN — decision ready |
| `SPEC-AUTH-02` | Exact values/behaviors for every auth/session dimension and change authority | Security / Product | Threat/abuse review, Argon2 benchmark, provider assumptions, usability and replay tests | Every proposed value is approved/replaced; boundary/failure expectations are exact and synchronized | OPEN — decision ready |
| `SPEC-SEC-01` | RLS branch with policies/context/roles, or omitted-RLS branch with compensating controls/risk | Security / Data + Architecture | Table/action matrix, pool leakage, worker/operator, two-user tests; residual-risk record if omitted | Every private path is covered, connection reuse is safe, approvers/evidence are recorded in ADR-003 | OPEN — decision ready |
| `SPEC-SEC-02` | Event-family visibility classification, safe fields, delivery/display and retention | Product / Security + Privacy/Legal | Event table, threat/privacy/content/accessibility review and API authorization tests | Every event has one class; operator-only fields cannot leak; all source documents agree | OPEN — decision ready |
| `SPEC-DEL-01` | Complete request/cancel/purge/retention/tombstone/legal-hold/provider contract | Privacy/Legal / Product + Security + Operations | Legal opinion, data map, provider proof, race tests, access/key review, restore drill | Every data category has disposition and restored deleted data cannot activate | OPEN — decision ready |
| `SPEC-GOV-01` | Named security/incident/operations/privacy authorities, evidence control and approved hard bounds | Product / cross-domain owners | Completed governance register, physical limits, sign-offs and traceability | No security-critical role/value/evidence row is unassigned or missing | OPEN — evidence/assignment ready |

Full decision dimensions and binary criteria are in the [Round 3 remediation report](../reviews/SPECIFICATION-REMEDIATION-ROUND-3.md). Required records belong in the [Approval and Evidence Register](../governance/APPROVAL-AND-EVIDENCE-REGISTER.md). This register is documentation, not security evidence.
