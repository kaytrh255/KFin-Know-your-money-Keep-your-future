# Product Requirements Document

**Product:** KFin — Know your money, Keep your future<br>
**Status:** Draft — review required<br>
**Version:** 0.1<br>
**Date:** 2026-10-07<br>
**Target release:** Private Beta, at most 50 real users

## 1. Purpose

KFin is a production-oriented personal finance platform for individuals who manually track money, obligations, debt, savings, and planned purchases. It must help a user understand their present position and near-term commitments without presenting a noisy accounting interface.

KFin is not a university prototype, bank, payment processor, investment product, tax system, or financial adviser. Private Beta success means that a small number of real users can safely and repeatedly rely on it while the team learns what should be specified next.

## 2. Product vision

A KFin user should be able to open the product and answer, with minimal interpretation:

1. How much money do I have?
2. Where is my money going?
3. How much can I safely spend?
4. Am I progressing toward my financial goals?

The product promise is **clarity and control**, not prediction or prescriptive financial advice.

## 3. Target user and context

### Primary user

An individual who:

- tracks personal, not business or shared-household, finances;
- has a mix of fixed and flexible income;
- pays recurring essential expenses and possibly debt;
- wants to save toward one or more goals;
- enters data manually and needs entry to be fast on a phone;
- uses one private account and expects persistent, secure access.

### Assumed context — pending OQ-01 and OQ-02

- Vietnamese-first Private Beta, commonly using VND and `Asia/Ho_Chi_Minh` time.
- Mobile web/PWA is the most frequent interaction; desktop remains fully supported.
- Users understand that KFin is only as accurate as the data they enter and confirm.

These are proposals, not approved demographic or legal decisions.

## 4. User problems

| ID | Problem |
|---|---|
| P-01 | Financial information is fragmented across memory, notes, and separate apps. |
| P-02 | Ordinary expense entry takes enough effort that records become incomplete. |
| P-03 | Recurring obligations are easy to overlook or falsely assume paid. |
| P-04 | Current cash, upcoming obligations, and savings intentions are difficult to reconcile. |
| P-05 | Debt and goal progress are hard to understand at a glance. |
| P-06 | Many finance products are visually dense, untrustworthy, or poor on small screens. |

## 5. Goals and desired outcomes

| ID | Goal | Private Beta outcome signal |
|---|---|---|
| G-01 | Make daily recording fast | A returning mobile user can save a basic expense in a target median of 10 seconds or less in moderated testing. |
| G-02 | Make the current position understandable | Users can identify balance, month income/outflow, reserved obligations, and spendable estimate without assistance. |
| G-03 | Prevent missed or falsely completed obligations | Due items remain unpaid until explicit confirmation and are visibly due/overdue. |
| G-04 | Support intentional saving | Users can create several goals and understand progress and planned contribution. |
| G-05 | Establish trust | No known cross-user data exposure; sensitive actions are auditable; security and privacy language is clear. |
| G-06 | Learn safely from real use | Roll out gradually and capture errors, performance, usage, and structured feedback. |

Outcome targets are validation goals, not claims that testing has passed.

## 6. Product principles

1. **Truth before decoration.** Actual, scheduled, overdue, and estimated values must be visibly different.
2. **Explicit financial actions.** A due date never implies a payment occurred; scheduled income never implies money was received.
3. **Fast common path, safe exceptional path.** Basic entry is short; destructive or security-sensitive actions require proportionate confirmation.
4. **Progressive disclosure.** Show decisions first and detail on demand.
5. **User ownership and isolation.** Every private record belongs to the authenticated user; client-supplied ownership is never trusted.
6. **Explain calculations.** Derived values expose their period, inputs, and exclusions.
7. **No shame or alarmism.** Warnings are specific, calm, actionable, and deduplicated.
8. **Accessible by default.** Color is never the sole signal; interaction supports keyboard, screen reader, zoom, and touch.
9. **Manual-first honesty.** KFin does not imply live bank knowledge in MVP.

## 7. Functional requirements

### 7.1 Account and security

