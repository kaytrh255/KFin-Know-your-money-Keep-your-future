# KFin UX Specification

**Status:** Draft — FIN-01/02 UX states specified; acceptance evidence absent<br>
**Version:** 0.6<br>
**Platforms:** Responsive Web and installable PWA<br>
**Accessibility target:** WCAG 2.2 AA for all MVP core flows<br>
**Evidence status:** Specification review only — no visual prototype, usability study, or accessibility validation has passed

## 1. Experience intent

KFin should feel calm, precise, private, and useful every day. It is not a generic administration dashboard. The interface must put financial decisions and status ahead of data-management mechanics.

### Experience goals

1. A user understands the top financial message within five seconds.
2. A routine expense can be saved from a primary screen in one amount-first surface.
3. Actual, expected, reserved, estimated, and overdue money are never visually or verbally conflated.
4. Important obligations are noticeable without alarm fatigue.
5. Users can trace every aggregate to records and every estimate to a formula.
6. Mobile use feels designed for a thumb and software keyboard, not compressed from desktop.

## 2. UX principles

- **Decision first:** Lead with the answer and next action, then reveal detail.
- **Amount first:** For routine entry, focus the amount immediately and keep secondary fields secondary.
- **Progressive disclosure:** Show advanced schedule, debt split, and correction fields only when relevant.
- **Calm urgency:** Use exact due dates and shortfalls; avoid shame, red-filled screens, countdown anxiety, and repeated alerts.
- **Explicit state:** Use words such as `Projected`, `Received`, `Upcoming`, `Due today`, `Overdue`, `Paid`, `Reserved`, and `Estimate`.
- **Reversible where safe:** Offer clear edit/correction paths. Security or destructive changes require deliberate confirmation.
- **Never hide uncertainty:** Incomplete input produces setup guidance, not false precision.
- **Consistent location:** Primary navigation and the global Add action remain stable.
- **Privacy by default:** Do not expose amounts in push notifications, browser titles, URLs, or analytics. A future privacy-hide mode may mask values on screen.

## 3. Information architecture

### Primary destinations

1. **Home** — current position, safe-to-spend estimate, urgent obligations, month summary, goal progress.
2. **Activity** — actual posted income and outflow, searchable/filterable and grouped by date.
3. **Schedule** — expected inflows and obligations, including due/overdue status.
4. **Plan** — debts, savings goals, and planned purchases.
5. **Profile & Security** — identity preferences, sessions, password, and security history.

**Notifications** opens from a header icon and is not a primary destination. **Global Add** is a persistent action, not a destination.

### Mobile navigation proposal

A fixed bottom bar uses five positions:

- Home
- Activity
- **Add** (visually prominent action)
- Schedule
- Plan

Profile opens from the top app-bar avatar. Notifications open from the adjacent bell. Labels remain visible; icons alone are insufficient. Safe-area padding is mandatory.

### Desktop navigation proposal

A left sidebar contains Home, Activity, Schedule, and Plan, with a persistent `Add transaction` button. Profile/Security is anchored at the bottom. Notifications and page context remain in the header. The content column has a readable maximum width; wide screens add supporting columns rather than stretching text/cards.

## 4. Responsive model

Breakpoints are implementation tokens, not device assumptions:

| Range | Expected pattern |
|---|---|
| Compact: 320–599 px | Single column; bottom navigation; full-width or near-full-width sheets; sticky primary actions where needed |
| Medium: 600–959 px | Single/two-column based on content; bottom navigation may remain; dialogs only when keyboard behavior is safe |
| Expanded: 960–1279 px | Sidebar; two-column dashboard; constrained forms; side panels for detail where appropriate |
| Large: 1280 px and above | Sidebar; bounded three-region dashboard only when hierarchy benefits; no excessive whitespace stretching |

Requirements:

- No primary flow may require horizontal page scrolling at 320 CSS px.
- Support browser zoom to 200% and reflow at 400% where WCAG applies.
- Do not rely on hover. Hover enhances but never unlocks an action.
- Touch targets are at least 44 × 44 CSS px; primary mobile controls should target 48 px height.
- Fixed elements respect `env(safe-area-inset-*)`.
- Content and controls must remain reachable when the virtual keyboard is open.

