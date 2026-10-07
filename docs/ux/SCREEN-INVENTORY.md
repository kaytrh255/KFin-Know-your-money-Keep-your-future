# KFin Initial Screen Inventory

**Status:** Draft — review required<br>
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
│  └─ Money account / opening balance
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
│  │  └─ Contribution / withdrawal
│  └─ Planned purchases
│     ├─ Purchase detail
│     ├─ Purchase form
│     └─ Complete purchase
├─ Notifications
└─ Profile & Security
   ├─ Profile/preferences
   ├─ Money setup / opening balance
   ├─ Security overview/history
   ├─ Active sessions
   └─ Change password
```

## 2. Public and authentication screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| AUTH-01 | `/sign-in` | Sign in | Start/resume secure access | Email/password, password manager, generic error, rate limit, Forgot password, Register |
| AUTH-02 | `/register` | Register / accept invite | Create eligible beta account | Invite state, email, password policy, terms/privacy acknowledgement, generic existing-account behavior |
| AUTH-03 | `/verify-email` | Verify email | Enter/resend OTP | Masked destination, expiry, paste/autofill, attempts, resend cooldown, change/correct email policy |
| AUTH-04 | `/forgot-password` | Forgot password | Request recovery | Generic response, rate limit, return to sign-in |
| AUTH-05 | `/reset-password` | Reset password | Validate challenge and set password | Invalid/expired/replayed challenge, policy, success and sign-in |
| AUTH-06 | `/auth/result` | Authentication result | Durable success/failure for sensitive flow | No secret/query leakage, next action, support correlation ID when needed |

A dedicated result screen is used only when a persistent state is clearer than a toast. Deep links must remove reset secrets from URL/history as early as safely possible.

## 3. Onboarding screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| ONB-01 | `/onboarding/profile` | Personal setup | Display name, locale, timezone, currency | Auto-detected values are suggestions; clear manual selection |
| ONB-02 | `/onboarding/money` | Opening balance | Explain manual model and establish account | Account name/default, amount, as-of date, no false bank-sync implication |
| ONB-03 | `/onboarding/complete` | Setup complete | Orient user to Home and first entry | Global Add action, skip optional tutorial, honest incomplete state |

If product review chooses a single default account, ONB-02 may avoid exposing account taxonomy while retaining the underlying account model.

## 4. Primary application screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| HOME-01 | `/` | Home | Answer the four core questions | Current balance/as-of, spendable estimate/disclosure, needs attention, month summary, goals, incomplete data |
| ACT-01 | `/activity` | Activity | Inspect actual posted money movement | Date grouping, month/type/classification filters, pagination, empty states; account filter only if OQ-03 later approves multiple exposed accounts |
| ACT-02 | `/activity/:transactionId` | Transaction detail | Explain one actual record | Ownership-safe not found, linked occurrence/debt/purchase, edit, remove/void |
| ACT-03 | `/activity/:transactionId/edit` | Edit transaction | Correct one record | Impact preview for linked records, validation, unsaved change, conflict/version error |
| ADD-01 | overlay / `/add` fallback | Global Add | Record routine income/expense quickly | Amount-first, defaults, unexpected classification, offline, idempotent save |
| SCH-01 | `/schedule` | Schedule agenda | Understand expected inflows/outflows | Date groups, upcoming/due/overdue/projected/paid filters, exact dates, empty state |
| SCH-02 | `/schedule/:occurrenceId` | Occurrence detail | Review and confirm/skip one occurrence | Expected vs actual, mark paid/received, skip, linked source/history |
| SCH-03 | `/schedule/new` and `/schedule/:scheduleId/edit` | Schedule form | Define recurring income/obligation | Kind, amount, cadence, date, reminders, end rule, occurrence preview |
| PLAN-01 | `/plan` | Plan overview | Navigate debts, savings, purchases | Prioritized summaries, no combined misleading total |
| NOTIF-01 | `/notifications` | Notification center | Review actionable product/security messages | Unread/read, type, exact time, deep link, mark read/all read, empty state |

## 5. Debt screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| DEBT-01 | `/plan/debts` | Debt list | Compare active debt obligations | Outstanding/as-of, next due, status; no unsupported payoff projection |
| DEBT-02 | `/plan/debts/new` | Add debt | Capture a user-reported debt and schedule | Principal, outstanding/as-of, informational rate, payment/frequency/due date |
| DEBT-03 | `/plan/debts/:debtId` | Debt detail | Understand one debt and history | Outstanding/as-of, next due, schedule, payments, correction/archive |
| DEBT-04 | `/plan/debts/:debtId/edit` | Edit debt | Change future settings/correct profile | Historical impact disclosure, future schedule behavior |
| DEBT-05 | overlay / nested route | Record debt payment | Confirm actual outflow/payment split | Total, principal/interest/fee reconciliation, outstanding impact, linked occurrence |
| DEBT-06 | overlay / nested route | Correct outstanding balance | Reconcile with lender-reported value | New amount, as-of date, reason, audit consequence |

## 6. Savings screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| SAV-01 | `/plan/savings` | Savings goal list | Review progress across goals | Current/target, target date, archived filter, no-target state |
| SAV-02 | `/plan/savings/new` | Add goal | Create explainable target and reserve | Name, target, initial allocation, planned contribution, cadence/date |
| SAV-03 | `/plan/savings/:goalId` | Goal detail | Understand progress and history | Allocation entries, progress, linked purchases, edit/archive |
| SAV-04 | `/plan/savings/:goalId/edit` | Edit goal | Update plan without rewriting history | Target/name/date/future contribution, over-target handling |
| SAV-05 | overlay / nested route | Contribution / withdrawal | Change virtual allocation | Direction, amount, date, spendable-estimate effect, confirmation |

All savings screens are blocked until OQ-08 confirms the accounting meaning.

## 7. Planned purchase screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| PUR-01 | `/plan/purchases` | Planned purchase list | See intended purchases separately from actual spending | Target price/date, status, linked goal, archived/completed filters |
| PUR-02 | `/plan/purchases/new` | Add planned purchase | Record intent | Name, target price/date, optional goal |
| PUR-03 | `/plan/purchases/:purchaseId` | Purchase detail | Understand funding/plan state | Linked goal, edit, cancel/archive, complete purchase |
| PUR-04 | `/plan/purchases/:purchaseId/edit` | Edit planned purchase | Update intent | No effect on actual activity |
| PUR-05 | overlay / nested route | Complete purchase | Convert intent into a posted expense | Actual amount/date/account/category, user-confirmed linked-goal release under OQ-15, confirmation |

## 8. Profile and security screens

| ID | Proposed route | Screen | Primary purpose | Critical states/actions |
|---|---|---|---|---|
| SET-01 | `/settings/profile` | Profile and preferences | Maintain display name, locale, timezone, base currency policy | Timezone/month-boundary warning; currency change blocked if unsupported |
| SET-04 | `/settings/money` | Money setup | Review/correct the approved account name, opening balance, and as-of date | Explain recalculation; deliberate correction; multi-account/transfer UI absent under recommended MVP |
| SEC-01 | `/settings/security` | Security overview | Navigate password, sessions, history | Verified email, last password change, concise recommendations |
| SEC-02 | `/settings/security/password` | Change password | Reauthenticate and rotate credentials | Current/new password, policy, session consequence, durable success |
| SEC-03 | `/settings/security/sessions` | Active sessions | Identify and revoke access | Current marker, device/time, revoke one, sign out everywhere |
| SEC-04 | `/settings/security/history` | Security history | Review important account events | Event type/outcome/time, privacy-safe origin detail, pagination |
| SET-02 | `/settings/notifications` | Reminder preferences | Choose approved channels/timing | In-app/email, timezone, quiet hours if approved, verification dependency |
| SET-03 | `/settings/about` | Privacy, terms, help | Access policy/support information | Version, privacy/terms, contact, status link if provided |

Account deletion/export UI is not listed as MVP until OQ-10 is resolved. Legal requirements may force promotion before beta.

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
| Record payment/contribution | Bottom sheet, full screen if fields expand | Dialog or side panel with URL state |
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

A screen can enter implementation only when it has:

1. linked requirements and flow IDs;
2. approved compact and expanded interaction design;
3. content for all states and destructive actions;
4. keyboard/focus/screen-reader behavior;
5. server validation and ownership behavior;
6. analytics/privacy decision;
7. loading/error/offline behavior;
8. acceptance tests and responsive test cases.
