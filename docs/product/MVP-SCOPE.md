# KFin MVP Scope

**Status:** Draft — review required<br>
**Release:** Private Beta (maximum 50 real users)<br>
**Implementation gate:** Closed until specification approval

## 1. Scope rule

The MVP is the smallest production-quality release that lets one person securely maintain a manual picture of current money, actual activity, upcoming obligations, debt, savings intentions, and planned purchases. “Small” limits capability, not security, accessibility, data integrity, or operational readiness.

An item is in scope only when it is listed here and supported by approved product, UX, architecture, security, database, and test requirements. A roadmap idea is not implicit permission to implement it.

## 2. In-scope capabilities

### 2.1 Account and security

- Invite-controlled registration policy for the Private Beta, subject to OQ-11.
- Email verification by OTP.
- Email/password login.
- Persistent, revocable authenticated session.
- Current-session logout and all-session logout.
- Forgot/reset/change password.
- Basic profile: display name, locale, timezone, base currency.
- Active-session list and individual revocation.
- Concise security history for successful/failed sensitive events.
- Abuse controls, audit events, secure error handling, and user-data isolation.

### 2.2 Manual money position

- One user-visible aggregate liquid-money account with opening balance under the recommended OQ-03 decision; the underlying account boundary remains extensible.
- Current balance derived from posted transactions.
- One base currency per user; VND is the proposed beta default.
- No currency conversion, multi-account transfers, or reconciliation in MVP unless OQ-03 is resolved differently and those semantics are separately specified.

### 2.3 Income

- One-time/flexible income entry.
- Fixed recurring income definitions and generated occurrences.
- Explicit receipt confirmation.
- Monthly confirmed and projected totals shown separately.

### 2.4 Expenses

- Amount-first Global Add form available from primary navigation.
- Fixed essential, variable essential, and daily/discretionary classes, plus an orthogonal unexpected-expense flag.

`Global Add` is the single-surface fast entry required by the MVP. The roadmap term “Quick Add” is reserved for future presets, one-tap shortcuts, or widgets and is not silently promoted here.
- Default categories.
- Recurring fixed expense schedules.
- Create, inspect, edit, and delete/void own records with recalculation.

### 2.5 Debt

- Debt profile with principal, user-maintained outstanding amount, optional disclosed rate, payment amount/frequency, due date, status, and history.
- Generated/one-off due payment occurrences.
- Explicit payment confirmation with optional principal/interest/fee allocation.
- Upcoming/due/overdue communication.
- No authoritative interest accrual engine.

### 2.6 Savings

- Multiple goals.
- Target, allocated amount, planned contribution, optional target date, and progress.
- Contribution, withdrawal, and correction history.
- Proposed virtual-reserve behavior, pending OQ-08.

### 2.7 Planned purchases

- Purchase name, target price/date, status, and optional savings-goal relationship.
- Explicit conversion/link to an actual expense when purchased.
- Approved linked-goal release behavior that prevents a completed purchase from leaving already-spent money reserved (OQ-15).

### 2.8 Dashboard, schedule, and reminders

- Current balance.
- Selected-month confirmed income and grouped outflow.
- Transparent spendable estimate after its formula is approved.
- Urgent upcoming obligations.
- Savings-goal progress.
- Unified schedule for expected inflows and outflows.
- In-app reminder center; opt-in email reminders are proposed.
- 7-day, 3-day, due-today, and overdue reminder stages.
- Simple, deduplicated cash-flow shortfall warning.

### 2.9 Product quality

- Responsive Web application and installable PWA.
- Accessible, reusable KFin design system.
- Honest loading, empty, offline, validation, success, and error states.
- Production telemetry without financial payloads.
- Staging/production separation, health checks, backups, restore test, rollback, and incident basics.

## 3. Required MVP outcomes by capability

| Capability | Outcome required before Private Beta |
|---|---|
| Registration | An eligible person can create and verify one account without revealing whether arbitrary emails are registered. |
| Session | A returning user resumes securely; revoked/expired sessions cannot be replayed. |
| Quick expense | A user can record a valid basic expense on one mobile surface with clear success/failure and no duplicate on retry. |
| Monthly overview | Aggregates reconcile exactly to the underlying posted transactions for the selected timezone/month. |
| Recurrence | Occurrences are generated idempotently and remain projected until explicitly confirmed. |
| Payment status | Due date passage yields due/overdue, never paid. |
| Debt | Payment history and displayed outstanding amount remain consistent after create/edit/reversal paths supported by the specification. |
| Savings | Goal amount is explainable from allocation history and is not double-counted as cash. |
| Authorization | Automated tests prove User A cannot read or mutate User B’s records across every object API. |
| Recovery | Backup restoration and release rollback are performed and evidenced in a production-like environment. |

## 4. Out of MVP

The following are expressly excluded unless a new specification promotes them:

- Bank, wallet, card, payroll, or payment-provider integration.
- Payment initiation or automatic verified payment status.
- Multi-currency conversion and exchange-rate services.
- Multiple exposed money accounts, transfers, and reconciliation unless separately promoted after OQ-03 review.
- Household/shared finance and delegated access.
- Category customization beyond supplied defaults.
- Data import/export (legal access requirements still need a policy decision).
- Push notifications, SMS, chat-app notifications.
- Native Android/iOS store packages; Capacitor remains a future packaging path.
- Offline transaction mutation/synchronization.
- Advanced comparison, forecasting, recommendation, or AI.
- Custom report builder.
- Automated interest accrual, amortization schedule, refinancing advice.
- Investments, tax, credit scoring, crypto, invoicing, or business accounting.
- Microservices, Kafka, Redis, Kubernetes, blockchain, or a separate analytics warehouse.

## 5. Product boundaries and caveats

- KFin is a user-maintained record and can be incomplete or stale.
- “Safe to spend” is an estimate based on entered balances and confirmed/upcoming records, not a guarantee.
- KFin does not verify lender statements or bank balances.
- Financial summaries must communicate their as-of time and scope.
- User-facing deletion, retention, and export behaviors are blocked by OQ-10; backend design must avoid making an eventual compliant policy impossible.
- Supporting data correction does not permit silently rewriting security audit history.

## 6. Definition of MVP complete

The MVP is complete only when all applicable items below have evidence:

1. Specifications and ADRs are approved and traceable to implementation work.
2. In-scope acceptance outcomes pass automated and manual tests.
3. Threat-model mitigations are implemented and reviewed.
4. WCAG 2.2 AA core-flow review and small-screen review pass.
5. Cross-user authorization tests pass for every financial resource.
6. Migration, backup restoration, and rollback drills pass.
7. Monitoring, alert routing, support ownership, and incident runbooks are active.
8. Privacy/legal documents, retention policy, and beta consent are approved.
9. No unresolved critical/high security vulnerability exists; accepted lower risks have owners and expiry dates.
10. The release checklist is signed for the initial five-user cohort.

A compilation, deployment, or happy-path demonstration alone does not satisfy this definition.

## 7. Scope change procedure

Any request to add an excluded capability must include:

- user problem and evidence;
- changed requirements and non-goals;
- UX and accessibility impact;
- data model and migration impact;
- threat-model and privacy impact;
- operational cost;
- tests and release criteria;
- roadmap decision and approver.

Until approved, it remains a roadmap candidate.