## 5. Dashboard composition

The default compact-screen order is:

1. Header with greeting/context, notification entry, and profile.
2. **Money snapshot** — current balance, latest authoritative snapshot/as-of time, and activity since snapshot.
3. **Safe-to-spend estimate** — signed conservative amount through current user-local month-end, status, and `How calculated` disclosure.
4. **Needs attention** — at most the most urgent few due/overdue/shortfall items, with `View schedule`.
5. **This month** — confirmed income, grouped outflow, and net movement; projected values are separate.
6. **Goals** — top active goals with progress and next contribution.
7. Secondary insight or setup guidance, only if actionable.

Desktop may place snapshot and spendable cards side by side and use a right rail for needs-attention. It must preserve reading order in the DOM.

### Dashboard rules

- No more than one primary visualization per question.
- Prefer labelled numbers, progress bars, and ranked category rows to multiple charts.
- Any chart has a textual summary and accessible data representation.
- Totals link to a filtered Activity/Schedule view.
- Calculation disclosure identifies the latest balance anchor and states the complete formula: authoritative current balance minus unpaid outgoing occurrences due through current user-local month-end minus active savings-goal current amounts. It labels projected income as excluded and exposes included records.
- A confirmed outgoing is shown through current-balance impact and is not also presented as an unpaid subtraction. Negative safe-to-spend remains signed and receives an accessible shortfall explanation rather than being clamped to zero.
- Historical-only backfill appears in monthly totals without changing current balance. A transaction from a prior snapshot segment remains visible, but detail explains that even a record originally marked current-impact no longer enters today’s balance after a newer authoritative snapshot.
- Amounts use tabular numerals and cannot be truncated without an accessible full value.
- `0`, `No data`, and `Not calculated` are distinct states.

## 6. Global Add interaction

### Entry behavior

- Global Add opens a bottom sheet on compact screens and a compact dialog/popover on expanded screens.
- The amount field receives focus only when doing so will not disorient assistive-technology users.
- Expense/Income is an explicit segmented control; last choice may be remembered locally only if safe and understandable.
- Required data: type, amount, category, and date. The accepted one aggregate account is implicit and consumes no control in the common path.
- Note and the orthogonal `Unexpected` flag are secondary; `Unexpected` must remain easy to choose without replacing the expense class.
- Selecting a pre-snapshot date changes the review state to `Historical — already included in current balance`; current balance impact is previewed before save.
- Same-day snapshot ambiguity asks whether the transaction is already included. The UI never guesses or hides the effect.
- Submit remains in thumb reach and above the keyboard.

### Numeric input

- Use `inputmode="decimal"` or `numeric` according to currency precision, not `type="number"` if it causes locale or wheel-step problems.
- Display locale grouping while maintaining a clear raw value model.
- Reject negatives and unsupported precision before submission, with text guidance.
- Never silently round a financial amount.
- Paste is allowed and normalized safely.

### Save feedback

- First tap transitions to a visible saving state and prevents accidental duplicate taps.
- Success is announced through an accessible status region and updates dependent totals after server confirmation.
- Failure keeps input and focuses/announces the error summary.
- Offline mode never implies that a write is queued or complete.
- An Undo affordance may open a confirmed reversal/removal path; it must not be a client-only illusion.

### Financial concurrency and uncertain-result recovery — Issue #3 proposal

- A financial form/preview carries the reviewed latest snapshot and financial-state version invisibly; the UI never exposes editable lock/version controls.
- An operation-specific stale response preserves safe draft input, announces that financial state changed, refetches authoritative state, and requires a rebuilt consequence preview plus deliberate reconfirmation. It never auto-submits after refresh.
- `FINANCIAL_CONCURRENCY_BUSY` and `FINANCIAL_OPERATION_TIMEOUT` are temporary-save failures. Keep the draft, use calm retry guidance, and retry only with the same idempotency key while the request remains unchanged.
- `FINANCIAL_RESULT_UNKNOWN` is neither success nor failure. Show `Checking whether your save completed`, disable a new logical save, and retry/status-check with the same key. Do not show Undo, duplicate-entry guidance, or a success total until the committed result is recovered.
- A recovered compatible result uses the original success presentation exactly once. Same key/different payload requires a fresh deliberate action and never merges drafts.
- Messages never expose SQLSTATE, lock/table names, attempt internals, other activity, raw keys, or financial payload from diagnostics.

