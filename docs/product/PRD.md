# Product Requirements Document

**Product:** KFin — Know your money, Keep your future<br>
**Status:** Draft — Round 3 decision packets recorded; approval required<br>
**Version:** 0.4<br>
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

### Approved beta context

- Vietnam-first Private Beta with Vietnamese-first (`vi-VN`) UI; message architecture remains English-ready.
- Each user selects one base currency during onboarding; VND is the default and cannot be changed after financial data exists.
- `Asia/Ho_Chi_Minh` is the suggested timezone, not a forced value.
- Mobile Web/PWA is the most frequent interaction; desktop remains fully supported.
- Users understand that KFin is only as accurate as the data and balance snapshots they enter and confirm.
- A Southeast Asia hosting region is preferred, but cross-border processing and retention remain subject to Vietnamese legal/privacy review before beta.

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
| PRD-AUTH-01 | A permitted user MUST be able to register with email, password, and a valid single-use expiring Private Beta invitation code. Code consumption and account creation MUST be atomic. |
| PRD-AUTH-02 | The user MUST verify control of the email address with an expiring, single-use OTP before full account access. |
| PRD-AUTH-03 | Authentication and recovery responses MUST resist account enumeration and automated abuse. |
| PRD-AUTH-04 | A verified user MUST be able to sign in, remain signed in through a revocable persistent session, and sign out of the current session. |
| PRD-AUTH-05 | A user MUST be able to view recognizable active sessions and revoke one or all sessions. |
| PRD-AUTH-06 | A user MUST be able to request password recovery, reset a password with an expiring single-use token/challenge, and change a known password. |
| PRD-AUTH-07 | Password reset MUST revoke all existing sessions. Password change MUST revoke other sessions and rotate the current session, unless the approved security policy requires all sessions to end. |
| PRD-AUTH-08 | Security-relevant events MUST appear in an understandable security history where doing so does not create additional leakage. |
| PRD-AUTH-09 | Basic profile settings MUST include display name, locale, timezone, and base currency subject to MVP currency policy. |
| PRD-AUTH-10 | An identity-verified account-deletion request MUST enter a 7-day cancellable pending state, then invoke the legally approved active-data purge process. The beta request channel remains subject to privacy/legal review. |

OQ-11 is final: the invitation code is mandatory for every Private Beta registration. A server-side email allowlist MUST NOT replace the code or operate as an alternate registration mode.

### 7.2 Aggregate account, balance snapshots, and transactions

MVP exposes exactly one aggregate liquid-money account per user. Multiple accounts and transfers are not available. Current balance is anchored by an authoritative user-entered snapshot so users may backfill older history without unexpectedly changing the current amount.

| ID | Requirement |
|---|---|
| PRD-FIN-01 | Onboarding MUST create one user-owned aggregate account and an initial balance snapshot with amount, currency, and visible as-of time. |
| PRD-FIN-02 | Current balance MUST equal the latest balance snapshot plus posted balance-impacting inflows minus posted balance-impacting outflows attached to that snapshot segment. |
| PRD-FIN-03 | A transaction MUST record positive amount, base currency, local occurrence date, type, category/classification, balance effect, and creation/update timestamps. A note is optional. |
| PRD-FIN-04 | The user MUST be able to create, inspect, correct, and void their own transactions with clear effects on current balance and monthly reporting. |
| PRD-FIN-05 | All MVP financial records MUST use the user’s one base currency. Cross-currency aggregation, conversion, and invented exchange rates are prohibited. |
| PRD-FIN-06 | Financial writes MUST be idempotent against accidental duplicate submission where a client request identifier is supplied. |
| PRD-FIN-07 | Mutations affecting financial values MUST be attributable in an audit trail without storing secrets or unnecessary sensitive payloads. |
| PRD-FIN-08 | A transaction explicitly entered as pre-snapshot historical backfill MUST appear in period/category reports but MUST NOT alter current balance. It MUST be visibly labelled as already included in the snapshot. |
| PRD-FIN-09 | Creating a new manual authoritative-balance snapshot MUST start a new balance segment without deleting or rewriting earlier transactions/snapshots. This is not a bank/account-statement reconciliation workflow. |
| PRD-FIN-10 | If same-day timing makes snapshot inclusion ambiguous, KFin MUST ask whether the transaction is already included rather than infer silently. |
| PRD-FIN-11 | Changing a transaction’s balance effect or anchor MUST be a deliberate correction with consequence preview, concurrency protection, and audit evidence. |

