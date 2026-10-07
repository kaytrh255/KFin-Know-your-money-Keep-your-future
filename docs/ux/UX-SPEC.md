# KFin UX Specification

**Status:** Draft — review required<br>
**Version:** 0.1<br>
**Platforms:** Responsive Web and installable PWA<br>
**Accessibility target:** WCAG 2.2 AA for all MVP core flows

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

1. **Home** — current position, spendable estimate, urgent obligations, month summary, goal progress.
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
2. **Money snapshot** — current balance, as-of time, visibility control if approved.
3. **Spendable estimate** — amount, horizon, status, and `How calculated` disclosure.
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
- Amounts use tabular numerals and cannot be truncated without an accessible full value.
- `0`, `No data`, and `Not calculated` are distinct states.

## 6. Global Add interaction

### Entry behavior

- Global Add opens a bottom sheet on compact screens and a compact dialog/popover on expanded screens.
- The amount field receives focus only when doing so will not disorient assistive-technology users.
- Expense/Income is an explicit segmented control; last choice may be remembered locally only if safe and understandable.
- Required data: type, amount, category, date, and the approved account. Under the recommended one-account MVP, account is implicit and need not consume a control; if multiple accounts are approved later, the default remains visible and changeable.
- Note and the orthogonal `Unexpected` flag are secondary; `Unexpected` must remain easy to choose without replacing the expense class.
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

## 7. Schedule and payment UX

- Default Schedule is an agenda list grouped by date; a dense calendar is optional and not the only representation.
- Each row shows direction, title, expected amount, exact date, state, and source (for example Debt or Rent).
- Paid/received items are visually secondary but still available in history.
- `Mark paid` and `Mark received` open a review sheet showing actual amount/date/account.
- `Dismiss notification` and `Mark paid` are never adjacent look-alike actions.
- Overdue state is derived and uses icon + label + text contrast, not red alone.
- Editing a series asks `This occurrence` versus `This and future occurrences` only when both behaviors are supported and specified.

## 8. Debt, savings, and plan UX

### Debt

- Lead with user-reported outstanding amount and its `as of` date.
- Label interest rate as informational while automatic accrual is out of scope.
- Show next due payment and recent history before configuration fields.
- Payment review clearly separates total cash outflow and optional principal/interest/fee split.

### Savings

- Lead with amount/target and a labelled progress bar.
- Explain virtual allocation at first use and from `How it works`.
- Contribution and withdrawal use distinct verbs; withdrawal is not called an expense.
- A target date may show required average contribution only if a separately reviewed formula is approved; otherwise show date without prescriptive projection.

### Planned purchase

- Clearly label as planned, not spent.
- Linked goal is relational context, not automatic money transfer.
- Completion flow previews the actual expense and, under approved OQ-15 behavior, asks for and previews the linked-goal allocation release before confirmation.

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
- Automated checks are necessary but manual screen-reader, keyboard, zoom, and touch testing are release requirements.

## 12. Language and content design

- Use direct verbs: `Add expense`, `Mark paid`, `Record contribution`, `Revoke session`.
- Avoid accounting jargon unless explained.
- Show exact dates (`8 Oct 2026` in English locale or locale equivalent), not only `soon`.
- Pair relative and exact time where useful: `Due in 3 days · 10 Oct`.
- Warnings state fact, impact, and action: `1,000,000 ₫ is due by 10 Oct. Available balance is 700,000 ₫.`
- Never say `safe`, `guaranteed`, or `on track` without the scope and calculation.
- Never shame spending or use celebratory animation around sensitive debt repayment.
- Translation keys must allow Vietnamese and English word-order/length differences even if the beta launches in one language.

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
- Security communications never contain passwords, OTPs, session tokens, or full financial records.
- Sensitive pages use `no-store` and are excluded from search indexing.
- Copy/paste remains allowed for user-owned amounts and notes; do not use hostile anti-user restrictions.
- Confirmation dialogs do not expose sensitive information to the URL or page title.

## 15. Usability validation plan

Before Private Beta, moderated tests should include representative compact and desktop devices and these tasks:

1. Establish opening balance and explain what it means.
2. Add a routine expense and correct its amount.
3. Record daily income and confirm recurring salary.
4. Find what is due in three days and mark it paid.
5. Explain why an overdue item is not paid automatically.
6. Create a goal, contribute, and explain effect on total balance versus spendable estimate.
7. Create and complete a planned purchase.
8. Recover password and revoke another session.
9. Explain all figures on Home without facilitator help.

Capture completion, errors, time, comprehension, accessibility barriers, and trust concerns. Targets in the PRD are hypotheses until tested.

## 16. UX review blockers

UX cannot be approved until decisions OQ-01 through OQ-08 and OQ-12 through OQ-15 are resolved, a content language is selected, representative formulas are validated, and low/high-fidelity prototypes have completed accessibility and usability review. The token values in the design system are a coherent proposal, not evidence of visual acceptance.
