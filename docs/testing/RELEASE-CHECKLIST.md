# KFin Private Beta Release Checklist

**Status:** Template — no item is currently complete<br>
**Use:** One copy per release candidate and per cohort expansion<br>
**Rule:** Every checked item requires linked, dated evidence. A checkbox without evidence is not a pass.

## Release record

| Field | Value |
|---|---|
| Release candidate / image digest | _TBD_ |
| Git commit | _TBD_ |
| Schema version | _TBD_ |
| Specification version | _TBD_ |
| Target environment | _TBD_ |
| Target cohort | Internal / 5 / 10 / 25 / 50 |
| Planned time | _TBD_ |
| Release owner | _TBD_ |
| Security reviewer | _TBD_ |
| Product/UX reviewer | _TBD_ |
| Operations/on-call owner | _TBD_ |
| Rollback decision owner | _TBD_ |

## 1. Specification and scope gate

- [ ] PRD, MVP scope, user flows, UX, screen inventory, architecture, database, security, threat model, and test strategy are approved at recorded versions. Evidence: _link_
- [ ] OQ-01 through OQ-19 decisions are reflected consistently; OQ-17 provider deferral has been resolved before this Release Candidate. Evidence: _link_
- [ ] Required ADRs are `Accepted` with role-based approvers; no implementation silently depends on a `Proposed`, `Blocked`, or rejected decision, and every centralized `SPEC-*` blocker is closed. Evidence: _link_
- [ ] Implemented scope matches MVP; future items have not entered release accidentally. Evidence: _link_
- [ ] Every release item maps to requirements, tests, and user-visible release notes where applicable. Evidence: _link_
- [ ] Known limitations and manual-data/estimate language are accurate. Evidence: _link_

## 2. Product and financial correctness

- [ ] Current balance reconciles to the latest immutable snapshot plus only current-impact transactions in that segment. Evidence: _link_
- [ ] Historical-only backfill appears in period/category reports, is visibly labelled, and never silently changes current balance. Evidence: _link_
- [ ] Balance-snapshot scenarios A–G pass; `SPEC-FIN-01` is resolved for H–I and `SPEC-FIN-01`/`SPEC-FIN-02` are resolved for J before those correction/race paths are implemented and tested. Evidence: _link_
- [ ] Snapshot creation versus transaction creation/correction race tests yield one approved deterministic segment/result without implicit re-anchoring. Evidence: _link_
- [ ] Monthly income/outflow respects user-local month, status, currency, and exact integer arithmetic. Evidence: _link_
- [ ] The 4,000,000 + 350,000 + 280,000 VND income scenario produces 4,630,000 VND only under approved confirmation semantics. Evidence: _link_
- [ ] Scheduled income/obligations never become actual/paid solely because time passes. Evidence: _link_
- [ ] Global Add retry/parallel/timeout cases create exactly one transaction. Evidence: _link_
- [ ] Transaction edit/correction/removal policy updates aggregates and linked records consistently. Evidence: _link_
- [ ] Debt cases `DCT-01`–`DCT-09` pass under the approved `SPEC-DEBT-01` disposition; no path infers principal, interest, fee, accrued interest, amortization, payoff, or lender outstanding. Evidence: _link_
- [ ] Manual savings current amount/as-of changes safe-to-spend but not cash/monthly flow; every update has one old/new audit record. Evidence: _link_
- [ ] Planned purchase completion applies at most one user-confirmed linked-goal scalar deduction within bounds and never auto-archives/zeroes the goal. Evidence: _link_
- [ ] Safe-to-spend cases `STS-01`–`STS-15` pass: authoritative balance minus eligible unpaid outgoings through user-local month-end minus active-goal current amounts; projected income is excluded, payment is not double-subtracted, and negative result remains signed. Evidence: _link_
- [ ] Safe-to-spend and cash-flow warning show approved inputs, formula version, local horizon, exclusions, snapshot/as-of time, and source drill-down. Evidence: _link_
- [ ] Dashboard aggregates drill down exactly to source records; zero/no-data/not-calculated states differ. Evidence: _link_
- [ ] Monthly 29/30/31 uses last-day fallback; yearly 29-February, interval/end/window bounds, and timezone changes meet separately approved rules. Evidence: _link_