### 7.3 Income

| ID | Requirement |
|---|---|
| PRD-INC-01 | The user MUST be able to record one-time/flexible income for a selected date. |
| PRD-INC-02 | The user MUST be able to define a fixed recurring income schedule with amount, cadence, start date, and optional end date. |
| PRD-INC-03 | A scheduled income occurrence MUST remain projected until the user confirms receipt; confirmation creates or links one posted income transaction. |
| PRD-INC-04 | Monthly views MUST distinguish confirmed income from projected income and aggregate all confirmed records in the user’s timezone. |
| PRD-INC-05 | The example of 4,000,000 VND recurring salary plus 350,000 VND and 280,000 VND daily receipts MUST total 4,630,000 VND confirmed monthly income only after the scheduled salary is confirmed received. |

Explicit confirmation is the approved OQ-04 policy. OQ-14 limits recurrence to one-off plus every-N-week, every-N-month, and every-N-year schedules; a missing monthly day resolves to the final day of that month.

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
| PRD-DEBT-01 | A debt MUST support name, original principal, current outstanding balance, optional informational annual rate with as-of/source context, expected payment amount/frequency, next due date, status, and payment history. |
| PRD-DEBT-02 | A debt payment MUST remain due until the user confirms it. Confirmation records cash outflow and any user-provided principal/interest/fee split, visibly identifying a partial/unclassified remainder. If principal or a new lender-reported balance is unavailable, KFin MUST leave outstanding balance unchanged and visibly retain its prior as-of date; it MUST NOT assume the full payment reduced principal. |
| PRD-DEBT-03 | The product MUST NOT calculate, allocate, or claim authoritative principal, interest, fee, accrued interest, amortization, payoff date, or lender outstanding. Omitted values and unclassified remainder remain unknown until explicitly supplied. |
| PRD-DEBT-04 | The product MUST visibly identify upcoming, due-today, and overdue debt obligations. |
| PRD-DEBT-05 | A supported payment correction MUST preserve linked old/new payment and cash-transaction evidence, separately preview cash and outstanding effects, and alter outstanding only from explicit principal or a new lender-reported balance. |
| PRD-DEBT-06 | Automatic correction/recomputation MUST be unavailable when later outstanding-affecting records, reordered as-of dates, missing prior state, or an inferred component would make the result unsafe. The historical correction/rebase/rejection workflow is blocked by `SPEC-DEBT-01`. |

### 7.6 Savings goals

| ID | Requirement |
|---|---|
| PRD-SAV-01 | A user MUST be able to create multiple goals with name, target amount, manually maintained current amount, current-amount as-of date, planned contribution, optional cadence, and optional target date. |
| PRD-SAV-02 | Progress MUST show both amount and percentage; overfunded and no-target-date states MUST remain valid. |
| PRD-SAV-03 | The user MUST update an absolute current amount rather than create contribution/withdrawal ledger entries in MVP. |
| PRD-SAV-04 | Each current-amount update MUST retain previous value, new value, as-of date, actor, reason/source, and timestamp as audit/correction metadata. It MUST NOT be presented as a cash transaction. |
| PRD-SAV-05 | Active goal current amounts reduce safe-to-spend but MUST NOT change aggregate balance or monthly income/outflow. |
| PRD-SAV-06 | The UI MUST explain that a goal amount is a user-declared reserve estimate, not proof of money held in a separate bank account. |
| PRD-SAV-07 | Archiving a goal MUST preserve its latest value and amount-change audit history while removing it from active reserves. |

### 7.7 Planned purchases

