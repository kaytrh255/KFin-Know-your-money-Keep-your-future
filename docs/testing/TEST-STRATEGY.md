# KFin Test Strategy

**Status:** Draft — review required<br>
**Version:** 0.1<br>
**Release target:** Private Beta, at most 50 users<br>
**Current evidence:** None; no application has been implemented or tested

## 1. Purpose

Testing is an independent verification phase, not a synonym for compilation or successful startup. This strategy defines how KFin will produce evidence that approved product, UX, security, data, operational, and recovery requirements are satisfied.

## 2. Principles

1. Trace tests to requirement, flow, threat, and ADR IDs.
2. Prioritize authentication, authorization, money integrity, schedules, recovery, and private-data leakage by risk.
3. Test observable behavior and invariants, not implementation trivia.
4. Use a real PostgreSQL engine for persistence behavior; an in-memory substitute cannot validate SQL constraints/transactions/RLS.
5. Control time, timezone, randomness, email, and worker execution deterministically.
6. Test failures and concurrency, not only happy paths.
7. A flaky test is a defect; quarantining requires owner, reason, expiry, and equivalent coverage.
8. No production user data in any test environment or artifact.
9. Automated checks complement, not replace, accessibility, UX, security, and recovery review.
10. Never claim `PASS` without a reproducible run and retained evidence.

## 3. Traceability model

Each test or evidence item should reference applicable IDs:

```text
Requirement: PRD-EXP-03, SEC-APP-05
Flow: UF-FIN-02
Threat: TM-15, TM-16
Test: API-TXN-FASTADD-001, E2E-FASTADD-001
Evidence: CI run / report / review record
```

A release traceability report must show every normative MVP requirement as:

- covered and passing;
- covered manually with dated evidence;
- not applicable with rationale; or
- open/blocking.

Missing mapping is not implicitly passing.

## 4. Test environments

| Environment | Purpose | Data | External services |
|---|---|---|---|
| Local | Developer feedback | Synthetic factories | Local/fake email; disposable PostgreSQL |
| CI isolated | Unit/component/integration/API/security automation | Deterministic synthetic, per-run database | Fakes/contract stubs; no real user email |
| Staging | Deployed E2E, DAST, headers, cache, provider sandbox, migration, performance | Synthetic seeded personas | Email sandbox/test domain; staging-only telemetry |
| Recovery exercise | Restore/rollback validation isolated from normal staging | Encrypted test backup or approved synthetic production-like set | Restricted; destroyed after exercise |
| Production | Post-deploy smoke and monitoring only; no destructive scanner/load test | Real beta data | Production providers |

Production credentials/data must never be available to routine CI. Environment banners and telemetry labels prevent confusion.

## 5. Test levels

### 5.1 Static and build verification

- Formatting, lint, strict TypeScript, dead/unreachable boundary rules.
- Dependency/module architecture tests prevent forbidden cross-module imports.
- API schema generation and compatibility checks.
- Migration lint/review rules.
- Secret scanning, dependency vulnerability/license/provenance checks, SAST.
- Reproducible production build and bundle inspection for secrets/source maps.
- Design-token/component usage checks where reliable.

Static success never replaces runtime tests.

### 5.2 Unit tests

Fast deterministic tests for domain/application logic without network or real database where persistence semantics are not the subject.

Priority units:

- integer-money addition/subtraction/bounds/format-contract conversion;
- current-balance and selected-month formula, including the approved opening-date/backdating cutoff;
- spendable-estimate formula/version after approval;
- classification and no-double-counting rules;
- recurrence next-date generation including 29/30/31, leap day, end date, timezone policy;
- due/due-today/overdue derived state;
- debt split reconciliation, outstanding update/correction, and no-split behavior that never assumes principal;
- savings allocation derivation and target progress;
- planned-purchase transition and linked-goal release rules, including partial/no release and no double counting;
- challenge/session expiry, rotation state machine, and password policy;
- reminder stage/dedup/cash-flow warning fingerprint;
- log/telemetry redaction helpers.

Use table-driven and property-based tests for money/date/state invariants. A code-coverage percentage is a diagnostic, not the release goal; critical rules require branch and boundary coverage regardless of aggregate percentage.

### 5.3 UI component and design-system tests

- Semantic role/name/state/value and keyboard behavior.
- Focus-visible, focus trap/restore, dialog/sheet escape/back behavior.
- Error summary and live-region announcements.
- Money/date overflow, long translated labels, 200% zoom layouts.
- Component variants/states through Storybook or equivalent isolated harness if adopted.
- Automated axe-core checks plus visual regression at representative compact/expanded sizes.
- Reduced-motion and high-contrast/forced-color behavior where supported.

