# KFin Main User Flows

**Status:** Draft — Issue #1 correction flow proposed; approval required<br>
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
Receive single-use invitation code
  → Register with invite + email + password
  → Generic verification instruction
  → Verify email OTP
  → Sign in (or establish verified session under approved policy)
  → Set display name, timezone, and one base currency
  → Create aggregate account and initial balance snapshot
  → Dashboard setup state
  → Add first current transaction or historical backfill
```

The policy for automatically signing in after verification is not yet approved. Whatever is selected must rotate credentials/session identifiers and produce one unambiguous result.

## 3. Authentication and security flows

### UF-AUTH-01 — Register and verify email

**Precondition:** User has an unexpired, unused Private Beta invitation code. Presence on any operator-side email list is insufficient without the code.

1. User enters invitation code, email, and a password meeting the visible policy.
2. Client submits over TLS without logging credentials or invite material.
3. Server digests/validates the invitation, normalizes email, applies IP/email/invite abuse controls, and returns a generic response.
4. If permitted, server atomically consumes the invitation and creates the pending account with an Argon2id password hash, then sends a single-use OTP.
5. User enters the OTP on a screen that shows a masked destination and expiry/resend guidance.
6. Server validates purpose, digest, attempts, expiry, and consumed state.
7. On success, email becomes verified and a security event is recorded.
8. User continues to onboarding under the approved post-verification session policy.

**Failure/recovery**

- Existing email, invalid/expired/consumed/revoked/wrong-email invitation, and non-existing email states must not create an enumeration oracle.
- An unusable invitation gets generic guidance; only the audited operator procedure may issue a replacement invitation.
- Incorrect OTP shows remaining-safe guidance, not secret comparison details.
- OTP resend invalidates or supersedes prior active verification challenges according to the approved challenge policy.
- Rate-limit responses are calm and do not reveal account or invitation state.

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

### UF-AUTH-07 — Request or cancel account deletion

1. User initiates through the legally approved beta request channel and completes identity verification/recent authentication.
2. Review states the 7-day cancellation deadline, active-data purge scope, retained minimum audit evidence, backup aging, and loss of access.
3. Server marks account `deletion_pending`, revokes sessions according to approved policy, records the request/deadline, and sends a safe confirmation.
4. A verified cancellation before the deadline restores the account under the approved session policy and is audited.
5. After the deadline, an idempotent purge process removes/anonymizes active identity and financial data according to the approved deletion map and records minimum non-sensitive evidence.
6. A later backup restore must obtain the current independently protected restore-exclusion register and reapply deletion tombstones before data becomes active.

## 4. Money setup and transaction flows

### UF-FIN-01 — Establish initial balance snapshot

1. Onboarding explains that KFin tracks one aggregate liquid-money amount manually and does not connect to banks.
2. User selects one base currency (VND default), which becomes immutable after the first financial record.
3. User enters the authoritative current balance and confirms an exact local as-of date/time.
4. Review explains that this snapshot anchors current balance, future current-impact transactions adjust it, and older backfill can be reported without changing it.
5. Server atomically creates the one user-owned aggregate account and its initial immutable balance snapshot.
6. Dashboard shows the current balance with snapshot/last-activity freshness disclosure.

A snapshot is never silently overwritten. A later manual authoritative-balance update creates a new snapshot segment and preserves prior evidence; it is not bank/account-statement reconciliation.

### UF-FIN-02 — Add historical transaction before the snapshot

1. User chooses `Add historical record`, selects a date before the latest snapshot’s local date, or selects the same local date and enters the explicit inclusion review.
2. A pre-snapshot date is historical. On the same local date, the UI asks whether the event was already included; choosing `No` exits this historical path and previews a current-impact save.
3. For the historical path, the form labels the transaction `Already included in current snapshot`, previews no current-balance change, and asks the user to confirm the income/expense details.
4. Server posts the transaction with historical balance effect and links it to the relevant snapshot context.
5. Activity and monthly/category reports include it with a visible historical-only label; Home current balance stays unchanged.

Changing `historical`/`current` meaning in one correction is rejected under proposed `snapshot_correction.v1`. Where owning-domain rules permit, the user must deliberately void the source and create a separate new transaction, each with its own consequence preview and audit evidence.

### UF-FIN-03 — Update known balance with a new snapshot

1. User opens Money setup and selects `Update known balance`.
2. KFin shows calculated current balance and asks for the user’s authoritative actual amount and exact as-of time.
3. If different, review explains the variance without inventing a missing income/expense transaction.
4. User confirms; server creates a new immutable snapshot segment.
5. Current balance now starts from the new snapshot. Prior transactions/snapshots remain inspectable and monthly reports are not rewritten.

### UF-FIN-04 — Global Add expense

**Entry:** Global Add action from any authenticated primary screen.

1. Bottom sheet/full-screen mobile form opens with **Expense** selected and amount focused.
2. User enters amount using a locale-appropriate numeric keypad.
3. User chooses a recent/default category and classification; date defaults to today; the one aggregate account is implicit.
4. Optional fields (note and different date) remain secondary. Choosing a pre-snapshot date switches to the historical-review behavior rather than silently changing balance impact.
5. Save disables repeat taps and sends an idempotency key.
6. On server confirmation, sheet closes, a concise undo/edit affordance may appear, and visible totals invalidate/refetch.

**Validation/recovery**

- Amount must be positive and within database/product bounds.
- Decimal rules follow the selected currency; VND rejects fractional minor units.
- Connectivity failure keeps entered values and offers retry; it must not queue a hidden offline write.
- If result is uncertain, client checks the request/idempotency result before offering a new save.

**Usability target:** Valid basic entry in one surface, with no required note and no multi-page navigation.

### UF-FIN-05 — Add flexible income

Same amount-first pattern as Global Add, with **Income** selected. The date determines the confirmed monthly aggregate. A current-impact save increases current balance; a pre-snapshot historical save is reported but leaves current balance fixed.

### UF-FIN-06 — Correct or void a transaction

**Proposed policy:** `snapshot_correction.v1` in [SPEC-FIN-01](SPEC-FIN-01-SNAPSHOT-CORRECTION.md); mandatory owner approval is pending.

1. User opens Activity and selects the posted terminal transaction in a correction chain.
2. Detail shows amount, date, classification, `current`/`historical` effect, original snapshot anchor, latest-versus-closed segment, owning-domain link, and correction history.
3. User chooses **Correct transaction** or **Void transaction** and provides a bounded reason.
4. For correction, the user may propose amount, a date still valid in the original segment/effect, category/classification, unexpected flag, or note. Owner, account, currency, direction, anchor, balance effect, inclusion meaning, and owning-domain identity are not editable.
5. Server generates an authoritative consequence preview: source/replacement values, current balance before/delta/after or explicit zero change, affected report periods, link handling, and version/state context.
6. A date/effect/anchor request requiring another segment is rejected with no write. KFin does not auto-reanchor; the user may deliberately void where allowed and add a separate new transaction.
7. For a schedule-only link, supported correction keeps the occurrence confirmed and atomically transfers its transaction pointer. Debt uses `UF-DEBT-03`; generic debt/planned-purchase correction or linked standalone void is rejected as specified by the owning-domain matrix.
8. User confirms the preview. Server atomically voids the source and creates one replacement, or performs one standalone void; prior rows remain inspectable and only one posted terminal effect exists.
9. If source, anchor, relevant financial state, or link version changed, the server commits nothing and returns `FIN_CORRECTION_STALE_STATE`. User must refetch, review a new preview, and deliberately retry with a new idempotency key.
10. Same-key/same-request retry returns the first committed result; same key/different payload is rejected.

**Prior-segment result:** Correction/void may amend reports but never changes current balance, which remains anchored to the latest snapshot.

**Race result:** A snapshot/correction or correction/correction race has exactly one winner. A losing snapshot returns `FIN_SNAPSHOT_STALE_STATE`; a losing correction/void returns `FIN_CORRECTION_STALE_STATE`. Neither auto-reanchors, branches, duplicates, or partially writes. `SPEC-FIN-02` still selects the PostgreSQL mechanism enforcing this observable contract.

Linked financial records must never become orphaned. Until the Issue #1 proposal receives mandatory approval, this flow remains specification-only and unavailable for implementation.

## 5. Recurring income and obligation flows

### UF-SCH-01 — Create recurring income

1. User chooses Add → Recurring income.
2. Enters name, amount, cadence, first expected date, and optional end date; the one aggregate account is implicit.
3. Review explicitly says occurrences are projected until confirmed received.
4. Server creates schedule and generates the bounded next occurrences idempotently.
5. Schedule and dashboard show projected values separately.

### UF-SCH-02 — Confirm income received

1. User opens an expected income occurrence.
2. Confirms or edits the actual amount/date; the one aggregate account is implicit.
3. Server atomically creates one posted income transaction and links it to the occurrence.
4. Occurrence becomes confirmed; projected and confirmed totals update without double counting.

### UF-SCH-03 — Create and confirm recurring essential payment

1. User enters payee/title, essential classification, expected amount, cadence, and first due date; the one aggregate account and fixed in-app reminder stages are implicit.
2. Schedule generates future unpaid occurrences.
3. An eligible fixed-stage in-app reminder navigates to occurrence detail.
4. User selects Mark paid, verifies actual amount/date, and confirms.
5. Server atomically records one expense and links it; occurrence becomes paid.

Passing the due date changes only derived due/overdue presentation and notification eligibility; it never performs steps 4–5.

### UF-SCH-04 — Handle due, overdue, skip, or changed amount

- Due/overdue is derived from user-local date and unresolved state.
- User may confirm paid with an actual amount different from expected while preserving both values.
- “Skip occurrence” requires a reason/confirmation and does not create a transaction.
- Series-edit scope (`this occurrence` versus `this and future`) remains a pre-implementation decision. The UI must not offer an unsupported choice; paid history remains stable unless explicitly corrected.

## 6. Debt flows

### UF-DEBT-01 — Create debt

1. User enters name, original principal, current lender-reported outstanding balance and as-of date.
2. Optional annual interest rate includes an as-of date/source and is labelled informational; no automatic accrual claim is made.
3. User enters usual payment amount, frequency, and first/next due date; fixed outgoing-obligation in-app stages apply without a channel preference.
4. Review explains expected occurrences and manual confirmation.
5. Server creates debt, schedule, and next occurrences atomically.

### UF-DEBT-02 — Record debt payment

1. User opens due occurrence or debt detail and chooses Record payment.
2. Enters actual total and date; optionally splits principal, interest, and fee or supplies a new lender-reported outstanding balance with as-of date.
3. A complete split must equal total; a partial split must show the unclassified remainder and never treat it as principal.
4. Review shows cash-balance effect. It shows an outstanding-balance effect only when principal or a new reported balance is known.
5. Server records expense, debt payment, and occurrence link atomically. It updates outstanding balance only from known principal or an explicit new lender-reported value.
6. If neither is available, the prior outstanding amount and as-of date remain unchanged and the detail prompts later reconciliation; KFin never assumes the full payment is principal.

If the lender-reported balance later differs, the user makes an explicit balance correction with as-of date; KFin does not invent accrued interest.

### UF-DEBT-03 — Correct or void a debt payment

1. User opens the payment and sees its cash transaction, explicit principal/interest/fee values, unclassified remainder, outstanding effect/as-of, and any later outstanding-affecting records.
2. User supplies a reason and explicit replacement facts; omitted principal, interest, fee, or lender balance remain unknown rather than being inferred from the total or rate.
3. Review previews the cash/snapshot effect separately from the debt-outstanding effect and identifies any preserved prior/later records.
4. A cash-only payment with no explicit outstanding effect can be corrected without changing debt outstanding/as-of.
5. When no later outstanding-affecting record exists and the exact pre-payment state and replacement effect are explicit, the system may atomically preserve/void the old records and apply only the explicit replacement effect under `DEBT-INV-06`.
6. If a later payment/adjustment exists, the as-of order would change, required prior state is absent, or any principal/interest/fee/outstanding value would have to be inferred, the automatic correction path is unavailable.
7. The exact historical correction/rebase/rejection workflow remains **BLOCKER `SPEC-DEBT-01`**. Until approved, the UI must not promise or simulate an outstanding result; the user can record a separately explicit current lender-reported balance adjustment without disguising the difference as interest.

## 7. Savings and planned-purchase flows

### UF-SAV-01 — Create and update a savings goal

1. User enters name, target amount, manually reported current amount/as-of date, planned contribution/cadence, and optional target date.
2. Review explains that current amount is a declared reserve used by safe-to-spend, not a separate cash account or verified bank balance.
3. Goal is created with current/target progress. The current amount does not change aggregate cash or monthly income/outflow.
4. To change it, user selects `Update current amount`, enters a new absolute value/as-of date and optional reason, then reviews its safe-to-spend effect.
5. Server version-checks the goal, updates the scalar amount, and writes immutable old/new audit metadata.

MVP does not expose contribution or withdrawal ledger entries.

### UF-PLAN-01 — Create planned purchase

1. User enters item name, target price/date and optionally links a savings goal.
2. Purchase appears in Plan, not Activity or actual monthly spending.
3. Funding progress uses the linked goal without changing it.

### UF-PLAN-02 — Complete planned purchase

1. User chooses Mark purchased.
2. Enters actual amount/date/category; the one aggregate account is implicit.
3. If a goal is linked, review asks how much of its manual current amount funded the purchase; the value may be zero but cannot exceed the actual purchase amount or goal current amount.
4. Review explains the cash expense, old/new goal amount, safe-to-spend effect, and that the goal will not be auto-archived.
5. Server atomically creates/links the expense, updates the goal scalar with old/new audit metadata, and sets the purchase completed under one idempotency result.
6. Dashboard and Activity update without a duplicate deduction; purchase, goal, and amount-change evidence remain inspectable.

## 8. Dashboard and reminder flows

### UF-DASH-01 — Understand current position

1. Home loads a skeleton that preserves layout, then values as of a visible time.
2. User sees authoritative current balance, latest snapshot anchor/as-of time, and data freshness.
3. Safe-to-spend shows the signed amount and current user-local month-end horizon. “How calculated” exposes authoritative balance minus unpaid outgoings due through that horizon minus active goal current amounts; projected income is explicitly excluded.
4. User can inspect the included unpaid/overdue outgoing occurrences and active goal reserves. A confirmed outgoing is represented through current balance and is not also subtracted as unpaid.
5. Urgent obligations list shows amount, due date, and state with action.
6. Month summary distinguishes confirmed income/outflow, historical-only records, and projected values; it explains why a snapshot boundary prevents whole-history reconciliation.
7. Goal card shows progress and next planned contribution.
8. Selecting any aggregate opens a filtered source list.

When setup is incomplete, the dashboard explains which missing data prevents a trustworthy calculation. `UF-DASH-01` is the product flow traced by `PRD-DASH-07`, `FIN-STS-INV-01` through `FIN-STS-INV-07`, and test cases `STS-01` through `STS-15`.

### UF-REM-01 — Act on a reminder

1. At the 09:00 user-local evaluation, the server worker creates at most one in-app notification for each eligible outgoing occurrence + stage (7-day, 3-day, due-today, or first-overdue), independent of whether the app is open.
2. Before creation it rechecks current occurrence state/version and occurrence + stage uniqueness; confirmed, skipped, or cancelled items receive no new stage.
3. User opens it and lands on the owned occurrence after authentication.
4. User confirms paid, views details, or dismisses/marks read.
5. The overdue stage is created once and does not repeat daily/weekly; Schedule continues to show overdue until resolved.
6. Reading/dismissing, closing, or later reopening the app does not mark payment complete, replay elapsed stages, or send payment-reminder email/push.
7. If worker downtime, late occurrence creation, or timezone change makes multiple stages elapsed, one recovery evaluation creates at most one catch-up notification for the occurrence. Which single stage, if any, is selected remains **BLOCKER `SPEC-REM-01`**; no burst is allowed.

### UF-REM-02 — Cash-flow warning

1. System detects current balance below unpaid outgoing obligations due through the end of the current local calendar month.
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

- mandatory invitation-code expiry/wrong-email/parallel use, one atomic account creation, and no email-only admission bypass;
- post-verification session behavior under the selected policy;
- deletion request/cancellation race, purge, and restore-exclusion behavior;
- fixed salary plus two daily income records in one month;
- insufficient current funds for rent due in three days;
- payment due date passes with no confirmation;
- retry after an uncertain Global Add response;
- debt payment/correction cases `DCT-01`–`DCT-09`, preserving `SPEC-DEBT-01` blocked outcomes and inferring no component/outstanding;
- snapshot scenarios A–J, including historical-only reporting, same-day explicit inclusion, new segments, non-whole-history balance, proposed `snapshot_correction.v1`, and the remaining `SPEC-FIN-02` mechanism blocker;
- safe-to-spend cases `STS-01`–`STS-15`, including projected-income exclusion, no paid-outgoing double subtraction, active-goal reserve, negative result, and local month boundary;
- manual savings amount update followed by partial linked-purchase deduction without double counting;
- reminder cases `RCT-01`–`RCT-10`, including worker downtime, closed app, late occurrence creation, timezone change, delayed return, multiple missed stages, no burst, and `SPEC-REM-01`;
- recurrence on the 29th/30th/31st and leap day;
- edit/delete of records linked to snapshots, schedules, debt, or planned purchase;
- two users attempting the same object identifiers;
- screen-reader and keyboard completion of every critical flow.

## 11. Round 3 flow closure register

Round 3 does not choose any unresolved branch. It defines what flow evidence must exist before owner approval:

| Blocker | Affected flows | Exact unresolved flow decision | Fixed flow boundary | Required flow evidence | Status |
|---|---|---|---|---|---|
| `SPEC-AUTH-01` | First-use map, `UF-AUTH-01`/`02` | Fresh rotated session after verification or explicit sign-in; result, onboarding redirect, cookie/CSRF, event, multi-tab, and uncertain-response result | OTP use is atomic/single-use; no pre-auth identifier survives | Compact/expanded walkthrough, threat/session-fixation review, retry/multi-tab tests, approved Vietnamese copy | OPEN — decision ready |
| `SPEC-AUTH-02` | `UF-AUTH-01`–`06`, session-expiry exception | Every invitation/password/OTP/reset/abuse/session/rotation/password-change value and failure path | Invitation code only; generic responses; Argon2id; digest-only secrets; reset revokes all sessions | Boundary, expiry, replay, concurrent-tab, provider-failure, benchmark and usability evidence | OPEN — decision ready |
| `SPEC-FIN-01` | `UF-FIN-02`/`03`/`06` and linked flows | Approve proposed `snapshot_correction.v1`: void + replacement, same-anchor/effect only, cross-segment rejection, report/link/preview/audit/stale/idempotent outcomes | Append-only evidence; no silent cross-segment move, history erasure, or double effect | Issue #1 PR review, snapshot H–J, and `FIN-COR-01`–`10` walkthroughs | OPEN — approval/evidence ready |
| `SPEC-FIN-02` | `UF-FIN-01`–`06` | Select/prove the PostgreSQL linearization/lock/isolation/version mechanism, internal retry bounds, and timeout-after-commit handling | Exactly one latest segment and defined winner/stale-loser result; no silent re-anchor | Deterministic race, deadlock and timeout-after-commit tests | OPEN — decision ready |
| `SPEC-DEBT-01` | `UF-DEBT-03` | Explicit-fact replay or fresh lender-reported balance when later events exist | No inferred debt component or outstanding; unsafe path unavailable | DCT-08/09 and later-event/date-reorder/missing-state walkthroughs | OPEN — decision ready |
| `SPEC-SCH-01` | `UF-SCH-01`–`04` | 29-February outcome, bounds/horizon/batch, and exact occurrence/series-edit split behavior | Supported cadence and monthly missing-day fallback stay fixed; history is preserved | Fixed-clock boundary, edit-versus-worker race and UX walkthroughs | OPEN — decision ready |
| `SPEC-REM-01` | `UF-REM-01` | Catch-up emission, precedence, recovery window, suppression record, timezone/late-creation and state-race outcomes | At most one catch-up; no burst; no financial-state mutation | Exact RCT-04–07 and outage/timezone/state-race outcomes | OPEN — decision ready |
| `SPEC-DEL-01` | `UF-AUTH-07` | Request/cancel authentication/channel, pending-session behavior, purge map, retained evidence, restore exclusion, legal hold/provider failure | Seven-day cancellation and post-deadline active-data purge baseline | Request/cancel/purge races, legal review, provider evidence and restore drill | OPEN — decision ready |

Accountable/co-approver roles, artifact metadata, and binary closure criteria are in the [Round 3 report](../reviews/SPECIFICATION-REMEDIATION-ROUND-3.md). A walkthrough is evidence only when it records source version, participants/reviewers, expected and observed result, defects, and explicit disposition in the [Approval and Evidence Register](../governance/APPROVAL-AND-EVIDENCE-REGISTER.md).
