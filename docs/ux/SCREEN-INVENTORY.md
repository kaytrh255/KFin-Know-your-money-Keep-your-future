# KFin Initial Screen Inventory

**Status:** Draft — Round 3 decision dependencies recorded; specification/evidence review required<br>
**Evidence status:** Screen-list review is not visual prototype, usability, or accessibility acceptance<br>
**Purpose:** Define the minimum screen map before visual design and implementation.<br>
**Note:** Routes are proposals for Web/PWA navigation, not API contracts.

## 1. Navigation map

```text
Public
├─ Sign in
├─ Register / invite acceptance
├─ Verify email
├─ Forgot password
└─ Reset password

Authenticated
├─ Onboarding
│  ├─ Profile and preferences
│  └─ Aggregate money / initial balance snapshot
├─ Home
├─ Activity
│  ├─ Transaction detail
│  └─ Edit transaction
├─ Global Add
├─ Schedule
│  ├─ Occurrence detail / confirm
│  └─ Schedule definition form
├─ Plan
│  ├─ Debts
│  │  ├─ Debt detail
│  │  ├─ Debt form
│  │  └─ Record payment
│  ├─ Savings goals
│  │  ├─ Goal detail
│  │  ├─ Goal form
│  │  └─ Update current amount
│  └─ Planned purchases
│     ├─ Purchase detail
│     ├─ Purchase form
│     └─ Complete purchase
├─ Notifications
└─ Profile & Security
   ├─ Profile/preferences
   ├─ Money setup / authoritative balance snapshot
   ├─ Security overview/history
   ├─ Active sessions
   └─ Change password
```

## 2. Public and authentication screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| AUTH-01 | `/sign-in` | Sign in | Start/resume secure access | Email/password, password manager, generic error, rate limit, Forgot password, Register |
| AUTH-02 | `/register` | Accept invite and register | Consume a mandatory valid single-use beta invitation and create an eligible account; no email-allowlist fallback | Invite code; generic behavior for invalid/expired/used/revoked/wrong-email states; email; password policy; terms/privacy acknowledgement; enumeration resistance |
| AUTH-03 | `/verify-email` | Verify email | Enter/resend OTP | Masked destination, expiry, paste/autofill, attempts, resend cooldown, safe support path for a wrong address; no implicit email-change feature |
| AUTH-04 | `/forgot-password` | Forgot password | Request recovery | Generic response, rate limit, return to sign-in |
| AUTH-05 | `/reset-password` | Reset password | Validate challenge and set password | Invalid/expired/replayed challenge, policy, success and sign-in |
| AUTH-06 | `/auth/result` | Authentication result | Durable success/failure for sensitive flow | No secret/query leakage, next action, support correlation ID when needed |

A dedicated result screen is used only when a persistent state is clearer than a toast. Deep links must remove reset secrets from URL/history as early as safely possible.

## 3. Onboarding screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| ONB-01 | `/onboarding/profile` | Personal setup | Display name, Vietnamese-first locale context, timezone, one base currency | VND/Asia-Ho-Chi-Minh suggestions are editable; currency locks after financial data |
| ONB-02 | `/onboarding/money` | Initial balance snapshot | Explain one aggregate manual model and establish authoritative current balance | Amount, exact as-of time, snapshot/backfill explanation, no false bank-sync implication |
| ONB-03 | `/onboarding/complete` | Setup complete | Orient user to Home and first entry | Global Add action, skip optional tutorial, honest incomplete state |

The accepted one-account MVP does not expose account taxonomy in ONB-02; the underlying account ownership boundary remains internal.

