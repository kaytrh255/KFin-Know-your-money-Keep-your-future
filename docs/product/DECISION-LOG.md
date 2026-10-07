# KFin Product Decision Log

**Status:** Active<br>
**Version:** 0.2<br>
**Decision date:** 2026-10-07<br>
**Source:** Interactive specification review with the project owner

This log records product decisions made after the initial specification foundation was drafted. It replaces the recommendations previously listed as unresolved OQ items. A decision here changes product meaning; affected product, UX, architecture, security, database, and test specifications must remain consistent with it.

`Accepted` means the product direction is selected. It does not mean implementation or release is approved. `Deferred` means the decision has an explicit due gate and blocks that gate.

## 1. Decision summary

| ID | Status | Decision |
|---|---|---|
| OQ-01 | Accepted | Private Beta UI is Vietnamese-first. Message architecture remains English-ready for future localization. |
| OQ-02 | Accepted | Each user has one base currency, selected during onboarding; VND is the default. No conversion or cross-currency aggregation exists in MVP. |
| OQ-03 | Accepted | MVP exposes one aggregate liquid-money account. Multiple accounts, transfers, and bank/account-statement reconciliation workflows are future scope; OQ-13 still permits a manual authoritative balance update. |
| OQ-04 | Accepted | Scheduled income and outgoings never auto-post. Users explicitly confirm received/paid state. |
| OQ-05 | Accepted | Safe-to-spend is authoritative current balance minus unpaid outgoing occurrences due through current user-local month-end minus active savings-goal current amounts. Projected income is excluded until explicitly received and posted. |
| OQ-06 | Accepted | MVP reminders are in-app only. No payment reminder email, push, SMS, or chat delivery. Authentication/security email remains required. |
| OQ-07 | Accepted | Debt interest is informational only. MVP does not accrue interest, amortize debt, or predict payoff. |
| OQ-08 | Accepted | A savings goal has a manually maintained current amount and as-of date. It is not a cash account and has no contribution/withdrawal ledger in MVP. Changes retain audit metadata. |
| OQ-09 | Accepted | Production topology uses Cloudflare, a managed application PaaS, and managed PostgreSQL. |
| OQ-10 | Accepted baseline | An account-deletion request has a 7-day cancellation grace period, then active-system purge. Backup and evidence aging follow OQ-18. Legal review remains mandatory before beta. |
| OQ-11 | Accepted | Private Beta registration requires a single-use, expiring invitation code. |
| OQ-12 | Accepted | Eligible outgoing-obligation in-app reminder stages are evaluated at 09:00 in the user’s IANA timezone. Quiet hours do not apply because there is no external reminder delivery. |
| OQ-13 | Accepted | Historical backfill uses an authoritative balance-snapshot anchor. Transactions explicitly entered as pre-snapshot history appear in reports but do not alter the current balance. |
| OQ-14 | Accepted | MVP supports one-off plus interval-based weekly, monthly, and yearly schedules. A missing monthly day resolves to the last day of that month. Arbitrary RRULE is excluded. |
| OQ-15 | Accepted | Completing a purchase linked to a savings goal asks how much reserved goal amount was used. The expense, confirmed goal decrease, and purchase completion commit atomically. |
| OQ-16 | Accepted direction | Private Beta is Vietnam-first. Prefer a Southeast Asia hosting region, subject to documented Vietnamese legal/privacy and provider-residency review. |
| OQ-17 | Deferred — Release Candidate blocker | Specific PaaS, PostgreSQL, email, observability providers, domain, region, and budget will be selected before Release Candidate, not at implementation kickoff. |
| OQ-18 | Accepted baseline | Maximum baseline retention: encrypted backups 90 days, application logs 90 days, and security/audit events 24 months. Legal review may require shorter periods. |
| OQ-19 | Accepted | Create one in-app notification when an occurrence first becomes overdue. Do not repeat it daily/weekly; Schedule continues to show overdue state. |

## 2. Detailed decisions and consequences

### OQ-01 — Vietnamese-first UI

**Decision**

- Default beta locale is `vi-VN`.
- Product copy, validation, email, date, and amount presentation are designed and tested in Vietnamese.
- Message keys and layout must permit a future English locale, but English UI content is not required for MVP.

**Consequences**

- Vietnamese content review is a release requirement.
- English-only UI is not an acceptable MVP fallback.
- Documentation and code identifiers remain English.

### OQ-02 — One base currency per user

**Decision**

- User selects one ISO 4217 base currency during onboarding; default is `VND`.
- The base currency becomes immutable after financial data exists.
- All user financial records must match it in MVP.

**Consequences**