Visual snapshots must be reviewed; they cannot approve accessibility or UX automatically.

### 5.4 Database and integration tests

Run against the supported PostgreSQL version in disposable isolated databases.

- Migrations apply from empty and from the previous release; constraints/indexes/RLS exist as specified.
- Money, currency, owner-composite, status/link, uniqueness, and version constraints reject invalid writes.
- Transactions roll back fully at injected failure points.
- Concurrent confirm/payment/correction/idempotency requests produce one valid result.
- Session rotation/revocation and challenge consumption are race-safe.
- Outbox insertion is atomic with domain writes.
- Worker lease/crash/reclaim/retry/dead-letter and duplicate execution are safe.
- Repository methods cannot omit tenant context; RLS pool context does not leak between users if accepted.
- Dashboard/month/schedule queries reconcile to seeded source records.
- Query plans use intended indexes under representative per-user volume.

### 5.5 API contract and behavior tests

For every endpoint:

- authentication requirement and session expiry;
- authorization/ownership for own, another user’s, nonexistent, and mismatched parent IDs;
- valid minimum/typical/maximum request and response schema;
- missing/extra/wrong-type/out-of-range/unsupported currency/date/body-size cases;
- mass-assignment and derived-field manipulation;
- content type, method, pagination/range and error envelope;
- idempotency first/retry/different-payload/parallel/expired key;
- optimistic concurrency conflict;
- no secret/private/internal error leakage;
- cache and security headers as appropriate.

OpenAPI is checked against handlers and consumer expectations. Contract compatibility is tested across the intended rolling-deployment window.

### 5.6 Security tests

Security automation and manual review map directly to [the threat model](../security/THREAT-MODEL.md).

#### Authentication and abuse

- Credential-stuffing/brute-force patterns across IP/account/global dimensions.
- Registration/login/reset/OTP enumeration content/status/timing/rate behavior.
- OTP/reset/invite expiry, attempt, resend, supersession, replay, concurrency, immediate secret-delivery uncertainty, and provider failures; verify no secret enters the ordinary outbox.
- Argon2id parameter benchmark and maximum concurrent hashing behavior.
- Password reset/change session invalidation.

#### Session, browser, and client

- Session fixation, idle/absolute expiry, rotation across tabs, retired-token replay, logout current/all.
- Cookie flags/domain/path and no token in URL/storage/log/cache.
- CSRF from form/fetch and missing/forged token/origin; CORS preflight and credential rules.
- CSP/header/clickjacking/referrer/open-redirect/source-map tests.
- Service-worker/Cloudflare/browser cache inspection before/after logout/update.
- Stored/reflected/DOM XSS corpus and email-template injection.

#### Authorization and injection

- Complete BOLA matrix: every private resource × read/create/update/delete/action × two users × nested parent mismatch.
- SQL injection/filter/sort/search corpus; malformed UUID/JSON/prototype fields.
- Direct database/RLS permissions and operator role tests.

#### Data leakage and supply chain

- Canary values injected into secrets, notes, amounts, email, and errors; scan logs/error tracking/analytics/cache/build artifacts.
- Secret scanner, SAST, dependency/SBOM/license, container image scan.
- DAST against staging within approved rate limits.
- Manual code/config/IAM/provider review and focused penetration testing before external beta.

A scanner report is triaged by exploitability and context; zero scanner alerts alone is not proof of security.

### 5.7 End-to-end tests

Playwright (or selected equivalent) runs through the deployed browser/UI/API/database boundary with isolated users.

Critical journeys:

1. Invite/register → OTP verify → onboarding → opening balance.
2. Sign in → close/reopen context → resume session → logout/replay rejected.
3. Forgot/reset password → all old sessions rejected.
4. Global Add expense on compact viewport → retry after simulated timeout → one record.
5. Flexible income + recurring salary confirmation → exact monthly 4,630,000 VND example.
6. Recurring rent reaches due/overdue but not paid → explicit confirmation.
7. Debt create/payment/correction with split and no-split paths.
8. Savings goal contribution/withdrawal with no cash double count.
9. Planned purchase completion creates exactly one actual expense and the approved linked-goal release without double counting.
10. Dashboard aggregates drill down to source records and explain calculation.
11. Cash-flow warning for 1,000,000 VND due versus 700,000 VND available.
12. Session revocation from another context.
13. Network loss/session expiry during form preserves safe draft and never claims save.
14. User A cannot reach User B data through UI/deep links.