| ID | Requirement |
|---|---|
| PRD-PLAN-01 | A planned purchase MUST support name, target price, optional target date, status, and optional savings-goal relationship. |
| PRD-PLAN-02 | A planned purchase MUST NOT be included as ordinary spending before it is actually purchased. |
| PRD-PLAN-03 | Marking a purchase complete MUST require explicit confirmation and either create or link a posted expense. |
| PRD-PLAN-04 | If a linked goal funded the purchase, the user MUST confirm how much to deduct from its manual current amount. The deduction cannot exceed either the actual purchase amount or current goal amount. |
| PRD-PLAN-05 | Posted expense, old/new goal amount audit record, and purchase completion MUST commit atomically and idempotently so the goal is not reduced twice. |
| PRD-PLAN-06 | Cancelling, completing, or archiving a purchase MUST NOT automatically archive, zero, or delete a linked goal. |

### 7.8 Schedule, reminders, and warnings

| ID | Requirement |
|---|---|
| PRD-REM-01 | The schedule MUST combine upcoming fixed expenses, debt payments, and scheduled income while preserving each item’s direction and state. |
| PRD-REM-02 | Outgoing occurrences MUST support in-app notification stages at 7 days before, 3 days before, due today, and first overdue, evaluated at 09:00 in the user’s timezone. |
| PRD-REM-03 | Reaching a due date MUST NOT mark an occurrence paid. Only explicit confirmation or a future verified integration may do so. |
| PRD-REM-04 | Each eligible outgoing occurrence/stage MUST create at most one notification. First-overdue notification MUST NOT repeat daily or weekly while state is unchanged. |
| PRD-REM-05 | Payment reminders MUST be in-app only in MVP. Push, SMS, chat, and payment-reminder email are excluded; required authentication/security email remains separate. |
| PRD-REM-06 | Notifications MUST be actionable, readable/dismissible, and deduplicated across worker retries, downtime catch-up, and timezone changes. |
| PRD-REM-07 | A cash-flow warning MUST identify the relevant month-end window, obligations included, available amount used, shortfall, and calculation time. |
| PRD-REM-08 | Cash-flow warnings MUST be presented as estimates based on user-entered data, not guarantees or financial advice. |
| PRD-REM-09 | Schedules MUST support one-off plus every-N-week, every-N-month, and every-N-year patterns. Missing monthly day 29/30/31 MUST use that month’s final local date; daily and arbitrary RRULE patterns are excluded. Yearly 29-February behavior and hard bounds require approval before implementation. |
| PRD-REM-10 | Reminder evaluation MUST be server-side and independent of whether the Web/PWA is open. Closing or returning to the app MUST NOT replay elapsed stages, create a burst, or alter financial state; the app displays persisted notification state. |
| PRD-REM-11 | If worker downtime, late occurrence creation, or a timezone change makes multiple stages already elapsed, one recovery evaluation MUST NOT create more than one catch-up notification for that occurrence. The exact single stage, or whether none is emitted, is **BLOCKER `SPEC-REM-01`** for Product Owner decision. |
| PRD-REM-12 | Before catch-up insertion, the worker MUST recheck current occurrence state and uniqueness. Confirmed, skipped, or cancelled occurrences receive no new payment stage, and delayed app return never creates a notification itself. |

### 7.9 Dashboard and reporting

| ID | Requirement |
|---|---|
| PRD-DASH-01 | The initial dashboard viewport MUST prioritize current balance, spendable estimate, urgent upcoming obligations, and goal progress. |
| PRD-DASH-02 | The dashboard MUST distinguish actual, projected, reserved, overdue, and estimated values through text and structure, not color alone. |
| PRD-DASH-03 | The selected month MUST show confirmed income, expense groups, debt outflow, and net movement without treating manual savings-goal amount changes as income or expense. |
| PRD-DASH-04 | Users MUST be able to inspect the records behind an aggregate. |
| PRD-DASH-05 | Charts MUST be limited to those that answer a defined user question; decorative or redundant charts are prohibited. |
| PRD-DASH-06 | Empty/incomplete data MUST produce honest setup guidance rather than fabricated zero-confidence conclusions. |
| PRD-DASH-07 | Safe-to-spend MUST equal authoritative current balance minus unpaid outgoing occurrences due through the end of the current user-local calendar month minus current amounts on active savings goals. Projected income MUST be excluded, paid outgoings MUST NOT be double-subtracted, and a negative result MUST NOT be clamped. |