| ID | Requirement |
|---|---|
| PRD-AUTH-01 | A permitted user MUST be able to register with email and password under the approved beta access policy. |
| PRD-AUTH-02 | The user MUST verify control of the email address with an expiring, single-use OTP before full account access. |
| PRD-AUTH-03 | Authentication and recovery responses MUST resist account enumeration and automated abuse. |
| PRD-AUTH-04 | A verified user MUST be able to sign in, remain signed in through a revocable persistent session, and sign out of the current session. |
| PRD-AUTH-05 | A user MUST be able to view recognizable active sessions and revoke one or all sessions. |
| PRD-AUTH-06 | A user MUST be able to request password recovery, reset a password with an expiring single-use token/challenge, and change a known password. |
| PRD-AUTH-07 | Password reset MUST revoke all existing sessions. Password change MUST revoke other sessions and rotate the current session, unless the approved security policy requires all sessions to end. |
| PRD-AUTH-08 | Security-relevant events MUST appear in an understandable security history where doing so does not create additional leakage. |
| PRD-AUTH-09 | Basic profile settings MUST include display name, locale, timezone, and base currency subject to MVP currency policy. |

### 7.2 Financial accounts and transactions

A minimal account/ledger concept is required to make “current balance” mathematically meaningful. The current recommendation is one user-visible aggregate liquid-money account for MVP, because exposing multiple accounts without specified transfers would distort income/outflow. The schema may preserve an account boundary for later evolution. This proposal is review-blocked by OQ-03.

| ID | Requirement |
|---|---|
| PRD-FIN-01 | The user MUST be able to define an opening balance for the approved manual money-account model. Under the current recommendation, MVP exposes one aggregate account. |
| PRD-FIN-02 | Current account and total balance MUST be derived from opening balances and posted inflow/outflow transactions, not silently overwritten. |
| PRD-FIN-03 | A transaction MUST record positive amount, currency, local occurrence date, type, category/classification, account, and creation/update timestamps. A note is optional. |
| PRD-FIN-04 | The user MUST be able to create, inspect, edit, and delete/void their own transactions with clear recalculation. |
| PRD-FIN-05 | The system MUST prevent cross-currency aggregation unless an explicitly specified exchange-rate policy exists. MVP MUST NOT invent exchange rates. |
| PRD-FIN-06 | Financial writes MUST be idempotent against accidental duplicate submission where a client request identifier is supplied. |
| PRD-FIN-07 | Mutations affecting financial values MUST be attributable in an audit trail without storing secrets or unnecessary sensitive payloads. |
| PRD-FIN-08 | Opening-balance and backdating behavior MUST follow the approved OQ-13 cutoff. Under the current proposal, opening balance is at the start of the ledger date and earlier transactions are rejected rather than double-counted. |

### 7.3 Income

| ID | Requirement |
|---|---|
| PRD-INC-01 | The user MUST be able to record one-time/flexible income for a selected date. |
| PRD-INC-02 | The user MUST be able to define a fixed recurring income schedule with amount, cadence, start date, and optional end date. |
| PRD-INC-03 | A scheduled income occurrence MUST remain projected until the user confirms receipt; confirmation creates or links one posted income transaction. |
| PRD-INC-04 | Monthly views MUST distinguish confirmed income from projected income and aggregate all confirmed records in the user’s timezone. |
| PRD-INC-05 | The example of 4,000,000 VND recurring salary plus 350,000 VND and 280,000 VND daily receipts MUST total 4,630,000 VND confirmed monthly income only after the scheduled salary is confirmed received. |

PRD-INC-03 is the recommended resolution of OQ-04 and requires approval. Supported recurrence cadences and short-month behavior are review-blocked by OQ-14.

### 7.4 Expenses and spending

| ID | Requirement |
|---|---|
| PRD-EXP-01 | The user MUST be able to record fixed essential, variable essential, and daily/discretionary outflows distinctly, and MUST be able to mark an outflow as unexpected independently of that class. |
| PRD-EXP-02 | Default categories MUST cover rent, electricity, water, internet, required subscriptions, food, transportation, entertainment, shopping, repair, emergency, unexpected bills, and other. |
| PRD-EXP-03 | Global Add MUST allow a basic expense to be recorded from any primary screen without navigating through several pages. |
| PRD-EXP-04 | A fixed recurring essential expense MAY create scheduled occurrences but MUST NOT create a paid transaction without user confirmation. |
| PRD-EXP-05 | Editing or deleting an expense MUST immediately and consistently update derived balances and monthly summaries. |
| PRD-EXP-06 | “Unexpected” MUST be a purposeful orthogonal flag, not inferred from category or amount; an unexpected expense can still retain its essential/daily class. |

### 7.5 Debt

