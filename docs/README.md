# KFin Specification Foundation

**Status:** Draft — review required<br>
**Version:** 0.1<br>
**Date:** 2026-10-07<br>
**Implementation gate:** Closed

This directory is the specification source of truth for the KFin Private Beta. It describes the intended product, user experience, architecture, security posture, data model, and verification approach. It does **not** authorize implementation. The relevant specifications and proposed ADRs must be reviewed before implementation starts.

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative unless a section is explicitly labelled as a proposal, assumption, example, or open decision.

## Specification map

| Area | Document | Purpose |
|---|---|---|
| Product | [PRD](product/PRD.md) | Product goals, users, outcomes, requirements, and open decisions |
| Product | [MVP scope](product/MVP-SCOPE.md) | Private Beta boundaries and acceptance outcomes |
| Product | [Roadmap](product/ROADMAP.md) | Specification and release phases; future candidates |
| Product | [User flows](product/USER-FLOWS.md) | Main journeys and failure/recovery paths |
| UX | [UX specification](ux/UX-SPEC.md) | Information architecture, interaction rules, responsive behavior |
| UX | [UI design system](ux/UI-DESIGN-SYSTEM.md) | Tokens, reusable components, states, accessibility |
| UX | [Screen inventory](ux/SCREEN-INVENTORY.md) | Initial screen map and route proposal |
| Architecture | [Architecture](architecture/ARCHITECTURE.md) | Proposed stack, modular monolith, runtime and deployment views |
| Architecture | [Database](architecture/DATABASE.md) | Proposed relational model, invariants, ownership and lifecycle |
| Architecture | [ADRs](architecture/ADR/README.md) | Proposed architecture decisions awaiting approval |
| Security | [Security requirements](security/SECURITY-REQUIREMENTS.md) | Normative application and operational controls |
| Security | [Threat model](security/THREAT-MODEL.md) | Assets, boundaries, abuse cases, mitigations and residual risk |
| Testing | [Test strategy](testing/TEST-STRATEGY.md) | Verification levels, environments, quality gates and evidence |
| Testing | [Release checklist](testing/RELEASE-CHECKLIST.md) | Private Beta readiness and rollout gates |

## Requested proposal summary

1. **Technology stack** — A TypeScript monorepo; React + Vite for one responsive Web/PWA client; Fastify on Node.js for a modular API; PostgreSQL; a small PostgreSQL-backed worker; standards-based CSS tokens and accessible headless primitives; Vitest and Playwright. Exact versions will be pinned only at implementation kickoff to then-supported releases.
2. **Architecture** — A same-origin, modular monolith behind Cloudflare. Static web assets, one API deployment, one optional worker process from the same codebase, and one private managed PostgreSQL database. No Redis, message broker, microservices, or Kubernetes.
3. **Database model** — An extensible user-owned account table (one exposed aggregate liquid-money account is recommended for MVP), posted income/expense transactions, schedule definitions and occurrences, debts and payments, savings goals and allocations, planned purchases, reminders, sessions, authentication challenges, security events, and a transactional outbox. Money is stored as integer minor units with an ISO 4217 currency code.
4. **Authentication/session architecture** — Verified email and password (Argon2id); opaque, revocable, rotating server-side sessions; only a token digest in PostgreSQL; an `HttpOnly`, `Secure`, `SameSite` cookie for Web/PWA; explicit current/all-session revocation; generic abuse-resistant recovery responses. JWTs and permanent tokens are not proposed.
5. **Initial screen map** — Authentication; onboarding; Home; Activity; Global Add; Schedule; Plan (debts, savings, planned purchases); Notifications; Profile and Security. Mobile uses a compact bottom navigation and desktop uses a sidebar.
6. **Main user journeys** — Register and verify email, resume a session, recover/change password, add income/expense quickly, confirm scheduled income/payment, manage debt, contribute to savings, plan/complete a purchase, understand the dashboard, and act on reminders.
7. **Threat model summary** — Highest risks are account takeover, broken object-level authorization, session/token theft, financial record manipulation, sensitive-data leakage, and abuse of login/OTP/reset endpoints. Controls are layered at Cloudflare, application, database, session, audit, and operations levels.
8. **Testing strategy** — Risk-based unit, integration, API contract, authorization/security, E2E, accessibility/responsive, PWA, performance, migration, and backup/restore testing. A running application alone is never evidence of readiness.
9. **Deployment strategy** — GitHub Actions promotes an immutable container through isolated staging and production environments behind Cloudflare. The database is private and managed, migrations are gated, backups are encrypted and restoration-tested, and releases require health checks and a tested rollback path. The hosting region/provider remains an explicit decision.
10. **Development phases** — Specification approval; foundation/design system; authentication; financial core; planning/obligations; dashboard/reminders/PWA; hardening and release candidate; then 5 → 10 → 25 → 50-user rollout.

