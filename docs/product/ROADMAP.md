# KFin Product and Delivery Roadmap

**Status:** Draft — Phase 0 remains open after Round 3 documentation remediation<br>
**Planning rule:** Later phases are not authorization to implement future scope.

## 1. Roadmap principles

- Progress through evidence-based gates, not calendar promises.
- Keep one modular product and one primary Web/PWA client.
- Complete security, accessibility, operations, and recovery work alongside functionality.
- Promote future ideas only after a new product specification is approved.
- Do not increase infrastructure complexity before measured use requires it.

## 2. Delivery phases

### Phase 0 — Specification foundation (current)

**Purpose:** Establish the reviewable source of truth before implementation.

**Deliverables**

- Product, MVP, roadmap, and user-flow specifications.
- UX specification, design system, and screen inventory.
- Architecture, data model, and proposed ADRs.
- Security requirements and threat model.
- Test strategy and release checklist.
- Product decision log for OQ-01 through OQ-19 and cross-document consistency review.
- Round 3 remediation report with exact AUTH → FIN → DEBT → SCHEDULE → REMINDER → SECURITY/data-lifecycle → UX → GOVERNANCE decision packets.
- Controlled approval/evidence register for named authorities, physical limits, decision evidence, and specification/ADR sign-off.

**Exit gate**

- Required documents reviewed for contradictions.
- Named Product and mandatory domain reviewers approve MVP boundaries and all due decisions with versioned evidence.
- All required ADRs are genuinely Accepted with named accountable/co-approvers and evidence, and every centralized `SPEC-*` blocker is closed against its Round 3 criteria.
- Governance register assignments, delegation/conflict rules, physical limits, evidence records, and sign-offs are complete.
- Implementation backlog links each item to requirements, flows, invariants, and tests.

**Current Phase 0 state:** Round 3 documentation remediation is complete, but all twelve `SPEC-*` blockers remain OPEN and no ADR is Accepted. Therefore this exit gate has not passed and Phase 1 is not authorized.

### Phase 1 — Product foundation and design system

**Purpose:** Build only the production skeleton required by approved specs.

**Candidate deliverables after approval**

- Repository/tooling baseline and CI quality gates.
- Environment configuration and secret-handling contract.
- Database migration baseline and ownership safeguards.
- Responsive application shell, tokens, core components, state patterns.
- Structured logging, health/readiness checks, error boundary, correlation IDs.
- Vendor-neutral local/ephemeral deployment smoke and synthetic backup/restore harness. Provider-specific staging and backup automation remain Phase 6 work under OQ-17.

**Exit gate**

- Architecture fitness, component accessibility, migration, and deployment-smoke tests pass.
- No financial feature is hidden inside foundation work.

### Phase 2 — Identity, authentication, and sessions

**Purpose:** Establish trustworthy access before private financial records exist.

**Candidate deliverables after approval**

- Invite/registration and email verification.
- Login, persistent opaque sessions, logout, session management.
- Forgot/reset/change password.
- Security history and abuse protections.
- Approved account-deletion request/cancel/purge state machine plus vendor-neutral restore-exclusion contract/harness; selected-provider deletion/storage integration remains Phase 6 work.
- Authorization test harness and audit event baseline.

**Exit gate**

- Auth integration, abuse, CSRF, session rotation/revocation, enumeration, and security E2E tests pass.
- Email delivery failure and recovery behavior is exercised through the vendor-neutral adapter/fault harness; selected-provider validation remains a Phase 6 gate.
- Deletion cancellation/purge races and restore-exclusion contract behavior pass against the approved design using deterministic adapters.

### Phase 3 — Financial core and fast entry

**Purpose:** Make current balance, income, and spending coherent.

**Candidate deliverables after approval**

- Onboarding with one aggregate account and initial balance snapshot.
- Manual authoritative-balance snapshot updates and explicitly labelled historical backfill.
- Posted current-impact/historical-only income/expense transaction model.
- Amount-first Global Add and activity history.
- Approved append-only transaction correction/void flow under `snapshot_correction.v1`; cross-segment moves remain rejected and each transaction has at most one compatible owning-domain claim.
- Approved/evidenced PostgreSQL account-row/version serialization under `account_financial_serialization.v1`, including complete claim checks, bounded retry, and same-key uncertain-commit recovery.
- Default categories/classifications.
- Monthly aggregation and snapshot-anchor consistency tests.

**Exit gate**

- Money/date/timezone invariants and idempotency pass.
- `SPEC-FIN-01` and `SPEC-FIN-02` have mandatory owner approvals, including the exclusive-domain-claim matrix and persisted/presentation occurrence terminology; H–J/`FIN-COR-01`–`10`/`FIN-LINK-01`–`06`/`FIN-OCC-01`–`04` and real-PostgreSQL `FIN-RACE-01`–`08` on Supabase pass with ADR-009, idle-confirmed rollback, lock release, deterministic clean reuse, unconfirmed-cleanup eviction/no-retry, query/latency and commit-fault evidence.
- Representative users complete Global Add and correction tasks on small screens.
- Cross-user tests pass for every resource.

### Phase 4 — Plans and obligations