- No exchange rates, converted totals, or mixed-currency dashboard.
- Supporting a changed or additional currency requires a future migration/product specification.

### OQ-03 — One aggregate money account

**Decision**

- Each MVP user has one system-backed aggregate liquid-money account.
- The account control is implicit in common entry flows.

**Consequences**

- No account picker, transfers, bank/account-statement matching workflow, cash/bank/e-wallet breakdown, or account-level report in MVP.
- A deliberate manual update of the aggregate authoritative balance creates a new OQ-13 snapshot segment; it is not bank/account reconciliation.
- The database retains an account boundary so future multi-account work does not require attaching ownership directly to every new concept.

### OQ-04 — Explicit confirmation

**Decision**

- Scheduled inflow remains projected until `Mark received` succeeds.
- Scheduled outflow remains upcoming/due/overdue until `Mark paid` succeeds.
- Date passage and notification delivery have no financial authority.

**Consequences**

- Dashboard distinguishes projected and posted values.
- Occurrence confirmation and posted transaction linking are atomic and idempotent.

### OQ-05 — Conservative month-end safe-to-spend

**Formula:** `safe_to_spend.v1`

```text
safe-to-spend estimate
= authoritative current balance
- unpaid outgoing occurrences due through the end of the current user-local calendar month
- sum of current amounts on active savings goals
```

**Rules**

- Authoritative current balance is the latest immutable snapshot plus current-impact deltas in only its segment; it is never a whole-history sum.
- Include unresolved overdue outgoings as well as unpaid outgoings due later in the current month.
- Do not include projected income before explicit receipt and posting.
- Do not double-subtract a confirmed outflow already represented by the current balance.
- Do not clamp a negative result to zero; explain the shortfall.
- Display formula version, local horizon, snapshot anchor/as-of time, included values, exclusions, and source drill-down.
- Normative invariant IDs are `FIN-STS-INV-01` through `FIN-STS-INV-07` in the architecture specification; `STS-01` through `STS-15` are the mandatory traced cases.
- This is an estimate based on manual data, not advice or a guarantee.

### OQ-06 — In-app reminders only

**Decision**

- Reminder notifications exist in KFin’s notification center only.
- Authentication, password recovery, and security alert email are separate necessary communications.

**Consequences**

- No reminder-email preference, unsubscribe flow, reminder provider webhook, push token, or mobile permission is required in MVP.
- A user must open KFin to see reminders; Schedule remains authoritative even if no notification was read.

### OQ-07 — Informational debt interest

**Decision**

- Store/display an optional user-entered annual rate and its as-of/source context.
- Do not infer or calculate authoritative principal, interest, fee, interest accrued, amortization, payoff date, lender outstanding, or refinancing advice.

**Consequences**

- Principal/interest/fee values are only what the user explicitly supplies; unclassified remainder stays unknown.
- Outstanding changes only from explicit principal or a user-entered lender-reported balance/as-of date.
- A payment without known principal or reported balance leaves outstanding and its as-of date unchanged.
- Historical payment correction with later outstanding-affecting records remains **BLOCKER `SPEC-DEBT-01`**; KFin must not invent a recomputed result.

### OQ-08 — Manual savings current amount

**Decision**

- `current amount` is a user-maintained reserve estimate with an as-of date.
- User updates the absolute amount; MVP does not model semantic contribution/withdrawal entries.
- Each update records previous value, new value, actor, as-of date, timestamp, and reason/source for audit and correction, but this is not presented as a cash ledger.

**Consequences**

- Savings current amount does not change aggregate cash balance or monthly income/outflow.
- It reduces safe-to-spend as a declared reserve.
- UI uses `Update current amount`, not `Record contribution` or `Withdraw`.
- KFin cannot prove that reserved savings exists in a bank account and must say so.

### OQ-09 and OQ-17 — Managed topology; deferred vendor selection

**Decision**

- Logical production topology is Cloudflare → managed PaaS application/worker → private managed PostgreSQL, with managed email and observability providers.
- Specific vendors are intentionally deferred until before Release Candidate.

**Consequences and accepted risk**

- Domain code, container, PostgreSQL, contracts, and provider adapters remain vendor-neutral.
- Provider-specific networking, backup, IAM, residency, deployment rollback, and cost cannot be verified during early implementation.
- Release Candidate is blocked until provider ADR/addendum, staging deployment, restore drill, security review, and cost/residency approval are complete.
- This deferral increases late integration risk and must be visible in the project risk register.

### OQ-10 and OQ-18 — Deletion and retention baseline

**Decision**