## 3. UX, responsive, and accessibility

- [ ] Core screens match approved compact and expanded designs/design tokens. Evidence: _link_
- [ ] Basic mobile expense entry meets agreed usability task completion/clarity target. Evidence: _link_
- [ ] Bottom navigation, global Add, keyboard, safe areas, scrolling, focus, and numeric/date input pass representative iOS/Android testing. Evidence: _link_
- [ ] Every critical screen has reviewed loading, refresh, empty, filtered-empty, offline, validation, authorization, server-error, and success states. Evidence: _link_
- [ ] Keyboard-only review passes all core flows with visible, unobscured focus. Evidence: _link_
- [ ] Screen-reader review passes approved VoiceOver and NVDA combinations. Evidence: _link_
- [ ] Automated axe-core suite has no untriaged serious/critical issue. Evidence: _link_
- [ ] 200% zoom, 400% reflow, 320 px viewport, long labels, and large VND values do not block tasks. Evidence: _link_
- [ ] Color contrast, non-color status cues, reduced motion, and touch target review pass. Evidence: _link_
- [ ] Destructive/security/financial confirmations state exact consequence and restore focus correctly. Evidence: _link_
- [ ] Usability sessions confirm users understand actual/projected/reserved/estimated/overdue distinctions. Evidence: _link_

## 4. Authentication and session security

- [ ] Mandatory single-use invitation-code digest, expiry/revoke/wrong-email/replay/parallel-use, generic errors, and atomic account creation tests pass; registration without a valid code fails even for an email present in operator data, proving no email-allowlist admission path. Evidence: _link_
- [ ] Registration eligibility, email normalization, and post-verification sign-in/session behavior match approved policy. Evidence: _link_
- [ ] Argon2id parameters are benchmarked, encoded correctly, and rehash policy is tested. Evidence: _link_
- [ ] Password policy supports managers/paste and common/compromised-password control is privacy reviewed. Evidence: _link_
- [ ] OTP expiry, attempt, resend, supersession, keyed-digest storage, replay, concurrency, immediate delivery uncertainty, and ordinary-outbox secret exclusion tests pass. Evidence: _link_
- [ ] Forgot/reset request is enumeration-resistant; reset secret is single-use, not logged/referrer-exposed, and expires. Evidence: _link_
- [ ] Password reset revokes all sessions; known-password change applies approved current/other-session policy. Evidence: _link_
- [ ] Cookie flags/name/domain/path, idle/absolute expiry, rotation, fixation, tab races, retired-token replay, and current/all logout pass. Evidence: _link_
- [ ] No password, OTP, reset/invite/session token exists in logs, analytics, URL/history, client storage, cache, build, or error tooling. Evidence: _link_
- [ ] Recent-auth requirements and security-history events match policy. Evidence: _link_
- [ ] Auth abuse/rate-limit tests resist bypass and do not become a reliable account-enumeration signal. Evidence: _link_

## 5. Authorization, API, and application security

- [ ] Full BOLA/IDOR matrix passes for every private resource, method/action, nested parent, and two-user case. Evidence: _link_
- [ ] Server identity never comes from client `userId`; owner/status/derived/audit/snapshot-anchor/balance-effect fields resist mass assignment. Evidence: _link_
- [ ] Old/latest snapshot, historical/current effect, same-day inclusion, and cross-user anchor tampering tests pass. Evidence: _link_
- [ ] Same-user composite constraints and accepted RLS/compensating controls are verified under connection pooling and worker paths. Evidence: _link_
- [ ] CSRF cross-site form/fetch and Origin/Fetch Metadata/token tests pass for every state-changing browser endpoint. Evidence: _link_
- [ ] CORS is deny-by-default/same-origin and credentials are never combined with wildcard origin. Evidence: _link_
- [ ] SQL injection, XSS, template/header/log injection, malformed JSON/prototype, open redirect, and body/range limit tests pass. Evidence: _link_
- [ ] Security headers/CSP/referrer/clickjacking/no-sniff/permissions/no-store are correct on deployed production-like responses. Evidence: _link_
- [ ] Production errors expose only safe code/message/correlation ID; no stack/SQL/path/provider/private data. Evidence: _link_
- [ ] SAST, dependency/SBOM/license, secret, container, and DAST reports are complete and triaged. Evidence: _link_
- [ ] Focused manual security review/penetration testing has no unresolved release-blocking finding. Evidence: _link_