| ID | Requirement |
|---|---|
| PRD-DEBT-01 | A debt MUST support name, original principal, current outstanding balance, optional disclosed interest rate, expected payment amount/frequency, next due date, status, and payment history. |
| PRD-DEBT-02 | A debt payment MUST remain due until the user confirms it. Confirmation records cash outflow and the user-provided principal/interest/fee split where available. If principal or a new lender-reported balance is unavailable, KFin MUST leave outstanding balance unchanged and visibly retain its prior as-of date; it MUST NOT assume the full payment reduced principal. |
| PRD-DEBT-03 | The product MUST NOT calculate or claim authoritative accrued interest, amortization, payoff date, or lender balance until those methods are separately specified. |
| PRD-DEBT-04 | The product MUST visibly identify upcoming, due-today, and overdue debt obligations. |
| PRD-DEBT-05 | Users MUST be able to correct a payment while preserving a security/audit event and consistent outstanding balance. |

### 7.6 Savings goals

| ID | Requirement |
|---|---|
| PRD-SAV-01 | A user MUST be able to create multiple goals with name, target amount, starting/current allocated amount, planned contribution, optional cadence, and optional target date. |
| PRD-SAV-02 | Progress MUST show both amount and percentage; overfunded and no-target-date states MUST remain valid. |
| PRD-SAV-03 | Contributions, withdrawals, and corrections MUST have dated entries so current allocated amount is explainable. |
| PRD-SAV-04 | Savings allocations MUST NOT be double-counted as either income or expense. Their effect on the spendable estimate MUST be explicit. |
| PRD-SAV-05 | Archiving a goal MUST preserve its history. |

The proposed “virtual allocation” interpretation is review-blocked by OQ-08.

### 7.7 Planned purchases

| ID | Requirement |
|---|---|
| PRD-PLAN-01 | A planned purchase MUST support name, target price, optional target date, status, and optional savings-goal relationship. |
| PRD-PLAN-02 | A planned purchase MUST NOT be included as ordinary spending before it is actually purchased. |
| PRD-PLAN-03 | Marking a purchase complete MUST require explicit confirmation and either create or link a posted expense. |
| PRD-PLAN-04 | If the purchase uses a linked goal under the recommended OQ-15 policy, the user MUST confirm the allocation amount to release; expense creation and savings release MUST commit atomically so reserved money is not double-counted. |
| PRD-PLAN-05 | Cancelling or archiving a purchase MUST preserve relevant history and MUST NOT silently delete a linked goal. |

### 7.8 Schedule, reminders, and warnings

| ID | Requirement |
|---|---|
| PRD-REM-01 | The schedule MUST combine upcoming fixed expenses, debt payments, and scheduled income while preserving each item’s direction and state. |
| PRD-REM-02 | Outgoing occurrences MUST support 7-days-before, 3-days-before, due-today, and overdue states. Exact delivery preferences are subject to OQ-06 and OQ-12. |
| PRD-REM-03 | Reaching a due date MUST NOT mark an occurrence paid. Only explicit confirmation or a future verified integration may do so. |
| PRD-REM-04 | Notifications MUST be deduplicated, actionable, dismissible/readable, and rate controlled. |
| PRD-REM-05 | A cash-flow warning MUST identify the relevant time window, obligations included, available amount used, shortfall, and calculation time. |
| PRD-REM-06 | Cash-flow warnings MUST be presented as estimates based on user-entered data, not guarantees or financial advice. |

### 7.9 Dashboard and reporting

| ID | Requirement |
|---|---|
| PRD-DASH-01 | The initial dashboard viewport MUST prioritize current balance, spendable estimate, urgent upcoming obligations, and goal progress. |
| PRD-DASH-02 | The dashboard MUST distinguish actual, projected, reserved, overdue, and estimated values through text and structure, not color alone. |
| PRD-DASH-03 | The selected month MUST show confirmed income, expense groups, debt outflow, savings allocations, and net movement without double counting. |
| PRD-DASH-04 | Users MUST be able to inspect the records behind an aggregate. |
| PRD-DASH-05 | Charts MUST be limited to those that answer a defined user question; decorative or redundant charts are prohibited. |
| PRD-DASH-06 | Empty/incomplete data MUST produce honest setup guidance rather than fabricated zero-confidence conclusions. |

## 8. Proposed financial definitions

These definitions are intentionally explicit and remain subject to product review.

