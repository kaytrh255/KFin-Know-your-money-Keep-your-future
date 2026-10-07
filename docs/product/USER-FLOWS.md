# KFin Main User Flows

**Status:** Draft — review required<br>
**Scope:** Private Beta Web/PWA<br>
**Related:** [PRD](PRD.md), [UX specification](../ux/UX-SPEC.md), [screen inventory](../ux/SCREEN-INVENTORY.md)

## 1. Flow conventions

- A flow begins only after required authorization and ownership checks.
- “Save” means the server committed the write and returned a stable identifier; optimistic UI alone is not success.
- Repeated submissions with the same idempotency key must not duplicate financial effects.
- Scheduled and actual money are always distinct.
- Errors keep safe user input when possible and offer a clear retry; they never claim success ambiguously.
- Every flow must define loading, empty, validation, connectivity, server-error, and recovery behavior.

## 2. First-use map

```text
Invite / permitted registration
  → Create account
  → Generic verification instruction
  → Verify email OTP
  → Sign in (or establish verified session under approved policy)
  → Set display name, timezone, locale, base currency
  → Create default/manual account and opening balance
  → Dashboard setup state
  → Add first income or expense
```

The policy for automatically signing in after verification is not yet approved. Whatever is selected must rotate credentials/session identifiers and produce one unambiguous result.

## 3. Authentication and security flows

### UF-AUTH-01 — Register and verify email

**Precondition:** Registration policy permits the request.

1. User enters email and a password meeting the visible policy.
2. Client submits over TLS without logging credentials.
3. Server normalizes email, applies IP/email/invite abuse controls, and returns a generic response.
4. If permitted, server stores an Argon2id password hash and sends a single-use OTP.
5. User enters the OTP on a screen that shows a masked destination and expiry/resend guidance.
6. Server validates purpose, digest, attempts, expiry, and consumed state.
7. On success, email becomes verified and a security event is recorded.
8. User continues to onboarding under the approved post-verification session policy.

**Failure/recovery**

- Existing email, blocked invite, and non-existing email must not create an enumeration oracle.
- Incorrect code shows remaining-safe guidance, not secret comparison details.
- Expired/consumed code offers controlled resend.
- Resend invalidates or supersedes prior active codes according to the approved challenge policy.
- Rate limit response is calm and does not reveal account existence.

### UF-AUTH-02 — Sign in and resume session

1. User submits email/password.
2. Server applies layered abuse controls and generic failure behavior.
3. On success, server creates a new opaque session and sets the Web/PWA secure cookie.
4. Application loads `/session` (or equivalent) and receives only the authenticated profile/session context.
5. Closing and reopening resumes while idle and absolute lifetimes remain valid.
6. Expired/revoked sessions are rejected, cookie is cleared, and the user is returned to sign in with a non-alarming explanation.

### UF-AUTH-03 — Sign out current/all sessions

- **Current:** User chooses Sign out → server revokes current session → clears cookie → returns to public sign-in.
- **All:** User confirms Sign out everywhere → server revokes all user sessions atomically → clears current cookie → records event → returns to sign-in.
- A failed revocation cannot be presented as successful.

### UF-AUTH-04 — Forgot and reset password

1. User submits email; response is identical regardless of account existence.
2. Eligible verified account receives a time-limited, single-use reset link/challenge.
3. User submits a new password; server validates challenge and password policy.
4. Server changes the password hash and revokes all sessions in one transaction or fail-safe sequence.
5. User sees confirmation and signs in again.
6. Replayed, expired, or replaced challenges fail generically.

### UF-AUTH-05 — Change known password

1. Authenticated user enters current and new passwords.
2. Reauthentication, rate limiting, password policy, and breached/common-password controls apply.
3. Server updates hash, revokes other sessions, rotates current session, and records event.
4. User receives confirmation and can inspect security history.

### UF-AUTH-06 — Review and revoke sessions

1. Security screen lists current and other sessions using approximate device/browser, created time, last active time, and approximate location only if privacy-approved.
2. Current session is clearly marked.
3. User revokes one other session or confirms revocation of all.
4. List updates only after server confirmation.

## 4. Money setup and transaction flows

### UF-FIN-01 — Establish opening balance