## 6. Database, migrations, and data lifecycle

- [ ] Production database is private/restricted, TLS protected, encrypted, and uses separate least-privilege runtime/migration/operator roles. Evidence: _link_
- [ ] Schema constraints, indexes, ownership links, currency/money bounds, idempotency, and deduplication match the approved model. Evidence: _link_
- [ ] Migration applies from current production schema on representative volume within approved lock/time budget. Evidence: _link_
- [ ] App/worker versions are compatible through rollout; expand/migrate/contract steps are scheduled. Evidence: _link_
- [ ] Migration rollback or forward-recovery procedure is rehearsed and tied to decision thresholds. Evidence: _link_
- [ ] Reconciliation checks find no unexplained orphan, duplicate, link, debt, savings, occurrence, or balance issue. Evidence: _link_
- [ ] Vietnamese legal/privacy review approves deletion map/request channel/cross-border processing and either the OQ-18 maxima (90d backup, 90d log, 24mo minimized security/audit) or documented shorter enforced periods. Evidence: _link_
- [ ] Seven-day deletion request/cancel/purge races, provider deletion, independent restore-exclusion register access/key/tamper/expiry, pseudonymized retained evidence, and retention expiry pass. Evidence: _link_
- [ ] Data export/user-rights procedure is owned even though export UI is out of MVP unless legally required. Evidence: _link_
- [ ] No production data is present in staging, CI, developer systems, test reports, or screenshots. Evidence: _link_
- [ ] Direct data access/change and break-glass procedures are restricted, MFA-protected, and audited. Evidence: _link_

## 7. PWA, browser, and cache security

- [ ] Manifest, icons, start URL, install, update, and supported-browser behavior pass. Evidence: _link_
- [ ] Service worker caches only approved versioned public assets/offline shell. Evidence: _link_
- [ ] API/auth/private data and tokens are absent from Cache Storage, IndexedDB, service-worker messages, browser/shared CDN cache, and back/forward cache where controllable. Evidence: _link_
- [ ] Offline state never claims/queues a financial write; reconnection/retry remains idempotent. Evidence: _link_
- [ ] Service-worker update does not discard an in-progress form and stale clients remain API-compatible through rollout. Evidence: _link_
- [ ] Cloudflare does not cache authenticated/API responses and direct origin cannot bypass required controls. Evidence: _link_
- [ ] Public bundle/source-map/config inspection finds no secret or private environment value. Evidence: _link_

## 8. Notifications and email

- [ ] Eligible outgoing-obligation stages occur at 09:00 user-local time for 7-day/3-day/due-today/first-overdue with one occurrence + stage notification; scheduled income has none. Evidence: _link_
- [ ] First-overdue does not repeat, while Schedule remains visibly overdue until resolved. Evidence: _link_
- [ ] No payment-reminder email, push, SMS, quiet-hour/channel preference, or permission path exists in MVP. Evidence: _link_
- [ ] Reminder cases `RCT-01`–`RCT-10` pass for worker downtime, closed app, late occurrence creation, timezone change, delayed return, retries, and multiple missed stages. Evidence: _link_
- [ ] Approved `SPEC-REM-01` policy selects at most one catch-up stage, if any, per occurrence/recovery evaluation; no multi-stage burst occurs and suppressed-stage handling is evidenced. Evidence: _link_
- [ ] Confirmation/skip/cancel races do not create stale authoritative state or mark financial truth. Evidence: _link_
- [ ] Vietnamese authentication/security email templates are escaped, accessibility reviewed, and minimize sensitive subject/preview content. Evidence: _link_
- [ ] SPF, DKIM, DMARC, sender domain, bounce handling, provider sandbox/production credentials, and quotas are configured. Evidence: _link_
- [ ] Security-email provider webhook signature/timestamp/replay/schema/idempotency tests pass where applicable. Evidence: _link_
- [ ] Queue age/dead-letter/email failure alerts and operator remediation runbook are tested. Evidence: _link_
- [ ] Notification read/dismiss or email delivery events cannot mark an obligation paid/received. Evidence: _link_