E2E tests are few, critical, deterministic, and backed by lower-level coverage—not a replacement for it.

### 5.8 UX, accessibility, and responsive testing

#### Automated

- axe-core on key pages/states.
- keyboard smoke flow.
- layout/visual regression at 320, 375/390, 768, 1024, 1280+ CSS px.
- text scaling/long-content/large-money fixtures.

#### Manual

- Keyboard-only and visible focus review.
- Screen reader: at minimum current VoiceOver/Safari and NVDA/Firefox or approved equivalents.
- 200% zoom and 400% reflow review.
- iOS Safari/PWA and Android Chrome/PWA keyboard, safe-area, orientation, date/numeric input, install/update/offline behavior.
- Color contrast, forced colors where relevant, reduced motion.
- Moderated usability tasks from the UX specification with representative beta users.

WCAG conformance is assessed by people plus tools. Core flow blocker/severe accessibility defects block release.

### 5.9 PWA and future mobile tests

MVP PWA:

- manifest/icon/start URL/display validity;
- install and uninstall on supported platforms;
- asset cache allowlist and authenticated route exclusion;
- offline shell/message with no queued financial write;
- update available during active form and safe activation;
- stale client/API compatibility;
- logout/back/cache/device-sharing inspection;
- no token/private data in Cache Storage/IndexedDB/service-worker messages.

Capacitor/native testing is out of MVP. If promoted, add platform unit/integration, secure storage, deep-link, lifecycle, permission, WebView, signing, store, and real-device tests before claiming support.

### 5.10 Performance, resilience, and abuse testing

The beta is small, but expensive or slow paths can still be attacked or regress.

Proposed service objectives under an agreed staging profile (warm service, representative dataset, normal network, 20 concurrent active requests unless a better measured model is approved):

| Measure | Proposed target |
|---|---|
| API read p95 | ≤ 500 ms server response for common Home/Activity/Schedule queries |
| API write p95 | ≤ 750 ms excluding external email; Global Add commits locally without waiting for provider |
| Error rate | < 1% non-user-error during controlled load |
| Page initial usable state | Define by device/network budget after prototype; measure Core Web Vitals, not an invented pass now |
| Worker normal reminder lag | ≤ 5 minutes from scheduled evaluation time under normal conditions |
| Recovery | RPO ≤ 24h / RTO ≤ 8h proposal, measured in drill |

Tests include:

- baseline/load/short spike/soak at multiple of expected 50-user behavior;
- login hashing concurrency and rate-limit behavior;
- dashboard/activity with representative years/records;
- recurrence/reminder catch-up after worker outage;
- database pool exhaustion, slow query, deadlock/lock timeout;
- email timeout/429/5xx after unknown acceptance;
- API/database temporary outage and process restart;
- large body/range/filter/idempotency-key abuse;
- resource monitoring and clean recovery after load.

Do not run uncontrolled load/DAST against production.

### 5.11 Backup, recovery, migration, and rollback tests

Before beta:

1. Create a production-like encrypted backup.
2. Restore to isolated environment with timed procedure.
3. Verify schema/migration version, constraints, row counts, referential checks, user isolation, and representative financial reconciliations.
4. Start the exact application artifact against restored data and execute smoke journeys.
5. Verify backup/operator permissions and audit logs.
6. Destroy restored data under procedure.
7. Record actual RPO/RTO evidence and gaps.

For each release with schema changes:

- migrate previous-release snapshot forward;
- run reconciliation/regression;
- run old/new app compatibility where rollout requires;
- rehearse app rollback and approved database roll-forward/back strategy;
- verify no long locks/unbounded backfill.

### 5.12 Email and notification tests

- Template content, escaping, plain-text/HTML accessibility, localization, links, minimal privacy.
- SPF/DKIM/DMARC and provider sandbox/domain configuration.
- Outbox atomicity and unique logical delivery.
- Worker crash before/after provider response and retry behavior.
- Webhook signature/timestamp/replay/schema/idempotency.
- Schedule timezone/stage/quiet-hour policy.
- Confirm/skip/cancel racing with reminder evaluation.
- Delivery failure does not alter financial state.
- Unchanged cash-flow warning is not spammed.

## 6. Test data and determinism