**Purpose:** Represent expected money without confusing it with actual money.

**Candidate deliverables after approval**

- Recurring definitions and idempotent occurrence generation.
- Unified schedule and explicit receipt/payment confirmation.
- Debts and payment history.
- Savings goals with manual current amount/as-of date and old/new audit metadata.
- Planned purchases with atomic expense plus user-confirmed goal amount deduction.

**Exit gate**

- Scheduled versus posted semantics are validated with users.
- `SPEC-SCH-01` and `SPEC-DEBT-01` are resolved; recurrence boundaries, `DCT-01`–`DCT-09`, and savings double-counting tests pass.

### Phase 5 — Decision-focused dashboard, reminders, and PWA

**Purpose:** Answer the four dashboard questions and support repeated use.

**Candidate deliverables after approval**

- Dashboard hierarchy and drill-down.
- Safe-to-spend implementation exactly matching `PRD-DASH-07` and `STS-01`–`STS-15`, plus the cash-flow warning.
- In-app-only reminder center for eligible outgoing obligations: 09:00 user-local stages, one first-overdue notification, closed-app independence, and no catch-up burst. Catch-up implementation starts only after `SPEC-REM-01` is resolved.
- Installable PWA with safe caching behavior.
- Offline/read-only failure messaging; no offline financial writes.

**Exit gate**

- Calculation explainability, reminder deduplication, timezone, accessibility, responsive, and PWA tests pass.
- No authenticated API response is exposed through unsafe caches.

### Phase 6 — Hardening and release candidate

**Purpose:** Demonstrate production readiness rather than feature completeness alone.

**Deliverables**

- Resolve OQ-17: select specific PaaS, PostgreSQL, email, observability providers, domain, region, and budget through a deployment/provider ADR addendum.
- Deploy production-like staging and verify private networking, IAM, backups, origin controls, email, observability, deletion/provider purge, independent restore-exclusion storage, rollback, residency, and cost.
- Complete Vietnamese legal/privacy review of cross-border processing, deletion, and the OQ-18 retention baseline.
- Full regression and threat-model verification.
- Performance and database exhaustion tests at a defined multiple of beta load.
- Dependency, SAST, DAST, and manual security review.
- Backup restore, migration, rollback, and incident exercises.
- Privacy/retention/support readiness.
- Usability and accessibility remediation.

**Exit gate**

- Release checklist signed with linked evidence.
- Known risks have explicit owners, acceptance, and review dates.
- Five-user cohort has a go/no-go decision.

### Phase 7 — Controlled Private Beta

| Cohort | Entry condition | Observe before expansion |
|---|---|---|
| Internal | Release candidate passed | Functional defects, logs, alerts, support process |
| 5 users | Internal issues triaged; restore/rollback proven | Onboarding, trust, auth failures, financial-write failures, latency |
| 10 users | No unresolved severity-1 issue; feedback reviewed | Repeated use, reminder usefulness, calculation confusion |
| 25 users | Capacity and support remain healthy | Database/job behavior, feature adoption, abandonment |
| 50 users | Security/operations review approves expansion | Product outcomes, infrastructure evidence, next-spec inputs |

Expansion is manual. Any confirmed data isolation issue, unrecoverable write error, or critical security incident pauses rollout and invokes the incident process.

## 3. MVP release content

The Private Beta release comprises only the approved subset in [MVP-SCOPE.md](MVP-SCOPE.md): authentication, the approved manual account model, income, expenses, debt, savings, planned purchases, unexpected-expense flagging, monthly overview, payment schedule, reminders, security, and PWA quality.

## 4. Future candidates — not approved scope

Candidates may include:

- Custom categories.
- “Quick Add” presets, one-tap shortcuts, or widgets beyond the MVP Global Add form.
- Advanced month comparison.
- Payment-reminder email, push notifications, SMS, or other external channels.
- User data export/import.
- Shared and household finance.
- Advanced analytics and projections.
- Bank or wallet integrations.
- Additional financial planning tools.
- Capacitor Android/iOS packaging.
- Multiple currencies and exchange rates.

Placement in this list creates no delivery commitment.

## 5. Promotion criteria for a future item

A candidate can enter a release specification only when:

1. research or beta evidence identifies a user problem;
2. expected outcome and non-goals are explicit;
3. privacy, security, and abuse impacts are assessed;
4. data migrations and backward compatibility are designed;
5. UX across mobile, desktop, loading, empty, error, and accessibility states is specified;
6. operational cost and support ownership are accepted;
7. tests and rollout/rollback criteria are defined;
8. a product owner approves the scope change.

## 6. Feedback loop

For each cohort:

1. Collect opt-in, privacy-preserving product events and direct feedback.
2. Review errors, latency, auth failures, write failures, database health, worker backlog, and email delivery.
3. Classify findings as defect, misunderstanding, unmet need, or future candidate.
4. Fix release-blocking defects under existing specs.
5. Update specifications before changing behavior or scope.
6. Record the decision and proceed, hold, roll back, or close access.

## 7. No-date policy

This roadmap intentionally contains phase gates rather than invented dates. Dates require staffing, hosting, legal ownership, and approved scope. A schedule added later must not bypass quality gates.