## 9. Performance, reliability, and abuse resistance

- [ ] Approved workload/data profile and performance/SLO targets are recorded. Evidence: _link_
- [ ] Common API read/write latency and error rate meet target under normal and peak beta profile. Evidence: _link_
- [ ] Dashboard/activity/schedule queries have reviewed plans and no unbounded/N+1 behavior. Evidence: _link_
- [ ] Login hashing and application-layer flooding remain bounded without weakening password security. Evidence: _link_
- [ ] Database pool/lock/timeout/storage, idempotency/rate-counter growth, and job backlog exhaustion tests recover safely. Evidence: _link_
- [ ] API body/header/range/pagination/recurrence/retry/concurrency limits are enforced. Evidence: _link_
- [ ] Database/email/worker/observability fault injection produces safe, understandable behavior and no false save. Evidence: _link_
- [ ] Rate limits and Cloudflare WAF/DDoS/origin controls are deployed and bypass-tested within authorization. Evidence: _link_

## 10. Backup, restore, rollback, and disaster readiness

- [ ] Automated encrypted production backup/PITR is enabled, monitored, access restricted, residency compliant, and enforces the 90-day maximum. Evidence: _link_
- [ ] Backup failure alert reaches the named responder. Evidence: _link_
- [ ] A recent backup is restored in isolation; the current independently protected restore-exclusion register is obtained, tombstones are reapplied before activation, and purged users are not resurrected. Evidence: _link_
- [ ] Restored schema, constraints, counts, user isolation, snapshot-segment balances, historical reports, and representative financial reconciliations pass. Evidence: _link_
- [ ] Restored application smoke tests pass against the exact release artifact. Evidence: _link_
- [ ] Measured RPO/RTO meet approved targets or discrepancy has blocking disposition. Evidence: _link_
- [ ] Restored data is securely destroyed and exercise access is audited. Evidence: _link_
- [ ] Previous compatible application artifact rollback is rehearsed; data migration consequence is understood. Evidence: _link_
- [ ] Disaster/region/provider outage procedure and decision authority are documented and table-topped. Evidence: _link_

## 11. Observability and incident readiness

- [ ] Logs are structured, correlated, redacted, retained, access-controlled, and time synchronized. Evidence: _link_
- [ ] Canary scans confirm no secret, note, raw financial amount, cookie, auth header, or request body leaks to logs/errors/analytics. Evidence: _link_
- [ ] Metrics cover API, auth abuse, financial-write failures, DB pool/storage/slow queries, worker queue, email, health, and release. Evidence: _link_
- [ ] Alerts have thresholds, owner, escalation, and runbook; test alerts reach responders. Evidence: _link_
- [ ] Health/readiness endpoints are safe and deployment gates consume them correctly. Evidence: _link_
- [ ] Incident response covers severity, containment, evidence, provider/user/regulatory communication decision, recovery, and postmortem. Evidence: _link_
- [ ] On-call/support coverage is confirmed for the rollout window. Evidence: _link_
- [ ] Privacy-safe product metrics and user-feedback channel are ready; session replay/advertising trackers are absent. Evidence: _link_

## 12. Privacy, legal, provider, and support readiness

- [ ] Vietnam-first jurisdiction/audience, Vietnamese-first content, age/eligibility, Southeast-Asia/cross-border residency, and invitation terms are approved. Evidence: _link_
- [ ] OQ-17 is resolved with selected PaaS/database/email/observability providers, domain, final region, budget, and dated provider ADR addendum. Evidence: _link_
- [ ] Privacy notice, terms, financial-data limitation/estimate disclaimer, support contact, and incident communication templates are approved. Evidence: _link_
- [ ] Data inventory/flow and provider/subprocessor register include hosting, database, email, Cloudflare, observability, CI, and backups. Evidence: _link_
- [ ] Provider contracts/settings/retention/region/security responsibilities are reviewed. Evidence: _link_
- [ ] User access, correction, deletion, and export obligations have an owned procedure even if some UI is out of scope. Evidence: _link_
- [ ] Support cannot request passwords/OTP/session tokens and has an identity-safe escalation process. Evidence: _link_
- [ ] Known limitations, supported browsers, uptime/recovery expectations, and feedback route are communicated. Evidence: _link_