These states are evidence targets for proposed `account_financial_serialization.v1`; they are not visual/usability/accessibility acceptance and remain unavailable for implementation until approval/evidence.

### Transaction correction review — Issue #1 proposal

- Label actions distinctly as `Correct transaction` (source remains as voided evidence and one replacement is posted) and `Void transaction` (no replacement).
- Show source and proposed values, required reason, snapshot anchor/as-of, `current`/`historical`, and latest-versus-closed segment before confirmation.
- For a closed-segment or historical correction, state explicitly: `Current balance change: 0`; show affected report periods and an amended-history marker.
- For a latest current correction, show current balance before, signed delta, and after; do not count source and replacement simultaneously.
- Never offer anchor/effect controls. If a date would cross the anchor, show the deterministic unsupported result and explain deliberate void + separate entry where permitted.
- Show owning-domain context. Schedule-only pointer transfer is part of one save; debt/planned-purchase paths route to or require their owning-domain behavior and never detach silently.
- On `FIN_CORRECTION_STALE_STATE`, keep safe draft values, announce that financial state changed, refresh the source/anchor, and require a new preview and explicit confirmation. Do not auto-submit.
- Detail/history exposes the append-only chain. A correction badge is not a substitute for accessible old/new values.

These states specify evidence targets for proposed `snapshot_correction.v1`; they do not constitute visual, usability, accessibility, or owner acceptance.

## 7. Schedule and payment UX

- Default Schedule is an agenda list grouped by date; a dense calendar is optional and not the only representation.
- Each row shows direction, title, expected amount, exact date, state, and source (for example Debt or Rent).
- Persisted states remain `scheduled`, `confirmed`, `skipped`, and `cancelled`. UX labels are direction-specific projections: outgoing `confirmed` is `Paid / Đã thanh toán`, incoming `confirmed` is `Received / Đã nhận`; outgoing `scheduled` may display derived Upcoming/Due today/Overdue.
- Paid/received items are visually secondary but still available in history; filters with those labels query `confirmed` plus direction and do not create a `paid`/`received` storage state.
- `Mark paid` and `Mark received` are action labels that open a review sheet showing actual amount/date; success creates/links the posted transaction and persists occurrence state `confirmed`. The one aggregate account is implicit.
- `Dismiss notification` and `Mark paid` are never adjacent look-alike actions.
- Overdue state is derived and uses icon + label + text contrast, not red alone.
- Eligible outgoing-obligation notifications are evaluated server-side at 09:00 user-local time. Each 7-day, 3-day, due-today, and first-overdue stage appears at most once; overdue does not repeat.
- Closing or returning to the app only changes when persisted in-app notifications are viewed; it never replays elapsed stages or changes payment state.
- Downtime, late occurrence creation, and timezone changes must never surface a multi-stage burst. At most one catch-up notification may appear for an occurrence per recovery evaluation; no copy/design may imply which stage wins while `SPEC-REM-01` remains unresolved.
- No payment-reminder email, push, SMS, or permission prompt appears in MVP.
- Editing a series asks `This occurrence` versus `This and future occurrences` only when both behaviors are supported and specified.

## 8. Debt, savings, and plan UX

### Debt

- Lead with user-reported outstanding amount and its `as of` date.
- Label the optional annual rate, as-of date, and source as informational while automatic accrual is out of scope.
- Show next due payment and recent history before configuration fields.
- Payment review clearly separates total cash outflow and optional user-supplied principal/interest/fee split, visibly labelling any partial/unclassified remainder. KFin never fills an omitted component or lender outstanding from the total, rate, or elapsed time.
- Correction review separates cash/snapshot consequences from outstanding consequences and preserves old/new evidence. When later outstanding-affecting records or missing explicit state make recomputation unsafe, the UI blocks automatic correction and cites the need for an explicit current lender-reported amount; it must not preview a guessed result while `SPEC-DEBT-01` is open.

