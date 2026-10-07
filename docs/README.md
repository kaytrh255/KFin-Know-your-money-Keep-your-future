# KFin Specification Foundation

**Status:** Draft — FIN-01/02 decision candidates specified; owner approvals/evidence blocked<br>
**Version:** 0.6<br>
**Date:** 2026-10-07<br>
**Implementation gate:** CLOSED

This directory is the specification source of truth for the KFin Private Beta. It describes the intended product, user experience, architecture, security posture, data model, governance, and verification approach. It does **not** authorize implementation. Product decisions OQ-01 through OQ-19 were captured on 2026-10-07. The [Round 3 remediation report](reviews/SPECIFICATION-REMEDIATION-ROUND-3.md) makes every pre-implementation `SPEC-*` blocker decision-ready; it does not supply the missing owner decisions or evidence. Proposed/Blocked ADRs and open blocker decisions must be resolved before acceptance.

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative unless a section is explicitly labelled as a proposal, assumption, example, or open decision.

## Specification map

| Area | Document | Purpose |
|---|---|---|
| Product | [PRD](product/PRD.md) | Product goals, users, outcomes, and requirements |
| Product | [MVP scope](product/MVP-SCOPE.md) | Private Beta boundaries and acceptance outcomes |
| Product | [Decision log](product/DECISION-LOG.md) | Accepted/deferred OQ decisions, rationale, and consequences |
| Product | [SPEC-FIN-01 snapshot correction](product/SPEC-FIN-01-SNAPSHOT-CORRECTION.md) | Proposed append-only correction, prior-segment, cross-segment, linkage, and concurrency contract for Issue #1 |
| Product | [Roadmap](product/ROADMAP.md) | Specification and release phases; future candidates |
| Product | [User flows](product/USER-FLOWS.md) | Main journeys and failure/recovery paths |
| UX | [UX specification](ux/UX-SPEC.md) | Information architecture, interaction rules, responsive behavior |
| UX | [UI design system](ux/UI-DESIGN-SYSTEM.md) | Tokens, reusable components, states, accessibility |
| UX | [Screen inventory](ux/SCREEN-INVENTORY.md) | Initial screen map and route proposal |
| Architecture | [Architecture](architecture/ARCHITECTURE.md) | Proposed stack, modular monolith, runtime and deployment views |
| Architecture | [SPEC-FIN-02 snapshot concurrency](architecture/SPEC-FIN-02-SNAPSHOT-CONCURRENCY.md) | Proposed PostgreSQL account-row lock, version, retry, uncertain-commit, and evidence contract for Issue #3 |
| Architecture | [Database](architecture/DATABASE.md) | Proposed relational model, invariants, ownership and lifecycle |
| Architecture | [ADRs](architecture/ADR/README.md) | Audited Proposed/Blocked decisions, owner roles, and exact acceptance blockers |
| Security | [Security requirements](security/SECURITY-REQUIREMENTS.md) | Normative application and operational controls |
| Security | [Threat model](security/THREAT-MODEL.md) | Assets, boundaries, abuse cases, mitigations and residual risk |
| Testing | [Test strategy](testing/TEST-STRATEGY.md) | Verification levels, environments, quality gates and evidence |
| Testing | [Release checklist](testing/RELEASE-CHECKLIST.md) | Private Beta readiness and rollout gates |
| Governance | [Approval and evidence register](governance/APPROVAL-AND-EVIDENCE-REGISTER.md) | Named authority, decision approvals, physical limits, and evidence control |
| Reviews | [Round 3 remediation report](reviews/SPECIFICATION-REMEDIATION-ROUND-3.md) | Before/after state and closure packet for every open `SPEC-*` blocker |

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

The OQ review and Round 3 documentation remediation are complete, but implementation remains blocked until:

1. every `SPEC-*` decision packet has an authorized outcome and linked evidence;
2. PRD, MVP scope, UX, architecture, database, security, and test specifications are formally reviewed;
3. every required Proposed/Blocked ADR is genuinely Accepted with named role-based approvers and evidence;
4. required financial formula, snapshot A–J, debt correction, schedule, reminder, security, deletion, and UX matrices/evidence are fully decided and validated;
5. the [Approval and Evidence Register](governance/APPROVAL-AND-EVIDENCE-REGISTER.md) has named assignments, approved physical limits, versioned evidence, and sign-off records;
6. implementation work is traceable to requirements, flows, invariants, ADRs, and tests.