## 4. Primary application screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| HOME-01 | `/` | Home | Answer the four core questions | Authoritative balance/anchor/as-of; signed safe-to-spend through user-local month-end with balance, unpaid outgoing, active-goal, and projected-income-exclusion disclosure; needs attention; month summary; goals; incomplete data |
| ACT-01 | `/activity` | Activity | Inspect posted current-impact and historical-only records | Date grouping, month/type/classification/balance-effect filters, snapshot-boundary markers, pagination, empty states |
| ACT-02 | `/activity/:transactionId` | Transaction detail | Explain one actual record and its balance effect | Current-impact/historical-only label, latest versus prior snapshot segment, present-balance consequence, ownership-safe not found, linked occurrence/debt/purchase, correct/void |
| ACT-03 | `/activity/:transactionId/edit` | Correct transaction | Correct one record without hiding anchor impact | Fixed no-history-erasure/current-balance safety; balance/report/link consequence preview; conflict/version error; `SPEC-FIN-01`/`SPEC-FIN-02` blocked states for unsupported cross-segment/racing actions |
| ADD-01 | overlay / `/add` fallback | Global Add | Record routine current income/expense quickly | Amount-first, implicit account, defaults, unexpected flag, pre-snapshot historical switch, offline, idempotent save |
| ADD-02 | overlay / `/add/history` fallback | Add historical record | Backfill a record already represented by the balance snapshot | Historical-only explanation, same-day inclusion choice, current balance unchanged preview |
| SCH-01 | `/schedule` | Schedule agenda | Understand expected inflows/outflows | Date groups, upcoming/due/overdue/projected/paid filters, exact dates, empty state |
| SCH-02 | `/schedule/:occurrenceId` | Occurrence detail | Review and confirm/skip one occurrence | Expected vs actual, mark paid/received, skip, linked source/history |
| SCH-03 | `/schedule/new` and `/schedule/:scheduleId/edit` | Schedule form | Define recurring income/obligation | Kind, amount, cadence, date, end rule, occurrence preview, fixed-stage reminder explanation for eligible outgoings |
| PLAN-01 | `/plan` | Plan overview | Navigate debts, savings, purchases | Prioritized summaries, no combined misleading total |
| NOTIF-01 | `/notifications` | Notification center | Review persisted actionable product/security messages | Unread/read, type, exact time, deep link, mark read/all read, empty state; delayed return does not replay elapsed reminder stages; no catch-up burst or external-channel controls |

## 5. Debt screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| DEBT-01 | `/plan/debts` | Debt list | Compare active debt obligations | Outstanding/as-of, next due, status; no unsupported payoff projection |
| DEBT-02 | `/plan/debts/new` | Add debt | Capture a user-reported debt and schedule | Principal, outstanding/as-of, informational annual rate/as-of/source, payment/frequency/due date |
| DEBT-03 | `/plan/debts/:debtId` | Debt detail | Understand one debt and history | Outstanding/as-of, next due, schedule, payments, correction/archive |
| DEBT-04 | `/plan/debts/:debtId/edit` | Edit debt | Change future settings/correct profile | Historical impact disclosure, future schedule behavior |
| DEBT-05 | overlay / nested route | Record debt payment | Confirm actual outflow and user-supplied split | Total, explicit principal/interest/fee, visible unclassified remainder, explicit outstanding impact, linked occurrence |
| DEBT-06 | overlay / nested route | Correct outstanding balance | Reconcile with an explicit lender-reported value | New amount, as-of date, reason, audit consequence; no inferred difference |
| DEBT-07 | overlay / nested route | Correct debt payment | Preserve evidence while correcting explicit facts only | Old/new cash effect separated from outstanding effect; split/unclassified values; later-record safety check; `SPEC-DEBT-01` blocked state with no guessed preview |

Debt screens must not imply that KFin calculates or allocates authoritative principal, interest, fee, lender outstanding, amortization, or payoff.

## 6. Savings screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| SAV-01 | `/plan/savings` | Savings goal list | Review manually reported progress across goals | Current/target, current as-of date, target date, archived filter, no-target state |
| SAV-02 | `/plan/savings/new` | Add goal | Create a target and declared reserve | Name, target, current amount/as-of, planned contribution, cadence/date, reserve explanation |
| SAV-03 | `/plan/savings/:goalId` | Goal detail | Understand reported progress and latest value | Current/target/as-of, old/new change audit summary, linked purchases, edit/archive |
| SAV-04 | `/plan/savings/:goalId/edit` | Edit goal plan | Update target/plan without disguising current-value change | Target/name/date/planned contribution, over-target handling |
| SAV-05 | overlay / nested route | Update current amount | Replace the absolute declared reserve | New amount/as-of, optional reason, old/new and safe-to-spend preview, conflict handling |