### Savings

- Lead with manually reported current amount/target, current-amount as-of date, and a labelled progress bar.
- Explain that the current amount is a user-declared reserve used by safe-to-spend, not a separate account or verified bank value.
- The primary action is `Update current amount`; it edits an absolute value and previews the safe-to-spend change.
- Do not present audit records as contributions, withdrawals, or cash transactions.
- A target date may show required average contribution only if a separately reviewed formula is approved; otherwise show date without prescriptive projection.

### Planned purchase

- Clearly label as planned, not spent.
- Linked goal is relational context, not automatic money transfer.
- Completion previews the actual expense and asks how much to deduct from the linked goal current amount (including zero), showing old/new goal values and safe-to-spend effect.
- Completion never auto-archives or zeroes the goal.

## 9. Forms and validation

- Labels are persistent; placeholders never substitute for labels.
- Required/optional status is stated consistently.
- Validate on blur or submit rather than interrupting every keystroke, except safe formatting guidance.
- Server remains authoritative; server errors map to an error summary and relevant field.
- Focus moves to the error summary after failed submit; each item links to its field.
- Preserve entered non-secret data across correctable errors.
- Date input supports typed input and an accessible picker. Display uses locale; submitted date uses an unambiguous ISO local date.
- Destructive actions name the object and consequence. Typed confirmations are reserved for exceptionally severe actions, not routine deletion.
- Unsaved-change warnings appear only when a real change would be lost.

## 10. System states

Every data surface must specify these states before implementation:

| State | UX requirement |
|---|---|
| Initial loading | Shape-matched skeleton or concise progress; no layout thrash; announce longer waits |
| Background refresh | Keep usable content, show subtle freshness indicator; do not replace with full-page spinner |
| Empty — first use | Explain value and provide one primary setup action |
| Empty — filtered | State that no records match and provide clear-filter action |
| Incomplete setup | Identify missing fact and which calculation is unavailable |
| Validation error | Specific, local, and summarized; input retained |
| Authorization/not found | Generic unavailable state that does not reveal private object existence |
| Network offline | Persistent non-blocking banner; read-only cached shell only; no hidden mutation queue |
| Server error | Plain-language retry path and support correlation ID; no internals |
| Success | Brief, announced confirmation; avoid toast-only proof for durable state |
| Partial background failure | Core saved state remains visible; notification delivery failure does not invalidate financial action |

## 11. Accessibility requirements

- Semantic headings and landmarks form a logical hierarchy.
- All flows are operable by keyboard with visible focus; focus order follows reading order.
- Dialogs/sheets trap focus only while open, have an accessible name, close predictably, and restore focus to the invoker.
- Status, error, and asynchronous save messages use appropriate live-region behavior without repeated announcements.
- Color contrast meets WCAG 2.2 AA; normal text targets at least 4.5:1 and large text/UI boundaries at least 3:1 where required.
- Status and trends use labels/icons/patterns in addition to color.
- Amounts and dates have screen-reader-friendly accessible labels.
- Motion respects `prefers-reduced-motion`; no essential information depends on animation.
- At 200% zoom, controls remain reachable; at narrow reflow, no two-dimensional scrolling is required except truly tabular content.
- Authentication supports password managers, paste, and platform autofill. OTP fields must not obstruct paste or screen readers.
- Private Beta registration requires an invitation-code field and valid code state. UI copy MUST NOT imply that an email address or server-side email allowlist can replace the invitation code.
- Automated checks are necessary but manual screen-reader, keyboard, zoom, and touch testing are release requirements.

## 12. Language and content design

