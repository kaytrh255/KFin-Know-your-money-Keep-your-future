# KFin Specification Foundation

**Status:** Draft — Round 1 specification edits complete; owner approval/evidence blocked<br>
**Version:** 0.3<br>
**Date:** 2026-10-07<br>
**Implementation gate:** CLOSED

This directory is the specification source of truth for the KFin Private Beta. It describes the intended product, user experience, architecture, security posture, data model, and verification approach. It does **not** authorize implementation. Product decisions OQ-01 through OQ-19 were captured on 2026-10-07. Round 1 consistency edits do not constitute owner approval or evidence; Proposed/Blocked ADRs and open blocker decisions must be resolved before acceptance.

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative unless a section is explicitly labelled as a proposal, assumption, example, or open decision.

## Specification map

| Area | Document | Purpose |
|---|---|---|
| Product | [PRD](product/PRD.md) | Product goals, users, outcomes, and requirements |
| Product | [MVP scope](product/MVP-SCOPE.md) | Private Beta boundaries and acceptance outcomes |
| Product | [Decision log](product/DECISION-LOG.md) | Accepted/deferred OQ decisions, rationale, and consequences |
| Product | [Roadmap](product/ROADMAP.md) | Specification and release phases; future candidates |
| Product | [User flows](product/USER-FLOWS.md) | Main journeys and failure/recovery paths |
| UX | [UX specification](ux/UX-SPEC.md) | Information architecture, interaction rules, responsive behavior |
| UX | [UI design system](ux/UI-DESIGN-SYSTEM.md) | Tokens, reusable components, states, accessibility |
| UX | [Screen inventory](ux/SCREEN-INVENTORY.md) | Initial screen map and route proposal |
| Architecture | [Architecture](architecture/ARCHITECTURE.md) | Proposed stack, modular monolith, runtime and deployment views |
| Architecture | [Database](architecture/DATABASE.md) | Proposed relational model, invariants, ownership and lifecycle |
| Architecture | [ADRs](architecture/ADR/README.md) | Audited Proposed/Blocked decisions, owner roles, and exact acceptance blockers |
| Security | [Security requirements](security/SECURITY-REQUIREMENTS.md) | Normative application and operational controls |
| Security | [Threat model](security/THREAT-MODEL.md) | Assets, boundaries, abuse cases, mitigations and residual risk |
| Testing | [Test strategy](testing/TEST-STRATEGY.md) | Verification levels, environments, quality gates and evidence |
| Testing | [Release checklist](testing/RELEASE-CHECKLIST.md) | Private Beta readiness and rollout gates |

## Requested proposal summary

1. **Technology stack** — A TypeScript monorepo; React + Vite for one responsive Web/PWA client; Fastify on Node.js for a modular API; PostgreSQL; a small PostgreSQL-backed worker; standards-based CSS tokens and accessible headless primitives; Vitest and Playwright. Exact versions remain subject to architecture review.
2. **Architecture** — A same-origin modular monolith behind Cloudflare, deployed eventually to managed PaaS with private managed PostgreSQL. One API and one optional worker use the same codebase/image. No Redis, broker, microservices, or Kubernetes.
3. **Database model** — One aggregate money account per user, immutable balance snapshots, posted current-impact or historical-only transactions, schedules/occurrences, informational debt, manually maintained savings-goal amounts, planned purchases, in-app notifications, sessions, authentication challenges, security events, and an outbox. Money uses integer minor units and one user base currency.
4. **Authentication/session architecture** — Single-use beta invitation, verified email and password (Argon2id), opaque revocable rotating server-side sessions, digest-only token storage, secure browser cookie, and explicit current/all-session revocation. JWTs and permanent tokens are not proposed.
5. **Initial screen map** — Authentication/invitation, onboarding, Home, Activity, Global Add, Schedule, Plan (debts, savings, planned purchases), Notifications, Profile and Security. Mobile uses bottom navigation; desktop uses a sidebar.
6. **Main user journeys** — Accept invite/register/verify, resume/revoke sessions, recover/change password, establish or deliberately update an authoritative balance snapshot, backfill historical activity safely, add actual income/expense, confirm schedules, manage debt, update goal amount, complete a planned purchase, understand Home, and act on in-app reminders.
7. **Threat model summary** — Highest risks are account takeover, BOLA/IDOR, session theft/replay, financial record or balance-anchor manipulation, sensitive-data leakage, auth abuse, and backup/log exposure under extended retention.
8. **Testing strategy** — Risk-based unit, PostgreSQL integration, API contract, authorization/security, E2E, accessibility/responsive, PWA, performance, migration, retention/deletion, and backup/restore testing. A running application alone is never evidence of readiness.
9. **Deployment strategy** — The product direction selects Cloudflare + managed PaaS + private managed PostgreSQL; ADR-007 remains proposed pending architecture review. Specific vendors are deliberately deferred until before Release Candidate and remain a visible late-integration risk/release blocker.
10. **Development phases** — Specification consistency/approval; foundation/design system; authentication; financial core; plans/obligations; dashboard/in-app reminders/PWA; provider selection and hardening; Release Candidate; then 5 → 10 → 25 → 50-user rollout.