These are **proposals**, not approved decisions. Details and trade-offs are recorded in the architecture documents and ADRs.

## Review-blocking open decisions

KFin cannot safely enter implementation until the product owner resolves or explicitly accepts the following proposals:

| ID | Decision needed | Current recommendation |
|---|---|---|
| OQ-01 | Beta UI language(s), country, legal jurisdiction, and data residency | Vietnamese-first (`vi-VN`), with English-ready message keys; host data in an approved nearby jurisdiction |
| OQ-02 | Currency policy | One base currency per user, VND default; no exchange rates or cross-currency totals in MVP |
| OQ-03 | Meaning and source of “current balance”; single aggregate account versus multiple accounts/transfers | One exposed aggregate liquid-money account with an opening balance in MVP; derive balance from posted transactions; defer multi-account transfers |
| OQ-04 | Whether scheduled income/expenses become actual automatically | Never auto-post; explicitly confirm receipt/payment |
| OQ-05 | “Safe to spend” horizon and treatment of savings | Conservative month-end estimate; show formula and never present it as financial advice |
| OQ-06 | Reminder channels and defaults | In-app plus opt-in email; no push notifications in MVP |
| OQ-07 | Debt interest calculation | Store/display rate and payment splits; no automatic accrual or amortization until calculation rules are specified |
| OQ-08 | Meaning of savings “current amount” | A virtual allocation from available money, recorded by contribution/withdrawal entries; not a second cash balance |
| OQ-09 | Hosting provider, region, budget, domain, and email provider | Select after residency, cost, and operational ownership are confirmed |
| OQ-10 | Retention, account deletion, export, and privacy/legal policy | Obtain legal/product policy before Private Beta; do not improvise deletion behavior |
| OQ-11 | Beta invitation and registration policy | Invite-only registration is recommended for the 50-user Private Beta |
| OQ-12 | Exact reminder timing, timezone behavior, and quiet hours | User timezone, local morning delivery, configurable quiet hours; exact defaults need approval |
| OQ-13 | Opening-balance cutoff and historical backdating | Treat opening balance as the start-of-day balance on a chosen ledger start date; transactions on/after that date affect it; reject earlier transactions in MVP |
| OQ-14 | Supported recurrence cadences and short-month behavior | One-off plus interval-based weekly, monthly, and yearly; a monthly day missing from a short month falls on that month’s last day; no arbitrary RRULE in MVP |
| OQ-15 | How a completed planned purchase consumes a linked savings allocation | User confirms the amount released from the linked goal; atomically record the expense and a goal withdrawal/release so reserved money is not double-counted |

## Governance and change control

1. Every implementation issue MUST reference requirement IDs and applicable ADRs.
2. A proposed ADR becomes `Accepted` only after review; implementation MUST NOT silently treat it as accepted.
3. Requirement changes MUST update affected product, UX, architecture, security, database, and test documents in the same change.
4. A feature is complete only with the evidence required by the [release checklist](testing/RELEASE-CHECKLIST.md).
5. Future roadmap items are not requirements until promoted through a new approved specification.

## Current limitations of this foundation

- No application code, infrastructure, schema migration, or executable test has been created.
- No legal, privacy, tax, or regulated-financial-services review has occurred.
- No usability study, visual prototype, accessibility audit, penetration test, load test, or restore test has occurred.
- Capacity, recovery, and latency values in these documents are proposed engineering targets and require validation.