1. Onboarding explains that KFin is manual and asks what aggregate liquid money should be represented.
2. User accepts the approved default account or names it if the reviewed OQ-03 experience allows naming.
3. User enters opening balance, ledger start date, and currency fixed to base currency in MVP. Under the OQ-13 recommendation, the amount means balance at the start of that local date.
4. Review shows that transactions on/after the ledger start date adjust current balance, earlier records are not accepted in MVP, and multiple accounts/transfers are not being tracked under the recommended model.
5. Server creates the user-owned account; dashboard exposes the as-of status.

Changing an opening balance later is a deliberate correction with recalculation and audit metadata, not an unexplained balance overwrite.

### UF-FIN-02 — Global Add expense

**Entry:** Global Add action from any authenticated primary screen.

1. Bottom sheet/full-screen mobile form opens with **Expense** selected and amount focused.
2. User enters amount using a locale-appropriate numeric keypad.
3. User chooses a recent/default category and classification; date defaults to today; default account is preselected.
4. Optional fields (note, different date/account) remain collapsed or secondary.
5. Save disables repeat taps and sends an idempotency key.
6. On server confirmation, sheet closes, a concise undo/edit affordance may appear, and visible totals invalidate/refetch.

**Validation/recovery**

- Amount must be positive and within database/product bounds.
- Decimal rules follow the selected currency; VND rejects fractional minor units.
- Connectivity failure keeps entered values and offers retry; it must not queue a hidden offline write.
- If result is uncertain, client checks the request/idempotency result before offering a new save.

**Usability target:** Valid basic entry in one surface, with no required note and no multi-page navigation.

### UF-FIN-03 — Add flexible income

Same amount-first pattern as Global Add, with **Income** selected. The date determines the confirmed monthly aggregate. Successful save increases the selected account balance.

### UF-FIN-04 — Edit or remove a transaction

1. User opens Activity and selects a transaction.
2. Detail shows amount, date, classification, account, linked schedule/debt/purchase if any, and last update.
3. Edit validates all affected invariants and warns when a linked item will change.
4. Remove uses the approved delete/void policy and asks confirmation with concrete impact.
5. Server applies one consistent transaction, records audit metadata, and recalculates summaries.

Linked financial records must not become orphaned. Exact historical edit/void semantics remain an open product decision.

## 5. Recurring income and obligation flows

### UF-SCH-01 — Create recurring income

1. User chooses Add → Recurring income.
2. Enters name, amount, account, cadence, first expected date, optional end date.
3. Review explicitly says occurrences are projected until confirmed received.
4. Server creates schedule and generates the bounded next occurrences idempotently.
5. Schedule and dashboard show projected values separately.

### UF-SCH-02 — Confirm income received

1. User opens an expected income occurrence.
2. Confirms or edits actual amount/date/account.
3. Server atomically creates one posted income transaction and links it to the occurrence.
4. Occurrence becomes confirmed; projected and confirmed totals update without double counting.

### UF-SCH-03 — Create and confirm recurring essential payment

1. User enters payee/title, essential classification, expected amount, cadence, first due date, reminders, and account.
2. Schedule generates future unpaid occurrences.
3. Reminder navigates to occurrence detail.
4. User selects Mark paid, verifies actual amount/date/account, and confirms.
5. Server atomically records one expense and links it; occurrence becomes paid.

Passing the due date performs step 2/overdue state only, never steps 4–5.

### UF-SCH-04 — Handle due, overdue, skip, or changed amount

- Due/overdue is derived from user-local date and unresolved state.
- User may confirm paid with an actual amount different from expected while preserving both values.
- “Skip occurrence” requires a reason/confirmation and does not create a transaction.
- Editing a recurrence defines whether only future unconfirmed occurrences or also a selected occurrence changes; paid history remains stable unless explicitly corrected.

## 6. Debt flows

### UF-DEBT-01 — Create debt

1. User enters name, original principal, current lender-reported outstanding balance and as-of date.
2. Optional interest rate is labelled informational; no automatic accrual claim is made.
3. User enters usual payment amount, frequency, first/next due date, and reminder preference.
4. Review explains expected occurrences and manual confirmation.
5. Server creates debt, schedule, and next occurrences atomically.

### UF-DEBT-02 — Record debt payment

1. User opens due occurrence or debt detail and chooses Record payment.
2. Enters actual total and date; optionally splits principal, interest, and fee or supplies a new lender-reported outstanding balance with as-of date.
3. If a complete split is supplied, parts must reconcile to total.
4. Review shows cash-balance effect. It shows an outstanding-balance effect only when principal or a new reported balance is known.
5. Server records expense, debt payment, and occurrence link atomically. It updates outstanding balance only from known principal or an explicit new lender-reported value.
6. If neither is available, the prior outstanding amount and as-of date remain unchanged and the detail prompts later reconciliation; KFin never assumes the full payment is principal.