## Decision register

The full rationale and consequences are in the [Product Decision Log](product/DECISION-LOG.md).

| ID | Status | Decision |
|---|---|---|
| OQ-01 | Accepted | Vietnamese-first UI; English-ready message architecture |
| OQ-02 | Accepted | One base currency per user; VND default; no conversion |
| OQ-03 | Accepted | One aggregate liquid-money account; no transfers/multi-account UI |
| OQ-04 | Accepted | Scheduled income/outgoings always require explicit received/paid confirmation |
| OQ-05 | Accepted | Conservative month-end safe-to-spend; future income excluded |
| OQ-06 | Accepted | In-app reminders only; authentication/security email remains |
| OQ-07 | Accepted | Debt interest is informational; no accrual/amortization/payoff engine |
| OQ-08 | Accepted | Savings goal current amount is manually maintained; no contribution ledger |
| OQ-09 | Accepted | Cloudflare + managed PaaS + managed PostgreSQL topology |
| OQ-10 | Accepted baseline | 7-day deletion cancellation grace, then active-system purge; legal review required |
| OQ-11 | Accepted | Single-use expiring invitation codes; no server-side email-allowlist mode |
| OQ-12 | Accepted | Eligible outgoing-obligation reminder evaluation at 09:00 user-local time |
| OQ-13 | Accepted | Balance snapshot anchors; pre-snapshot backfill is historical-only for balance |
| OQ-14 | Accepted | One-off plus interval weekly/monthly/yearly; short month uses last day |
| OQ-15 | Accepted | User confirms goal amount decrease when completing a linked purchase |
| OQ-16 | Accepted direction | Vietnam-first beta; prefer Southeast Asia region subject to legal review |
| OQ-17 | Deferred — RC blocker | Select specific providers/domain/region/budget before Release Candidate |
| OQ-18 | Accepted baseline | Maximum 90-day backups, 90-day app logs, 24-month security/audit evidence |
| OQ-19 | Accepted | One notification when first overdue; no repeated overdue spam |

## Review and implementation gate

**Implementation Gate: CLOSED**

The OQ review is complete, but implementation remains blocked until:

1. all affected specifications are consistent with the decision log;
2. PRD, MVP scope, UX, architecture, database, security, and test specifications are formally reviewed;
3. every required Proposed/Blocked ADR is genuinely Accepted with role-based approvers and evidence;
4. required financial formula, snapshot A–J, debt correction, and reminder catch-up matrices are fully decided and validated;
5. implementation work is traceable to requirements, flows, invariants, ADRs, and tests.

### Remaining blocker register

Every open `SPEC-*` row keeps the Implementation Gate CLOSED. `RC-PROV-01` and `BETA-LEGAL-01` are additional later-phase gates under the accepted OQ-17 deferral; they do not waive any earlier blocker.