- **Posted transaction:** A user-confirmed money inflow or outflow that affects a manual account balance.
- **Scheduled occurrence:** An expected inflow or outflow that does not affect balance until confirmed and linked to a posted transaction.
- **Current balance:** Sum of active account opening balances plus posted inflows minus posted outflows through today, in one currency.
- **Monthly income/outflow:** Posted transactions whose user-local occurrence date falls within the selected calendar month.
- **Savings allocated:** Net contribution entries assigned to active savings goals. It is an envelope/reserve, not a second bank balance.
- **Spendable estimate (proposed):** Current liquid balance minus unpaid outgoing obligations due through month end minus active savings allocations that the user has chosen to reserve. Future income is excluded until received. The UI must expose these components and allow no negative value to be disguised.
- **Cash-flow warning:** A warning when current liquid balance is below outgoing obligations due in a displayed horizon. It is recalculated after every relevant mutation and at least daily.

The formula cannot be approved until OQ-03, OQ-05, and OQ-08 are resolved.

## 9. Non-functional product requirements

| ID | Requirement |
|---|---|
| PRD-NFR-01 | The product MUST be responsive from 320 CSS pixels through large desktop layouts without horizontal page scrolling in primary flows. |
| PRD-NFR-02 | Core flows MUST meet WCAG 2.2 AA; touch targets SHOULD be at least 44 × 44 CSS pixels. |
| PRD-NFR-03 | Financial data MUST not be cached by shared intermediaries or written to analytics/session-replay payloads. |
| PRD-NFR-04 | The application MUST degrade safely: a failed write never appears as saved, and retry behavior must not create duplicates. |
| PRD-NFR-05 | User-facing dates and schedule decisions MUST use the stored user timezone; database timestamps MUST use UTC. |
| PRD-NFR-06 | Amount formatting MUST use the user locale and currency while calculations use integers, never binary floating point. |
| PRD-NFR-07 | Production errors MUST provide a correlation identifier without exposing stack traces, SQL, secrets, or another user’s data. |
| PRD-NFR-08 | The Web/PWA MUST remain the primary interface; any mobile packaging must reuse it rather than fork product logic. |

Detailed quality attributes are in the architecture, security, UX, and test specifications.

## 10. Success measures for the beta

Success measures will be baselined during internal testing; they are not grounds for dark-pattern analytics.

- Activation: verified users who establish an opening balance and save a first transaction.
- Habit: active beta users recording or reviewing finances weekly.
- Entry usability: basic-expense completion rate and median task time in usability sessions.
- Clarity: task-based comprehension of current balance, due obligations, and goal progress.
- Reliability: successful financial writes, job delivery, API latency, and error-free sessions.
- Security: authentication abuse indicators, unauthorized-access test results, and security-event review.
- Feedback: reported trust, confusion, missing capability, and abandonment reasons.

No financial note text, raw amount, password, token, or OTP may be sent to product analytics.

## 11. Constraints and dependencies

- At most 50 Private Beta users; scale only after evidence.
- Manual data entry; no bank/payment integration.
- Email delivery is required for verification and recovery and must be configured before those flows can pass.
- Cloudflare, a managed application runtime, and managed PostgreSQL are proposed but vendors are not selected.
- Legal/privacy terms, support ownership, incident contacts, and data retention must exist before inviting external users.
- PWA installability is in MVP; native Capacitor packaging is not automatically in MVP.

## 12. Explicit non-goals

- Bank sync, payment initiation, payment confirmation integration, open banking.
- Investment, tax, credit-score, lending, insurance, or regulated advice.
- AI recommendations or forecasting.
- Shared, household, team, or business accounts.
- Multiple concurrent currencies, foreign exchange, or crypto assets.
- Custom category management, data export, push notifications, advanced analytics, and native store releases unless separately promoted.
- Automatic debt interest accrual or full double-entry accounting.
- Social features, advertising, or sale of user financial data.

## 13. Open decisions

The canonical decision list is in [the specification index](../README.md#review-blocking-open-decisions). Product approval must record an answer, owner, and date for OQ-01 through OQ-15. In addition, review must decide:

- whether users may create multiple financial accounts in the first UI or receive one default account;
- what edit/delete semantics users expect for old financial records;
- whether the dashboard period begins at calendar month start or supports a user-defined payday cycle later;
- which events generate user-visible security history and how long that history remains available;
- whether invite-only registration is enforced by one-time invite codes or a server-side allowlist.

## 14. Approval criteria

This PRD may move from `Draft` to `Approved` only when:

1. review-blocking open decisions have recorded dispositions;
2. MVP scope and non-goals are accepted;
3. proposed financial definitions are validated against representative user scenarios;
4. legal/privacy ownership is assigned;
5. UX, architecture, security, database, and test documents are mutually consistent;
6. approved reviewers and date are recorded in version control.