- A verified deletion request changes the account to `deletion_pending` and starts a 7-day cancellation window.
- After the deadline, active identity and financial data are purged or irreversibly anonymized according to an approved deletion map.
- Maximum baseline retention is 90 days for encrypted backups, 90 days for application logs, and 24 months for minimum security/audit evidence.
- Deleted data may remain in immutable backups until expiry; restore procedure must obtain a current tombstone/restore-exclusion register kept independently of the restore point and apply it before restored data is made active.

**Consequences**

- The extended baseline increases privacy and breach impact and requires legal justification, strict access, and retention automation.
- Security/audit evidence retained after account purge must be minimized and pseudonymized where lawful.
- Data export remains out of product scope unless legal review requires it.
- Private Beta cannot open until Vietnamese legal/privacy review approves or shortens these periods and defines the request channel.

### OQ-11 — Single-use invitation codes

**Decision**

- Registration requires a cryptographically random, expiring, single-use invitation code.
- Store only its digest; bind to an invited email where operationally appropriate.
- Code consumption and account creation are atomic.
- A server-side email allowlist is not the Private Beta registration gate and is not an alternative MVP mode.

**Consequences**

- Operators need a minimal audited invitation provisioning procedure; an admin UI is not automatically required.
- Registration responses still resist email/invitation enumeration.

### OQ-12 and OQ-19 — Reminder timing and repetition

**Decision**

- Evaluate 7-day, 3-day, due-today, and first-overdue stages for eligible outgoing obligations at 09:00 user-local time; scheduled income remains projected in Schedule without a fixed-stage notification requirement.
- An eligible occurrence/stage can create at most one notification; normal stage evaluation and catch-up suppression remain distinct.
- The overdue stage fires once; it does not repeat while unchanged.

**Consequences**

- Server evaluation continues while the app is closed; delayed app return reads persisted state and never replays stages or changes financial state.
- Timezone changes, late occurrence creation, and worker downtime require idempotent catch-up without duplicate notification.
- If multiple stages elapsed, one recovery evaluation may create at most one catch-up notification for the occurrence. Which stage, if any, remains **BLOCKER `SPEC-REM-01`**; burst delivery is prohibited.
- Due/overdue status remains derived and visible continuously, independent of notification creation.

### OQ-13 — Snapshot-anchored historical backfill

**Decision**

- One aggregate account has immutable balance snapshots. The latest snapshot is authoritative for current-balance calculation.
- Current balance equals the latest snapshot amount plus posted balance-impacting transactions attached to that snapshot.
- A transaction explicitly entered as pre-snapshot historical backfill contributes to monthly/category reports but has `historical` balance effect and does not alter current balance.
- Creating a newer manual authoritative-balance snapshot starts a new balance segment; transactions under older snapshots remain historical evidence.

**Consequences**

- Onboarding and later manual balance updates must explain the snapshot as-of time.
- A pre-snapshot date automatically selects historical behavior. Same-day ambiguity requires an explicit `already included in snapshot` choice rather than guessing.
- Activity/detail must label historical-only records and explain why they do not affect current balance.
- Editing a transaction cannot silently move it between balance segments.
- Current balance and monthly net movement may not reconcile by simple all-time summation across a snapshot boundary; calculation disclosure must show the anchor.
- Normative behavior is `FIN-SNAP-INV-01` through `FIN-SNAP-INV-10` and snapshot scenarios A–J. Scenario J remains blocked by `SPEC-FIN-01` and `SPEC-FIN-02`; no cross-segment/race behavior is inferred.

### OQ-14 — Bounded recurrence patterns

**Decision**

- Support one-off, every-N-weeks, every-N-months, and every-N-years.
- For monthly day 29/30/31 missing from a month, use that month’s final local calendar day.
- Store timezone and snapshot expected amount on generated occurrences.

**Consequences**

- No daily recurrence and no arbitrary calendar RRULE in MVP.
- Leap-year, short-month, timezone-change, edit-series, and idempotent-generation tests are mandatory.

### OQ-15 — Planned purchase reduces manual savings amount

**Decision**

- When completing a linked purchase, user confirms an amount to deduct from the goal’s current amount.
- The deduction cannot exceed either purchase amount or current goal amount.
- Posted expense, savings old/new amount audit record, and purchase completion commit atomically.
- User may choose zero if the linked goal was not used.

**Consequences**

- The goal is not automatically archived or zeroed.
- Remaining goal amount stays reserved in safe-to-spend.
- Failed/duplicate completion cannot apply a second deduction.

### OQ-16 — Vietnam-first beta and Southeast Asia preference

**Decision**

- Product audience, default locale/timezone/currency, content review, and support planning target users in Vietnam.
- Prefer a Southeast Asia hosting region, subject to provider capability and Vietnamese data/privacy review.

