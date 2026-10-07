# KFin MVP Scope

**Status:** Draft — review required<br>
**Release:** Private Beta (maximum 50 real users)<br>
**Implementation gate:** CLOSED until specification approval and blocker resolution

## 1. Scope rule

The MVP is the smallest production-quality release that lets one person securely maintain a manual picture of current money, actual activity, upcoming obligations, debt, savings intentions, and planned purchases. “Small” limits capability, not security, accessibility, data integrity, or operational readiness.

An item is in scope only when it is listed here and supported by approved product, UX, architecture, security, database, and test requirements. A roadmap idea is not implicit permission to implement it.

## 2. In-scope capabilities

### 2.1 Account and security

- Registration with a mandatory single-use, expiring Private Beta invitation code; no server-side email-allowlist alternative.
- Email verification by OTP.
- Email/password login.
- Persistent, revocable authenticated session.
- Current-session logout and all-session logout.
- Forgot/reset/change password.
- Basic profile: display name, locale, timezone, base currency.
- Active-session list and individual revocation.
- Concise security history for successful/failed sensitive events.
- Identity-verified deletion request handling with 7-day cancellation grace and approved active-data purge procedure; the request channel requires legal/privacy approval.
- Abuse controls, audit events, secure error handling, and user-data isolation.

### 2.2 Manual money position

- One user-visible aggregate liquid-money account; no account picker or transfers.
- One base currency per user, VND default, immutable after financial data exists.
- Authoritative balance snapshots with visible as-of time.
- Current balance derived from the latest snapshot plus current-impact posted transactions in that snapshot segment.
- Historical backfill that remains visible in reports but does not alter current balance when already included in the snapshot.
- Deliberate manual authoritative-balance snapshot update and old/new anchor disclosure.
- No currency conversion, multi-account breakdown, transfers, or bank/account-statement reconciliation workflow.

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

- Debt profile with principal, user-maintained outstanding amount, optional informational annual rate/as-of/source, payment amount/frequency, due date, status, and history.
- Generated/one-off due payment occurrences.
- Explicit payment confirmation with optional user-supplied principal/interest/fee allocation; omitted and unclassified values remain unknown.
- Upcoming/due/overdue communication.
- No authoritative principal/interest/fee inference, interest accrual, amortization, payoff, or lender-outstanding engine.
- Safe cash-only/latest-explicit correction boundaries; historical correction with later outstanding-affecting records remains blocked by `SPEC-DEBT-01`.

### 2.6 Savings

- Multiple goals.
- Target, manually maintained current amount/as-of date, planned contribution, optional target date, and progress.
- Absolute `Update current amount` action; no contribution/withdrawal cash ledger.
- Old/new amount audit metadata for corrections and linked-purchase use.
- Active current amounts reduce safe-to-spend but do not change aggregate cash or monthly income/outflow.

### 2.7 Planned purchases

- Purchase name, target price/date, status, and optional savings-goal relationship.
- Explicit conversion/link to an actual expense when purchased.
- User-confirmed deduction from a linked goal’s current amount, committed atomically with the actual expense and purchase completion.

### 2.8 Dashboard, schedule, and reminders

- Current balance.
- Selected-month confirmed income and grouped outflow.
- Transparent conservative safe-to-spend estimate: authoritative current balance minus unpaid outgoing occurrences due through current user-local month-end minus current amounts on active savings goals; projected income is excluded and negative results remain visible.
- Urgent upcoming obligations.
- Savings-goal progress from manual current amounts.
- Unified schedule for expected inflows and outflows using one-off/every-N-week/every-N-month/every-N-year patterns; missing monthly dates use the month’s last day.
- In-app notification center only; no payment-reminder email/push/SMS/chat.
- Eligible outgoing obligations receive 7-day, 3-day, due-today, and first-overdue stages evaluated server-side at 09:00 user-local time; scheduled income has no fixed-stage notification.
- One first-overdue notification per occurrence; no daily/weekly repeat.
- Closed app and delayed return only affect viewing persisted notification state; they never replay stages or change money state.
- Downtime, late occurrence creation, or timezone change may yield at most one catch-up notification per occurrence in a recovery evaluation; exact stage selection remains blocked by `SPEC-REM-01`, and no burst is permitted.
- Simple, deduplicated month-end cash-flow shortfall warning.