- Synthetic personas cover new user, income-heavy, irregular income, debt, multiple goals, overdue obligations, large amounts, empty data, and long localized labels.
- Factories create one user by default and require explicit second-user setup for isolation tests.
- Fixed clocks and injected IANA timezone enable month-end, leap, DST, and midnight tests.
- Random/property tests persist a failing seed.
- Email/provider adapters have deterministic fault modes: accepted, delayed, timeout-after-accept, transient failure, permanent failure, malformed/replayed webhook.
- No test secret resembles a production credential.
- Cleanup is scoped by run; parallel tests cannot share user/database state accidentally.

## 7. Browser/device matrix

Final versions are selected near release based on beta audience and current support. Minimum categories:

- latest and previous major Chrome/Edge desktop;
- latest and previous Safari desktop where available;
- current Firefox desktop;
- current iOS Safari and installed PWA on representative small/notched devices;
- current Android Chrome and installed PWA on representative small/medium devices;
- keyboard/mouse, touch, reduced motion, screen reader, and zoom modes.

Unsupported-browser behavior must be safe and understandable; it must not silently corrupt writes.

## 8. CI/CD test stages

### Pull request (fast gate)

- formatting/lint/types/architecture boundaries;
- unit/component tests and accessibility smoke;
- PostgreSQL integration/API tests in parallel groups;
- migration from baseline fixture;
- secret/SAST/dependency/license checks;
- production build and contract diff.

### Merge/main artifact gate

- full integration/security regression;
- container/image scan and artifact identification;
- E2E against ephemeral/deployed staging subset;
- visual/PWA smoke;
- publish evidence and immutable artifact.

### Staging promotion gate

- migration rehearsal;
- deployed headers/cookie/CORS/cache/health tests;
- provider-sandbox email/webhook tests;
- critical E2E, DAST, accessibility/responsive matrix;
- performance baseline comparison.

### Production promotion gate

- approved release checklist and risk register;
- backup/current restore confidence;
- migration/rollback plan and operator on call;
- cohort-specific go/no-go;
- post-deploy non-destructive smoke and monitoring confirmation.

## 9. Quality gates

A release is blocked when any applies:

- required specification/ADR unresolved for implemented behavior;
- failing or missing critical-flow test;
- unresolved critical/high security defect, data-isolation defect, or credential/session flaw;
- unexplained financial reconciliation mismatch;
- core WCAG blocker/severe issue;
- flaky critical test without equivalent reliable evidence;
- failed migration/restore/rollback rehearsal;
- missing observability/runbook/on-call ownership;
- performance/resource behavior exceeds approved limits with user or availability impact;
- legal/privacy/retention/provider decision missing.

Lower-severity accepted issues require owner, impact, workaround, expiry, and cohort review.

## 10. Defect severity

| Severity | Example | Release effect |
|---|---|---|
| S0 Critical | Cross-user disclosure/write, credential/token leak, unrecoverable corruption, malicious production control | Stop release/rollout; incident response |
| S1 High | Core financial wrong result, auth bypass, duplicate payment/transaction, backup cannot restore, core flow inaccessible | Block release/cohort expansion |
| S2 Medium | Recoverable non-core malfunction, material UX confusion, limited accessibility issue | Fix or explicit time-bounded acceptance before cohort decision |
| S3 Low | Cosmetic/non-blocking issue with safe workaround | Track and prioritize by evidence |

Security severity also considers exploitability and user scope; labels do not downgrade a threat mechanically.

## 11. Evidence and reporting

Retain for each release:

- commit/image/schema versions and environment;
- CI and test reports with timestamps/config;
- requirement/threat traceability matrix;
- migration/rollback and backup/restore records;
- DAST/SAST/dependency/manual security triage;
- accessibility/manual device/usability findings;
- performance profile/results;
- open defects/risk acceptances;
- release approvals and cohort decision.

Artifacts must not contain secrets or real financial data. Retention follows the approved security evidence policy.

## 12. Beta monitoring as validation

For each 5 → 10 → 25 → 50 cohort, review:

- error and latency rates;
- financial write failures/idempotency conflicts/reconciliation alerts;
- auth failures/rate limits/suspicious session activity;
- database pool/storage/slow query behavior;
- worker backlog/email failures;
- PWA/client release mix;
- accessibility/UX support reports;
- feature usage using privacy-safe events;
- incidents, near misses, and user feedback.

Monitoring can reveal defects but does not replace pre-release tests. Cohort expansion is an explicit decision, never automatic.

## 13. Strategy approval blockers

- Approved MVP requirements and formulas.
- Selected stack/provider/browser support.
- Decisions on RLS, retention/deletion, reminder channels, locale/currency, and native scope.
- Named security, QA, accessibility, operations, and release owners.
- Agreed performance, RPO/RTO, and vulnerability SLA values.