## 8. Approved financial definitions

- **Aggregate account:** The single MVP container representing the user’s liquid money in one base currency. It does not expose bank/cash/e-wallet subaccounts.
- **Balance snapshot:** An authoritative user-entered aggregate balance at a visible as-of instant. The latest snapshot anchors current-balance calculation.
- **Current-impact transaction:** A posted user-confirmed inflow/outflow recorded as a delta after its anchor snapshot. It enters current balance only while that anchor is the latest snapshot; after a newer snapshot it remains unchanged as prior-segment evidence.
- **Historical-only transaction:** A posted pre-snapshot backfill record included in period/category reporting but excluded from current-balance arithmetic because the snapshot already includes it.
- **Scheduled occurrence:** An expected inflow/outflow that does not affect balance until explicitly confirmed and linked to a posted transaction.
- **Current balance:** Latest balance-snapshot amount plus posted current-impact inflows minus posted current-impact outflows attached to that snapshot segment.
- **Monthly income/outflow:** All posted transactions whose user-local occurrence date falls in the selected calendar month, including labelled historical-only records.
- **Savings reserve:** The current amount manually declared on an active savings goal. It is neither a cash account nor income/expense and is not independently verified.
- **Safe-to-spend estimate (`safe_to_spend.v1`):** Authoritative current balance minus unpaid outgoing occurrences due through the end of the current user-local calendar month, including unresolved overdue occurrences, minus current amounts on active savings goals. Projected income is excluded until explicitly received and posted; confirmed outgoings are not double-subtracted. The UI exposes components, anchor, horizon, as-of time, formula version, exclusions, and any unclamped negative result.
- **Cash-flow warning:** A warning when current balance is below outgoing obligations due through month end. It recalculates after relevant mutation/snapshot change and at least daily.

A snapshot boundary means monthly net movement and current balance may not reconcile through a simple all-history sum. Calculation disclosure MUST explain the anchor and historical-only records.

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

- Activation: verified users who establish an initial authoritative balance snapshot and save a first transaction.
- Habit: active beta users recording or reviewing finances weekly.
- Entry usability: basic-expense completion rate and median task time in usability sessions.
- Clarity: task-based comprehension of current balance, due obligations, and goal progress.
- Reliability: successful financial writes, job delivery, API latency, and error-free sessions.
- Security: authentication abuse indicators, unauthorized-access test results, and security-event review.
- Feedback: reported trust, confusion, missing capability, and abandonment reasons.

No financial note text, raw amount, password, token, or OTP may be sent to product analytics.

## 11. Constraints and dependencies

- At most 50 invited Private Beta users; each registration requires a single-use invitation code.
- Manual data entry and authoritative-balance snapshot updates; no bank/payment integration or account-statement matching.
- Email delivery is required for verification, recovery, and approved security messages only—not payment reminders.
- Cloudflare + managed PaaS + managed PostgreSQL is the accepted logical topology. Specific providers/domain/region/budget are intentionally deferred until before Release Candidate and block that gate.
- Vietnam-first content/support and Southeast Asia hosting preference do not replace Vietnamese legal/privacy review.
- The accepted deletion/retention baseline requires legal approval and automated enforcement before external beta.
- PWA installability is in MVP; native Capacitor packaging is not automatically in MVP.

## 12. Explicit non-goals

- Bank sync, payment initiation, payment confirmation integration, open banking.
- Investment, tax, credit-score, lending, insurance, or regulated advice.
- AI recommendations or forecasting.
- Shared, household, team, or business accounts.
- Multiple money accounts, transfers, bank/account-statement reconciliation workflows, or account-level balances.
- Multiple concurrent currencies, foreign exchange, or crypto assets.
- Custom category management, data export, push notifications, advanced analytics, and native store releases unless separately promoted.
- Automatic debt interest accrual or full double-entry accounting.
- Social features, advertising, or sale of user financial data.