If the lender-reported balance later differs, the user makes an explicit balance correction with as-of date; KFin does not invent accrued interest.

## 7. Savings and planned-purchase flows

### UF-SAV-01 — Create and fund a savings goal

1. User enters name, target, existing allocated amount, planned contribution/cadence, and optional target date.
2. Review explains that allocated savings is a virtual reserve under the proposed OQ-08 model.
3. Goal is created with progress and an explainable initial allocation entry.
4. Add contribution records amount/date and reduces the spendable reserve calculation, not total cash.
5. Withdrawal reverses allocation only after confirmation.

If OQ-08 is resolved differently, this flow and the data model must be revised before implementation.

### UF-PLAN-01 — Create planned purchase

1. User enters item name, target price/date and optionally links a savings goal.
2. Purchase appears in Plan, not Activity or actual monthly spending.
3. Funding progress uses the linked goal without changing it.

### UF-PLAN-02 — Complete planned purchase

1. User chooses Mark purchased.
2. Enters actual amount/date/account/category.
3. If a goal is linked, review asks how much of its allocation funded the purchase. Under the recommended OQ-15 policy, that amount becomes a goal withdrawal/release; it may not exceed the goal’s available allocation or actual purchase amount.
4. Review explains the cash expense, savings-release effect, and whether any goal allocation remains. Goal archive/retain behavior remains a separate explicit choice.
5. Server atomically creates/links the expense, records the approved goal release, and sets the purchase completed.
6. Dashboard and Activity update without double-counting already-reserved money; the purchase, goal, and release history remain inspectable.

## 8. Dashboard and reminder flows

### UF-DASH-01 — Understand current position

1. Home loads a skeleton that preserves layout, then values as of a visible time.
2. User sees current balance and data freshness.
3. Spendable estimate shows amount, horizon, and “How calculated” disclosure.
4. Urgent obligations list shows amount, due date, and state with action.
5. Month summary distinguishes confirmed income/outflow and projected values.
6. Goal card shows progress and next planned contribution.
7. Selecting any aggregate opens a filtered source list.

When setup is incomplete, the dashboard explains which missing data prevents a trustworthy calculation.

### UF-REM-01 — Act on a reminder

1. Worker creates/delivers at most one reminder for occurrence + stage + channel.
2. User opens it and lands on the owned occurrence, after authentication.
3. User confirms paid/received, views details, or dismisses/marks read.
4. Confirming resolves future overdue reminders for that occurrence.
5. Dismissal does not mark payment complete.

### UF-REM-02 — Cash-flow warning

1. System detects available amount below outgoing obligations in the approved horizon.
2. One deduplicated warning states the amount available, total due, shortfall, dates, and as-of time.
3. User opens the warning to inspect included obligations.
4. The warning changes/resolves when underlying confirmed facts change; it does not repeatedly spam unchanged information.

## 9. Global exception flows

### Session expires during editing

- Preserve non-secret draft in memory only where safe.
- Prompt for sign-in.
- Do not submit under an absent/new identity automatically.
- After successful sign-in as the same user, permit deliberate retry with the same idempotency key.

### Network disconnects

- Existing screen may remain readable if already in memory.
- Show offline status.
- Do not promise that a financial mutation was saved and do not silently queue it.
- Retry only by explicit user action or a safely defined idempotent retry.

### Server rejects authorization

- Do not disclose resource existence.
- Present a generic unavailable message and log a sanitized security event.
- Never fall back to a client-provided user ID.

### Partial background-job failure

- Financial commit remains authoritative.
- Outbox/job retries use bounded exponential backoff and idempotency.
- Notification failure does not change an occurrence to paid or roll back a confirmed transaction.
- Operators can inspect sanitized job status and dead-letter state.

## 10. Flow validation scenarios

Before approval, product/UX review must walk through at minimum:

- fixed salary plus two daily income records in one month;
- insufficient current funds for rent due in three days;
- payment due date passes with no confirmation;
- retry after an uncertain Global Add response;
- debt payment with and without a principal/interest split;
- savings contribution followed by purchase completion without double counting;
- timezone change near month boundary;
- recurrence on the 29th/30th/31st and leap day;
- edit/delete of records linked to schedules, debt, or planned purchase;
- two users attempting the same object identifiers;
- screen-reader and keyboard completion of every critical flow.