### 2.9 Product quality

- Responsive Web application and installable PWA.
- Vietnamese-first product content with English-ready message architecture.
- Accessible, reusable KFin design system.
- Honest loading, empty, offline, validation, success, and error states.
- Production telemetry without financial payloads.
- Staging/production separation, health checks, backups, restore test, rollback, and incident basics.

## 3. Required MVP outcomes by capability

| Capability | Outcome required before Private Beta |
|---|---|
| Registration | A person with a valid mandatory single-use expiring invitation code can create and verify one account without revealing arbitrary email/code state; email presence alone never grants admission. |
| Session | A returning user resumes securely; revoked/expired sessions cannot be replayed. |
| Account deletion | A verified request is cancellable for 7 days, then active data is purged under the approved map and a restore cannot resurrect it. |
| Quick expense | A user can record a valid basic expense on one mobile surface with clear success/failure and no duplicate on retry. |
| Balance snapshot | Current balance reconciles to the latest snapshot segment; historical backfill is labelled and cannot silently change it. |
| Monthly overview | Aggregates reconcile exactly to all posted transactions for the selected timezone/month, including labelled historical-only records. |
| Safe-to-spend | `STS-01`–`STS-15` prove authoritative current balance minus eligible unpaid outgoings through current user-local month-end minus active goal current amounts, with projected income excluded and negative result preserved. |
| Recurrence | Occurrences are generated idempotently and remain projected until explicitly confirmed. |
| Payment status | Due date passage yields due/overdue, never paid. |
| Reminders | `RCT-01`–`RCT-10` prove one 09:00 in-app occurrence/stage notification, closed-app independence, no repeated overdue, no scheduled-income stage, and no catch-up burst under the approved `SPEC-REM-01` policy. |
| Debt | `DCT-01`–`DCT-09` prove explicit-only payment/correction effects and consistent history/outstanding without inferred principal, interest, fee, or lender balance under the approved `SPEC-DEBT-01` policy. |
| Savings | Goal current amount matches the latest explicit user update/as-of date, retains old/new audit metadata, and is not counted as cash income/outflow. |
| Authorization | Automated tests prove User A cannot read or mutate User B’s records across every object API. |
| Recovery | Backup restoration and release rollback are performed and evidenced in a production-like environment. |

## 4. Out of MVP

The following are expressly excluded unless a new specification promotes them:

- Bank, wallet, card, payroll, or payment-provider integration.
- Payment initiation or automatic verified payment status.
- Multi-currency conversion and exchange-rate services.
- Multiple exposed money accounts, account transfers, and bank/account reconciliation.
- Household/shared finance and delegated access.
- Category customization beyond supplied defaults.
- Data import/export (legal access requirements still need a policy decision).
- Payment-reminder email, push notifications, SMS, and chat-app notifications. Authentication/security email remains required.
- Native Android/iOS store packages; Capacitor remains a future packaging path.
- Offline transaction mutation/synchronization.
- Advanced comparison, forecasting, recommendation, or AI.
- Custom report builder.
- Automated interest accrual, amortization schedule, refinancing advice.
- Investments, tax, credit scoring, crypto, invoicing, or business accounting.
- Microservices, Kafka, Redis, Kubernetes, blockchain, or a separate analytics warehouse.

## 5. Product boundaries and caveats

- KFin is a user-maintained record and can be incomplete or stale.
- “Safe to spend” is an estimate based on the authoritative entered balance, unpaid outgoing occurrences through current user-local month-end, and active goal current amounts; projected income is excluded. It is not a guarantee.
- KFin does not verify lender statements or bank balances.
- Financial summaries must communicate their as-of time and scope.
- Account deletion uses a 7-day cancellation grace followed by active-system purge; the request channel, deletion map, retained pseudonymous evidence, and legal basis must be approved before beta.
- Baseline maximum retention is 90 days for backups, 90 days for application logs, and 24 months for security/audit evidence, subject to legal reduction.
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