## 13. Decision status and remaining blockers

OQ-01 through OQ-19 have recorded dispositions in the [Product Decision Log](DECISION-LOG.md). OQ-17 deliberately defers specific provider/domain/region/budget selection until before Release Candidate and is a release risk, not permission to claim deployment readiness.

Round 3 makes the following decisions/evidence **ready for authorized review**; it does not approve them:

| Blocker | Product decision or evidence still required | Product-accountable role | Post-Round-3 state |
|---|---|---|---|
| `SPEC-AUTH-01` | Fresh rotated session after verification or explicit sign-in, with result/cookie/CSRF/event/multi-tab/retry behavior | Product Owner; Security co-approval | OPEN — decision ready |
| `SPEC-AUTH-02` | Complete invitation/password/OTP/reset/abuse/session/rotation/password-change policy | Security Owner; Product co-approval | OPEN — decision ready |
| `SPEC-FIN-01` | Correction/void/link/report/audit/retry model | Product Owner; Financial Integrity/Data/Security co-approval | OPEN — decision ready |
| `SPEC-FIN-02` | Snapshot/transaction linearization and conflict/retry contract | Data Owner; Architecture/Security/Financial Integrity co-approval | OPEN — decision ready |
| `SPEC-DEBT-01` | Explicit-fact replay or mandatory fresh lender-reported balance for historical correction with later events | Product Owner; Financial Integrity/Data co-approval | OPEN — decision ready |
| `SPEC-SCH-01` | Leap-day fallback, recurrence/generation bounds, and exact series-edit behavior | Product Owner; Data/Architecture co-approval | OPEN — decision ready |
| `SPEC-REM-01` | Catch-up emission/precedence/window/suppression/timezone/late-creation/state-race tuple | Product Owner; Architecture/Operations/QA co-approval | OPEN — decision ready |
| `SPEC-SEC-01` | PostgreSQL RLS posture or explicit compensating controls/residual risk | Security Owner; Data/Architecture co-approval | OPEN — decision ready |
| `SPEC-SEC-02` | Event-by-event visibility, safe fields, delivery/display, and retention classification | Product Owner; Security/Privacy co-approval | OPEN — decision ready |
| `SPEC-DEL-01` | Request/cancel authentication, deletion map, retained evidence, restore exclusion, legal hold and provider proof | Privacy/Legal Owner; Product/Security/Operations co-approval | OPEN — decision ready |
| `SPEC-UX-01` | Versioned visual/content/usability/accessibility evidence and sign-off | UX/Accessibility Owner; Product co-approval | OPEN — evidence ready |
| `SPEC-GOV-01` | Named assignments, delegation/conflict rules, physical limits, evidence and sign-off history | Product Owner; cross-domain co-approval | OPEN — evidence/assignment ready |

Exact decision dimensions, immutable safety constraints, required evidence, and binary acceptance criteria are normative in the [Round 3 remediation report](../reviews/SPECIFICATION-REMEDIATION-ROUND-3.md). Approval records belong in the [Approval and Evidence Register](../governance/APPROVAL-AND-EVIDENCE-REGISTER.md). RPO/RTO, incident/support ownership, and `RC-PROV-01` provider selection remain due at their stated gates.

## 14. Approval criteria

This PRD may move from `Draft` to `Approved` only when:

1. accepted OQ decisions are reflected consistently in all affected specifications;
2. MVP scope and non-goals are accepted;
3. financial definitions are validated against representative user scenarios;
4. legal/privacy ownership is assigned;
5. UX, architecture, security, database, and test documents are mutually consistent;
6. every due `SPEC-*` blocker has an authorized outcome and passing evidence rather than only a documented decision packet;
7. named approvers, date, source version, and evidence links are recorded in the governance register and version control.