## 13. Deployment go/no-go

- [ ] CI required checks pass on the exact commit; artifact/image digest is immutable and scanned. Evidence: _link_
- [ ] Staging deployment, migration, critical E2E, security headers/cache, email, and smoke tests pass on that artifact. Evidence: _link_
- [ ] Production configuration diff is reviewed; no placeholder/default/debug setting remains. Evidence: _link_
- [ ] Secrets are present in managed storage, scoped, recently validated, and rotation owners are known. Evidence: _link_
- [ ] Current production backup is successful and rollback artifact/procedure is ready. Evidence: _link_
- [ ] Release window, monitoring dashboard, alert routing, support/on-call, and communication channel are active. Evidence: _link_
- [ ] Open defect/risk list is reviewed against cohort; every accepted risk has owner and expiry. Evidence: _link_
- [ ] Product, engineering, security, UX/accessibility, operations, privacy/legal, and release owner record go decision below. Evidence: _link_

## 14. Post-deployment verification

- [ ] Correct release/schema version and healthy instances are visible. Evidence: _link_
- [ ] Non-destructive production smoke passes: public auth page, health, approved test-account login, read, one reversible test action if policy permits. Evidence: _link_
- [ ] Error/latency/DB pool/worker queue/email/auth-abuse metrics remain within expected range. Evidence: _link_
- [ ] No cache/header/CORS/cookie regression appears at real production origin. Evidence: _link_
- [ ] No unexpected migration/reconciliation/security alert occurs. Evidence: _link_
- [ ] Release annotation and monitoring window start are recorded. Evidence: _link_
- [ ] Rollback criteria are reassessed at the end of heightened monitoring. Evidence: _link_

## 15. Cohort expansion gate

- [ ] Current cohort duration and minimum evidence window are met. Evidence: _link_
- [ ] No unresolved S0/S1, data-isolation, credential/session, corruption, or restore defect exists. Evidence: _link_
- [ ] Errors, latency, database, worker, email, auth failure, and support volume remain within approved bounds. Evidence: _link_
- [ ] Financial write failure/reconciliation results have been reviewed. Evidence: _link_
- [ ] User feedback/usability/accessibility concerns have been classified and release blockers resolved. Evidence: _link_
- [ ] Incident/near-miss and risk register review is complete. Evidence: _link_
- [ ] Capacity/cost/on-call/support are sufficient for next cohort. Evidence: _link_
- [ ] Explicit `expand`, `hold`, or `rollback/close` decision is signed below. Evidence: _link_

## 16. Mandatory stop/rollback conditions

Stop release or pause rollout immediately for:

- confirmed/suspected cross-user disclosure or mutation;
- authentication/authorization bypass or exposed credential/session/reset/OTP secret;
- unexplained balance, duplicate financial effect, or unrecoverable data corruption;
- migration causing data loss or incompatible deployed application;
- inability to restore within approved tolerance when recovery is needed;
- uncontrolled error/failure rate or database/resource exhaustion threatening integrity;
- critical supply-chain/provider compromise;
- legal/privacy instruction to stop processing;
- absent incident/on-call ownership during a serious event.

The incident lead decides containment and rollback/forward recovery; preserving evidence must not unnecessarily prolong user harm.

## 17. Sign-off

| Role | Name | Decision | Date | Evidence / conditions |
|---|---|---|---|---|
| Product owner | _TBD_ | Go / Hold / No-go | _TBD_ | _TBD_ |
| Engineering owner | _TBD_ | Go / Hold / No-go | _TBD_ | _TBD_ |
| Security reviewer | _TBD_ | Go / Hold / No-go | _TBD_ | _TBD_ |
| UX/accessibility reviewer | _TBD_ | Go / Hold / No-go | _TBD_ | _TBD_ |
| Operations owner | _TBD_ | Go / Hold / No-go | _TBD_ | _TBD_ |
| Privacy/legal owner | _TBD_ | Go / Hold / No-go | _TBD_ | _TBD_ |
| Release owner | _TBD_ | Go / Hold / No-go | _TBD_ | _TBD_ |

**Final decision:** _Not made_<br>
**Decision time:** _TBD_<br>
**Rollback/monitoring window:** _TBD_