**Consequences**

- This direction is not itself a legal conclusion that cross-border hosting is permitted.
- International beta, additional legal jurisdictions, and broad localization require a future specification.

## 3. Traceability map

This map identifies the primary normative and verification destinations. It is not a substitute for the full requirement-to-test report required at release.

| Decision | Primary product/flow trace | Architecture, security, and verification trace |
|---|---|---|
| OQ-01 | Approved beta context; PRD-NFR-05/06; all user flows | UX §12; TEST §5.8; release §§3, 12 |
| OQ-02 | PRD-AUTH-09, PRD-FIN-05; UF-FIN-01 | Database §§4.1, 5–6; money/currency property tests |
| OQ-03 | PRD-FIN-01/02; UF-FIN-01/03/04 | Database §§5–6; Architecture §§6, 10; balance E2E |
| OQ-04 | PRD-INC-03, PRD-EXP-04, PRD-REM-03; UF-SCH-02/03 | Database §7; TM-17; schedule/payment tests |
| OQ-05 | PRD-SAV-05, PRD-DASH-07; UF-DASH-01 | FIN-STS-INV-01–07; STS-01–STS-15; release financial gate |
| OQ-06 | PRD-REM-05; UF-REM-01 | ADR-008; SEC-EMAIL-04/06; notification release gate |
| OQ-07 | PRD-DEBT-01–06; UF-DEBT-01/02/03 | DEBT-INV-01–08; DCT-01–DCT-09; TM-18 |
| OQ-08 | PRD-SAV-01–07; UF-SAV-01 | Database §9; Architecture §§6, 11; savings audit tests |
| OQ-09 | Roadmap Phase 6 | ADR-007; Architecture §16; provider/deployment gates |
| OQ-10 | PRD-AUTH-10; UF-AUTH-07 | Database §§4.8–4.9, 15, 17; SEC-DATA; deletion/restore tests |
| OQ-11 | PRD-AUTH-01; UF-AUTH-01 | ADR-002; Database §4.2; SEC-AUTH-14/15; valid-code/no-email-allowlist-bypass tests |
| OQ-12 | PRD-REM-02/04/06/10/11/12; UF-REM-01 | REM-INV-01–10; RCT-01–RCT-10; ADR-008; Database §11 |
| OQ-13 | PRD-FIN-02/08–11; UF-FIN-01/02/03/06 | FIN-SNAP-INV-01–10; snapshot A–J; SEC-APP-14/15 |
| OQ-14 | PRD-REM-09; UF-SCH flows | Database §7; recurrence boundary/property tests |
| OQ-15 | PRD-PLAN-03–06; UF-PLAN-02 | Database §§9.2, 10; atomic/idempotent completion tests |
| OQ-16 | Approved beta context and constraints | ADR-007; SEC-DATA-08; legal/residency release gate |
| OQ-17 | Roadmap Phase 6 | ADR-003/007; provider addendum and production-like staging evidence |
| OQ-18 | MVP boundaries §5 | Database §§15, 17; SEC-DATA-03; expiry/restore evidence |
| OQ-19 | PRD-REM-04; UF-REM-01 | ADR-008; Database §11.1; long-overdue dedup tests |

## 4. Remaining review and release blockers

The OQ choices are recorded, but the Implementation Gate remains CLOSED. Open specification blockers are `SPEC-AUTH-01`, `SPEC-AUTH-02`, `SPEC-FIN-01`, `SPEC-FIN-02`, `SPEC-DEBT-01`, `SPEC-SCH-01`, `SPEC-REM-01`, `SPEC-SEC-01`, `SPEC-SEC-02`, `SPEC-DEL-01`, `SPEC-UX-01`, and `SPEC-GOV-01`; exact decisions/evidence and owner roles are centralized in `docs/README.md`. `RC-PROV-01` and `BETA-LEGAL-01` remain later release gates. Documentation must not choose their outcomes silently.

Private Beta release additionally remains blocked by:

1. Vietnamese legal/privacy review of data processing, cross-border region, retention, deletion, consent, and user rights.
2. Specific provider/domain/region/budget selection under OQ-17.
3. Provider responsibility/subprocessor register and contracts.
4. Approved RPO/RTO and incident/support ownership.
5. Accepted architecture/security/session/PWA/deployment/notification ADRs.
6. Validated financial scenarios, prototypes, accessibility/usability review, and complete test traceability.

## 5. Change control

Changing any accepted OQ decision requires:

- product rationale and approver;
- affected requirement/flow/data/threat/test updates;
- migration and existing-user impact where implementation exists;
- a new dated decision-log entry rather than silent replacement.
