# KFin Product and Delivery Roadmap

**Status:** Draft — review required<br>
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
- Resolution log for OQ-01 through OQ-15.

**Exit gate**

- Required documents reviewed for contradictions.
- Product owner and engineering/security reviewers approve MVP boundaries and major decisions.
- ADRs required for Phase 1 are accepted.
- Implementation backlog links each item to requirements and tests.

### Phase 1 — Product foundation and design system

**Purpose:** Build only the production skeleton required by approved specs.

**Candidate deliverables after approval**

- Repository/tooling baseline and CI quality gates.
- Environment configuration and secret-handling contract.
- Database migration baseline and ownership safeguards.
- Responsive application shell, tokens, core components, state patterns.
- Structured logging, health/readiness checks, error boundary, correlation IDs.
- Staging deployment and backup automation.

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
- Authorization test harness and audit event baseline.

**Exit gate**

- Auth integration, abuse, CSRF, session rotation/revocation, enumeration, and security E2E tests pass.
- Email delivery failure and recovery behavior is exercised.

### Phase 3 — Financial core and fast entry

**Purpose:** Make current balance, income, and spending coherent.

**Candidate deliverables after approval**

- Onboarding/opening balance.
- Manual financial accounts under the approved OQ-03 decision.
- Posted income/expense transaction model.
- Amount-first Global Add and activity history.
- Default categories/classifications.
- Monthly aggregation and reconciliation tests.

**Exit gate**

- Money/date/timezone invariants and idempotency pass.
- Representative users complete Global Add and correction tasks on small screens.
- Cross-user tests pass for every resource.

### Phase 4 — Plans and obligations

**Purpose:** Represent expected money without confusing it with actual money.

**Candidate deliverables after approval**

- Recurring definitions and idempotent occurrence generation.
- Unified schedule and explicit receipt/payment confirmation.
- Debts and payment history.
- Savings goals and allocation history.
- Planned purchases and completion flow.

**Exit gate**

- Scheduled versus posted semantics are validated with users.
- Recurrence boundary, debt correction, and savings double-counting tests pass.

### Phase 5 — Decision-focused dashboard, reminders, and PWA

**Purpose:** Answer the four dashboard questions and support repeated use.

**Candidate deliverables after approval**

- Dashboard hierarchy and drill-down.
- Approved spendable estimate and cash-flow warning.
- In-app reminder center and approved email delivery.
- Installable PWA with safe caching behavior.
- Offline/read-only failure messaging; no offline financial writes.

**Exit gate**

- Calculation explainability, reminder deduplication, timezone, accessibility, responsive, and PWA tests pass.
- No authenticated API response is exposed through unsafe caches.

### Phase 6 — Hardening and release candidate

**Purpose:** Demonstrate production readiness rather than feature completeness alone.

**Deliverables**

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
- Push notifications.
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