- Private Beta UI and transactional/authentication email are Vietnamese-first (`vi-VN`); Vietnamese content review is required.
- Use direct action verbs equivalent to `Add expense`, `Mark paid`, `Update current amount`, and `Revoke session` in approved Vietnamese copy.
- Avoid accounting jargon unless explained.
- Show exact dates (`8 Oct 2026` in English locale or locale equivalent), not only `soon`.
- Pair relative and exact time where useful: `Due in 3 days · 10 Oct`.
- Warnings state fact, impact, and action: `1,000,000 ₫ is due by 10 Oct. Available balance is 700,000 ₫.`
- Never say `safe`, `guaranteed`, or `on track` without the scope and calculation.
- Never shame spending or use celebratory animation around sensitive debt repayment.
- Message keys and layout must allow future English word order/length, but shipping English content is not an MVP requirement.

## 13. PWA and offline behavior

- Install prompts must be user-initiated or shown after demonstrated engagement, never on first interaction.
- Cache versioned static assets and a minimal public/offline shell only.
- Do not cache authenticated API responses, HTML containing private data, tokens, or financial payloads in a service worker/cache storage.
- Previously rendered private data must not be deliberately persisted for offline display in MVP.
- When offline, explain that new/changed records cannot be saved; disable submit with a reason or allow explicit retry after reconnection.
- An update prompt must not interrupt an in-progress financial form.

## 14. Trust and privacy UX

- Explain manual-data limitations during onboarding and calculation disclosure.
- Show session/security event details without implying exact geolocation.
- No communication contains passwords, session tokens, or full financial records. Purpose-bound verification/recovery email may contain only the required short-lived OTP/reset secret and minimum context; ordinary security alerts contain no authentication secret.
- Sensitive pages use `no-store` and are excluded from search indexing.
- Copy/paste remains allowed for user-owned amounts and notes; do not use hostile anti-user restrictions.
- Confirmation dialogs do not expose sensitive information to the URL or page title.

## 15. Usability validation plan

Before Private Beta, moderated tests should include representative compact and desktop devices and these tasks:

1. Establish an authoritative balance snapshot and explain its as-of meaning.
2. Backfill a pre-snapshot expense and explain why current balance does not change.
3. Add a routine current expense and correct its amount.
4. Record daily income and confirm recurring salary.
5. Find what is due in three days and mark it paid.
6. Explain why an overdue item is not paid automatically and why no repeated reminder/email appears.
7. Create a goal, update its absolute current amount, and explain the effect on balance versus safe-to-spend.
8. Complete a linked planned purchase with a partial goal-amount deduction.
9. Recover password and revoke another session.
10. Explain all figures on Home without facilitator help.

Capture completion, errors, time, comprehension, accessibility barriers, and trust concerns. Targets in the PRD are hypotheses until tested.

## 16. UX evidence statuses and blocker

These reviews are separate and none may be inferred from another:

1. **UX specification review** evaluates completeness and cross-document consistency of flows, states, content requirements, and interaction constraints.
2. **Visual prototype acceptance** requires dated compact/expanded low- and high-fidelity artifacts covering critical states and approved design-token application.
3. **Usability acceptance** requires representative moderated-task evidence, observed errors/comprehension, pre-approved thresholds, and owner sign-off.
4. **Accessibility acceptance** requires dated keyboard, screen-reader, zoom/reflow, contrast, touch-target, reduced-motion, and automated-check evidence against WCAG 2.2 AA scope.

### 16.1 `SPEC-UX-01` evidence manifest

Every row must identify artifact version/location, date, method, participant/reviewer profile, device/browser/assistive technology, expected threshold, observed result, defects, remediation/retest, and named approver. A design link, screenshot, automated score, or role label alone is insufficient.