| Blocker ID | Status | Due gate | Exact decision or evidence required |
|---|---|---|---|
| SPEC-AUTH-01 | OPEN | Before authentication implementation | Product Owner must choose whether successful email verification creates a newly rotated authenticated session or requires an explicit sign-in. |
| SPEC-AUTH-02 | OPEN | Before authentication/session implementation | Security and Product owners must approve invitation expiry/binding/provisioning values, password/OTP/reset limits, session lifetimes, token-rotation cadence, and prior-token grace/replay response. The invitation-code mechanism itself is already Accepted. |
| SPEC-FIN-01 | OPEN | Before transaction correction implementation | Product, Engineering, and Security owners must define correction/void behavior across snapshot segments, including linked occurrences, report effects, audit chain, and idempotent retry result. |
| SPEC-FIN-02 | OPEN | Before financial schema/API implementation | Engineering and Security owners must select and validate the per-account snapshot/transaction serialization mechanism and retryable-conflict API contract while preserving the linearizable invariant. |
| SPEC-DEBT-01 | OPEN | Before debt-payment correction implementation | Product and Engineering owners must choose how a corrected historical payment affects current outstanding when later payments or lender adjustments exist: deterministic replay from explicit facts or mandatory fresh lender-reported outstanding. |
| SPEC-SCH-01 | OPEN | Before recurrence implementation | Product Owner must choose yearly 29-February fallback, maximum recurrence interval/horizon, and supported `this occurrence` versus `this and future` edit behavior. |
| SPEC-REM-01 | OPEN | Before reminder implementation | Product Owner must choose which single stage, if any, is emitted when stages were missed after downtime, late occurrence creation, or timezone change; define the recovery window and how non-selected elapsed stages are recorded. Burst delivery remains prohibited. |
| SPEC-SEC-01 | OPEN | Before database authorization implementation | Engineering and Security owners must accept PostgreSQL RLS with trusted request/worker context or approve documented compensating controls and risk. |
| SPEC-SEC-02 | OPEN | Before security-history implementation | Product and Security owners must decide which authentication/session/account events are user-visible versus operator-only, their safe detail, notification behavior, and retention/display limits. |
| SPEC-DEL-01 | OPEN | Before deletion implementation | Privacy, Product, Security, and Operations owners must approve request/cancellation authentication, table/provider deletion map, retained pseudonymous fields, restore-exclusion storage/key/expiry, legal-hold handling, and request channel. |
| SPEC-UX-01 | OPEN | Before UX acceptance | Product and UX/Accessibility owners must approve compact/expanded prototypes and Vietnamese content, then retain representative usability-task, keyboard, screen-reader, zoom/reflow, contrast, touch-target, and state-coverage evidence. Specification review alone cannot close this blocker. |
| SPEC-GOV-01 | OPEN | Before specification/ADR approval | Name accountable Product, Engineering, Security, UX/accessibility, QA, Operations, Privacy/legal, incident, support, and release approvers; review each ADR status; approve remaining physical safety bounds (money, note, page, and job-batch limits); and retain formula/flow/prototype/architecture validation evidence. |
| RC-PROV-01 | OPEN | Before Release Candidate | Resolve OQ-17 with providers, domain, final region, budget, provider ADR addendum, subprocessors, production-like staging, measured RPO/RTO, and cost/residency evidence. |
| BETA-LEGAL-01 | OPEN | Before external Private Beta | Complete Vietnamese legal/privacy approval, enforce retention/deletion, and provide restore/rollback/deletion, security, accessibility, usability, incident/support, and release evidence. |

A blocker may be resolved only by an approved specification/ADR update or linked evidence; implementation must not choose silently. Documentation consistency does not close any blocker by itself.

## Governance and change control

1. Every implementation issue MUST reference requirement IDs, applicable OQ decisions, and ADRs.
2. A proposed ADR becomes `Accepted` only after review; implementation MUST NOT silently treat it as accepted.
3. Requirement changes MUST update affected product, UX, architecture, security, database, and test documents in the same change.
4. A feature is complete only with the evidence required by the [release checklist](testing/RELEASE-CHECKLIST.md).
5. Future roadmap items are not requirements until promoted through a new approved specification.
6. Accepted OQ decisions are changed through a dated decision-log entry, never silent text replacement.

## Current limitations

- No application code, infrastructure, schema migration, or executable test has been created.
- No legal, privacy, tax, or regulated-financial-services review has occurred.
- No provider has been selected under the accepted OQ-17 deferral.
- No usability study, visual prototype, accessibility audit, penetration test, load test, deletion test, or restore test has occurred.
- Capacity, recovery, retention, and latency values are product/engineering baselines requiring validation.