### Remaining blocker register

Every open `SPEC-*` row keeps the Implementation Gate CLOSED. Round 3 changed each row from a broad blocker to an **OPEN — decision/evidence ready** packet; it did not resolve any row. Exact owners, inputs, evidence, and binary closure criteria are in the [Round 3 report](reviews/SPECIFICATION-REMEDIATION-ROUND-3.md) and [Approval and Evidence Register](governance/APPROVAL-AND-EVIDENCE-REGISTER.md). `RC-PROV-01` and `BETA-LEGAL-01` are additional later-phase gates under the accepted OQ-17 deferral; they do not waive any earlier blocker.

| Blocker ID | Status | Due gate | Exact decision or evidence required |
|---|---|---|---|
| SPEC-AUTH-01 | OPEN — decision ready | Before authentication implementation | Product + Security approval of exactly one post-verification outcome (fresh rotated authenticated session or explicit sign-in), including cookies/CSRF, result UX, events, multi-tab, and uncertain-response behavior. |
| SPEC-AUTH-02 | OPEN — decision ready | Before authentication/session implementation | Security + Product approval of every invitation, password, OTP, reset, abuse, session-lifetime, rotation/replay, and known-password-change value/behavior with threat, benchmark, usability, and provider evidence. Invitation-code admission itself is already Accepted. |
| SPEC-FIN-01 | OPEN — approval/evidence ready | Before transaction correction implementation | Issue #1 now has proposed policy `snapshot_correction.v1`: append-only void + replacement, same-anchor/effect corrections, deterministic rejection of cross-segment/effect moves, zero current-balance effect for closed-segment corrections, explicit link rules, and stale-state/idempotency outcomes. Product + Financial Integrity + Data + Security approval and recorded PR evidence remain required. |
| SPEC-FIN-02 | OPEN — approval/evidence ready | Before financial schema/API implementation | Issue #3 proposes `account_financial_serialization.v1`: account-row `FOR UPDATE` at `READ COMMITTED`, monotonic version/order, explicit rollback before pool release/response/fresh retry for failed attempts, one bounded transient retry, same-key uncertain-commit recovery, and `FIN-RACE-01`–`08`. Mandatory approval and real-PostgreSQL evidence on a dedicated Supabase project remain required. |
| SPEC-DEBT-01 | OPEN — decision ready | Before debt-payment correction implementation | Product + Financial Integrity + Data approval of explicit-fact replay or mandatory fresh lender-reported outstanding (or a precisely bounded combination), including later-event/date-reorder/void outcomes and DCT-08/09 evidence. |
| SPEC-SCH-01 | OPEN — decision ready | Before recurrence implementation | Product + Data + Architecture approval of yearly 29-February behavior, recurrence/generation/series bounds, and exact `this occurrence` / `this and future` semantics with boundary and race evidence. |
| SPEC-REM-01 | OPEN — decision ready | Before reminder implementation | Product + Architecture + Operations + QA approval of one catch-up policy tuple: emission, stage precedence, recovery window, first-overdue treatment, suppression record, timezone/late-creation and state-race outcomes. Burst delivery remains prohibited. |
| SPEC-SEC-01 | OPEN — decision ready | Before database authorization implementation | Security + Data + Architecture approval of PostgreSQL RLS coverage/context/roles or explicit beta compensating controls and residual risk, backed by private-table/action and connection-reuse evidence. |
| SPEC-SEC-02 | OPEN — decision ready | Before security-history implementation | Product + Security + Privacy/Legal classification of every event family as user-visible/operator-only/both/not-retained, with safe fields, delivery/display/retention behavior and privacy/UX evidence. |
| SPEC-DEL-01 | OPEN — decision ready | Before deletion implementation | Privacy/Legal + Product + Security + Operations approval of request/cancel auth, deletion map, retained evidence, restore-exclusion register, legal hold, provider proof, and restore-drill behavior. |
| SPEC-UX-01 | OPEN — evidence ready | Before UX acceptance | UX/Accessibility + Product approval of versioned compact/expanded prototypes, Vietnamese content, moderated usability, keyboard, screen-reader, zoom/reflow, contrast, touch-target, reduced-motion, and required-state evidence. |
| SPEC-GOV-01 | OPEN — evidence/assignment ready | Before specification/ADR approval | Named accountable role assignments, delegation/conflict rules, approved physical limits, controlled evidence manifest, ADR/specification sign-offs, and change history in the governance register. |
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