| Evidence item | Required scope | Acceptance condition | Accountable / co-approver | Current state |
|---|---|---|---|---|
| Compact visual prototype | 320px-class through representative mobile widths; all primary and critical exception states | No omitted required state, unreadable amount, clipped action, hidden focus/error, or unresolved critical visual defect | UX/Accessibility / Product | Missing |
| Expanded visual prototype | Tablet/desktop widths; persistent navigation, lists, detail, dialogs, source drill-down | Same completeness and critical-defect rule; compact/expanded information meaning remains identical | UX/Accessibility / Product | Missing |
| Vietnamese content | Auth, snapshot/backfill, safe-to-spend, debt unknown/blocked state, recurrence/reminder, security history, deletion and errors | Product/domain/privacy reviewers approve exact copy; no guarantee, inference, shame, enumeration, or false location claim | Product / UX, Security, Financial Integrity, Privacy/Legal | Missing |
| Critical-state inventory | Loading, empty, incomplete setup, validation, offline, authorization/not-found, server, uncertain/conflict, success, partial background failure | Every critical screen maps every applicable state to an artifact and expected recovery action | UX/Accessibility / Product, QA | Missing |
| Moderated task plan | §15 tasks plus auth verification outcome, correction blocked states, reminder recovery and deletion comprehension | Participant profile, sample/rationale, task script and success/comprehension thresholds are approved before sessions | UX/Accessibility / Product | Missing |
| Moderated results | Observed completion, errors, time, comprehension, trust and accessibility barriers | Every pre-approved threshold is reported; no unresolved severe task failure or misleading financial/security comprehension remains | UX/Accessibility / Product, domain owners | Missing |
| Keyboard/focus | All critical flows, dialogs/sheets, errors, session expiry and recovery | Full completion without pointer; logical focus; no trap/loss; visible focus; status/errors announced | UX/Accessibility / QA | Missing |
| Screen reader | Representative iOS/Android/desktop screen readers on critical flows and dynamic states | Names/roles/states/order/announcements permit completion; amounts/dates/status are unambiguous; no unresolved WCAG A/AA failure | UX/Accessibility / QA | Missing |
| Zoom/reflow/responsive | 200% and 400% where WCAG requires; compact to expanded; text-size stress | Controls/content remain available without loss or prohibited two-dimensional scrolling; no overlap/clipping | UX/Accessibility / QA | Missing |
| Contrast/targets/motion | All tokens/components/states, 44×44 target goal, forced colors where applicable, reduced motion | WCAG 2.2 AA contrast/reflow/input criteria pass; target exceptions are documented and approved; essential meaning does not depend on motion/color | UX/Accessibility / QA | Missing |
| Automated accessibility | Component and integrated critical flows | Zero untriaged violations; every finding links to manual confirmation where automation is insufficient | QA / UX/Accessibility | Missing |
| Trace and sign-off | Requirement/flow/screen/state/evidence/defect/retest mapping | No critical row missing; stable privacy-safe evidence links and named Product + UX/Accessibility acceptance recorded | UX/Accessibility / Product | Missing |

### 16.2 Decision-dependent UX evidence

Evidence cannot be final for an unresolved policy. Prototypes may compare options, but acceptance must wait for the authorized outcome:

- `SPEC-AUTH-01`: verification result, onboarding transition, session/sign-in copy, retry and multi-tab states;
- `SPEC-AUTH-02`: visible password/OTP/reset/session guidance and abuse/recovery consequences;
- `SPEC-FIN-01`: approve and validate `snapshot_correction.v1` correction/void distinction, old/new chain, prior-segment zero-balance disclosure, cross-segment rejection and link handling;
- `SPEC-FIN-02`: approve/prove `account_financial_serialization.v1` and validate operation-specific stale, bounded-busy/timeout, same-key result-unknown/recovery, no-auto-submit copy and focus/announcement behavior;
- `SPEC-DEBT-01`: no-inference blocked state and explicit lender-balance path;
- `SPEC-SCH-01`: leap-day copy, bounds and occurrence/series-edit choices;
- `SPEC-REM-01`: catch-up result and explanation without notification burst;
- `SPEC-SEC-02`: user-visible event list, safe detail, delivery and retention copy;
- `SPEC-DEL-01`: request, pending, cancellation, purge, retention and legal-hold communication.

This document can receive specification review without satisfying visual, usability, or accessibility acceptance. No visual prototype, usability study, content approval, or accessibility validation currently exists, so none is Accepted. `SPEC-UX-01` remains **OPEN — evidence ready**. The full blocker closure contract is in the [Round 3 remediation report](../reviews/SPECIFICATION-REMEDIATION-ROUND-3.md), and evidence/sign-off metadata belong in the [Approval and Evidence Register](../governance/APPROVAL-AND-EVIDENCE-REGISTER.md). Design-system tokens are a coherent proposal, not visual acceptance.