Savings screens must state that current amount is user-maintained and not a verified cash account.

## 7. Planned purchase screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| PUR-01 | `/plan/purchases` | Planned purchase list | See intended purchases separately from actual spending | Target price/date, status, linked goal, archived/completed filters |
| PUR-02 | `/plan/purchases/new` | Add planned purchase | Record intent | Name, target price/date, optional goal |
| PUR-03 | `/plan/purchases/:purchaseId` | Purchase detail | Understand funding/plan state | Linked goal, edit, cancel/archive, complete purchase |
| PUR-04 | `/plan/purchases/:purchaseId/edit` | Edit planned purchase | Update intent | No effect on actual activity |
| PUR-05 | overlay / nested route | Complete purchase | Convert intent into a posted expense | Actual amount/date/category, optional confirmed linked-goal current-amount deduction, old/new preview, no auto-archive |

## 8. Profile and security screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| SET-01 | `/settings/profile` | Profile and preferences | Maintain display name, locale, timezone, base currency policy | Timezone/month-boundary warning; currency change blocked if unsupported |
| SET-04 | `/settings/money` | Money setup and known-balance update | Review latest snapshot and create a new authoritative balance snapshot | Calculated vs actual amount, exact as-of time, new segment disclosure; no bank/account matching or account/transfer UI |
| SEC-01 | `/settings/security` | Security overview | Navigate password, sessions, history | Verified email, last password change, concise recommendations |
| SEC-02 | `/settings/security/password` | Change password | Reauthenticate and rotate credentials | Current/new password, policy, session consequence, durable success |
| SEC-03 | `/settings/security/sessions` | Active sessions | Identify and revoke access | Current marker, device/time, revoke one, sign out everywhere |
| SEC-04 | `/settings/security/history` | Security history | Review only approved user-visible account events | `SPEC-SEC-02` event classification; approved safe type/outcome/time/origin detail; operator-only exclusion; pagination/retention; unavailable until policy approval |
| SET-03 | `/settings/about` | Privacy, terms, help | Access policy/support information | Version, privacy/terms, support/deletion request channel, status link if provided |

There is no reminder-channel settings screen in MVP: reminders are in-app only at fixed approved stages/timing. Self-service account-deletion UI is not automatically in scope; the identity-verified beta request channel must be selected by legal/privacy review. Data export UI remains deferred unless legally required.

## 9. Global fallback screens

| ID | Route/context | Screen | Required behavior |
|---|---|---|---|
| SYS-01 | Unknown public route | Public not found | Return to sign-in/home without exposing internals |
| SYS-02 | Unknown/private object | Private unavailable | Same generic unavailable presentation for not-found/forbidden object |
| SYS-03 | Fatal client boundary | Application error | Retry/reload, support correlation ID, no stack trace/private payload |
| SYS-04 | Offline navigation | Offline state | Explain read/write limitations; no claimed queued mutation |
| SYS-05 | Maintenance/unavailable | Service unavailable | Plain status, retry timing if known, support/status link |
| SYS-06 | Session expired | Reauthentication gate | Preserve safe in-memory draft, sign in, deliberate retry only as same user |

## 10. Surface adaptation rules

| Surface | Compact | Expanded |
|---|---|---|
| Global Add | Keyboard-safe bottom sheet or full-screen form | Compact dialog/popover |
| Record payment / update goal amount | Bottom sheet, full screen if fields expand | Dialog or side panel with URL state |
| Entity detail | Full route | Full route; optional side panel only if deep linking/history remain correct |
| Confirmation | Bottom sheet/dialog | Dialog |
| Filters | Drawer/sheet | Inline toolbar/popover |
| Navigation | Fixed bottom bar | Persistent sidebar |

No behavior may exist only in a hover menu. Critical actions must remain discoverable on touch.

## 11. State coverage matrix

Every MVP screen must be reviewed against applicable states before it is implementation-ready:

- unauthenticated/session-resolving/session-expired;
- initial loading/background refresh;
- first-use empty/filtered empty;
- populated minimum/typical/large values;
- validation/conflict/authorization/server failure;
- offline/reconnected/uncertain write;
- compact keyboard open/safe area/landscape;
- desktop keyboard-only/zoom;
- screen reader/reduced motion;
- locale with long labels and VND large amounts.

## 12. Screens explicitly deferred

- Custom category management.
- Import/export center.
- Shared household/member management.
- Bank connection and reconciliation.
- Advanced reports and comparison dashboards.
- Push notification setup.
- Native-only permission/settings screens.
- Multi-currency exchange interface.
- Automated debt amortization planner.

## 13. Screen readiness gate

This is a necessary per-screen evidence list, not visual/UX acceptance or permission to bypass the globally CLOSED Implementation Gate. After all centralized blockers and the global gate are resolved, a screen can enter implementation only when it has:

1. linked requirements and flow IDs;
2. approved compact and expanded interaction design;
3. content for all states and destructive actions;
4. keyboard/focus/screen-reader behavior;
5. server validation and ownership behavior;
6. analytics/privacy decision;
7. loading/error/offline behavior;
8. acceptance tests and responsive test cases.

Completing this list is necessary but does not close `SPEC-UX-01`. The versioned evidence manifest and named acceptance in UX Specification §16 remain mandatory.

## 14. Round 3 decision-dependent screen register

| Blocker | Screens/surfaces that cannot be accepted yet | Exact UX dependency | Fixed safety boundary | Status |
|---|---|---|---|---|
| `SPEC-AUTH-01` | AUTH-03/06, ONB-01 | Verification must end in one approved session or explicit-sign-in outcome, with retry/multi-tab/result copy | No session fixation; only an approved authenticated context enters onboarding | OPEN — decision ready |
| `SPEC-AUTH-02` | AUTH-01–05, SEC-02/03 | Visible policy, expiry, limits, recovery, rotation/replay and session consequences | Invitation code mandatory; generic errors; password manager/paste support | OPEN — decision ready |
| `SPEC-FIN-01` | ACT-02/03, ADD-01/02, SCH-02, DEBT-07, PUR-05 | Correction/void/link/report/audit and idempotent/stale consequence previews | No history erasure, silent segment movement or double effect | OPEN — decision ready |
| `SPEC-FIN-02` | ONB-02, SET-04, ADD-01/02, ACT-03 | Snapshot/transaction race conflict and deliberate retry result | No silent re-anchor or ambiguous successful save | OPEN — decision ready |
| `SPEC-DEBT-01` | DEBT-03/06/07 | Later-event correction must use approved replay/fresh-balance policy or explicit rejection | Never infer principal, interest, fee or outstanding | OPEN — decision ready |
| `SPEC-SCH-01` | SCH-01–03, DEBT-02/04 | Leap-day preview, bounds, occurrence/future edit choices and split consequences | Monthly missing-day fallback fixed; unsupported scope hidden | OPEN — decision ready |
| `SPEC-REM-01` | NOTIF-01, SCH-01/02 | Catch-up stage/result, recovery expiry and suppression explanation | Zero/one catch-up, never a burst; occurrence state stays authoritative | OPEN — decision ready |
| `SPEC-SEC-02` | SEC-01/04, NOTIF-01 | Which event appears, safe details, delivery/deep link and display retention | No secrets, false exact location, internal rule or financial payload | OPEN — decision ready |
| `SPEC-DEL-01` | SET-03 and any promoted deletion surface/result | Request/cancel identity, pending access, deadline/purge/retention/legal-hold/provider copy | Seven-day cancellation and no restoration reactivation | OPEN — decision ready |
| `SPEC-UX-01` | Every MVP screen | Visual, Vietnamese content, state, usability and accessibility evidence in both compact and expanded contexts | Specification/design tokens cannot substitute for acceptance evidence | OPEN — evidence ready |

A screen can be prototyped to compare unresolved options, but no option may be labelled accepted or implementation-ready until its blocker has a named, evidence-backed approval record.
