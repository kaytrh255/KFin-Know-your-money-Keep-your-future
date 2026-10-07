# KFin Specification Remediation Round 3 Report

**Status:** Documentation remediation complete; owner decisions and evidence remain open<br>
**Date:** 2026-10-07<br>
**Role:** Specification Architect / Documenter<br>
**Scope:** Pre-implementation specification blockers only<br>
**Implementation Gate:** CLOSED

## 1. Round 3 outcome

Round 3 processed every open `SPEC-*` blocker in the requested priority order: AUTH → FIN → DEBT → SCHEDULE → REMINDER → SECURITY → UX → GOVERNANCE. `SPEC-DEL-01` is included under Security and Data Lifecycle because it is also a pre-implementation blocker.

This remediation converts broad blocker statements into reviewable decision packets with:

- the exact decision boundary;
- constraints that are already fixed and cannot be reopened implicitly;
- accountable and consulted owner roles;
- evidence required for approval;
- binary acceptance criteria;
- affected source-of-truth documents; and
- an explicit post-remediation state.

No unresolved Product, Security, Financial Integrity, Data, Privacy, UX, or Governance choice was invented. No missing validation artifact was represented as evidence. Consequently, all twelve `SPEC-*` blockers remain **OPEN**, all ADR statuses remain unchanged, and the Implementation Gate remains **CLOSED**.

## 2. Status semantics

| State | Meaning |
|---|---|
| OPEN — decision packet missing | The decision boundary or closure evidence is not sufficiently specified. This was the pre-Round-3 condition for parts of the register. |
| OPEN — decision ready | Round 3 specifies owners, decision inputs, evidence, and acceptance criteria, but an authorized decision or required evidence is still absent. This is the post-Round-3 condition. |
| RESOLVED | Authorized owners selected one explicit outcome, all affected specifications were synchronized, required evidence is linked and reviewed, acceptance criteria pass, and the blocker register records approver/date/version. |

Writing a decision packet, selecting a preferred option in implementation, or producing documentation consistency evidence alone does not resolve a blocker.

## 3. Remediation summary

| Priority | Blocker | Before Round 3 | Round 3 result | Decisions already fixed | After Round 3 |
|---|---|---|---|---|---|
| AUTH | `SPEC-AUTH-01` | One binary post-verification question without a closure contract | Two permissible outcomes and shared safety obligations are specified; owner/evidence/criteria are explicit | OTP is single-use; verification is atomic; no pre-auth session identifier survives | OPEN — decision ready |
| AUTH | `SPEC-AUTH-02` | Multiple auth values bundled into one broad approval statement | Policy dimensions, required inputs, and evidence are enumerated | Invitation-code mechanism, Argon2id, generic errors, digest-only secrets, reset-all-session revocation | OPEN — decision ready |
| FIN | `SPEC-FIN-01` | Correction/void behavior was blocked in scenarios H–J without a complete decision checklist | Record model, link effects, reporting, idempotency, and cross-segment support decisions are enumerated | No history erasure, no double effect, closed history cannot rewrite current balance | OPEN — decision ready |
| FIN | `SPEC-FIN-02` | Linearizable outcome required, serialization and conflict contract unspecified | Required linearization point, conflict behavior, idempotency behavior, and spike evidence are explicit | Exactly one latest segment; no silent re-anchor; deterministic current balance | OPEN — decision ready |
| DEBT | `SPEC-DEBT-01` | Later-event correction offered two broad alternatives | Explicit-fact replay and mandatory fresh lender-balance options now have safety/evidence criteria | No inferred principal, interest, fee, amortization, payoff, or outstanding | OPEN — decision ready |
| SCHEDULE | `SPEC-SCH-01` | Leap-day, bounds, and series-edit decisions were grouped but under-specified | Each decision dimension and required boundary scenarios are explicit | Supported cadence set and monthly missing-day fallback remain fixed | OPEN — decision ready |
| REMINDER | `SPEC-REM-01` | Catch-up stage selection was blocked without a complete policy tuple | Selection, recovery window, suppression record, and state-race criteria are explicit | At most one catch-up notification; no burst; occurrence state remains financial authority | OPEN — decision ready |
| SECURITY | `SPEC-SEC-01` | RLS versus compensating controls lacked branch-specific acceptance evidence | Both branches now have mandatory controls and test evidence | Application authorization, same-user constraints, deny-by-default, and two-user tests apply either way | OPEN — decision ready |
| SECURITY | `SPEC-SEC-02` | User-visible security events were not classified | Event classes, detail/privacy rules, delivery behavior, and retention/display decisions are enumerated | No secrets, false geolocation, account enumeration, or financial payload in event UX | OPEN — decision ready |
| SECURITY / DATA | `SPEC-DEL-01` | Deletion decisions were broad and legally dependent | Request, cancellation, purge map, retained evidence, restore exclusion, legal hold, and provider proof criteria are explicit | Seven-day cancellation and post-deadline active-data purge baseline remain fixed | OPEN — decision ready |
| UX | `SPEC-UX-01` | Evidence categories were named but no closure manifest existed | A required evidence manifest, owner, artifact metadata, and pass conditions are defined | Specification review is separate from visual, usability, and accessibility acceptance | OPEN — evidence ready |
| GOVERNANCE | `SPEC-GOV-01` | Role list and evidence expectations existed without an approval register | Approval-role register, physical-limit register, evidence manifest, and sign-off rules are defined | Role-based accountability is mandatory; anonymous or implied approval is invalid | OPEN — evidence/assignment ready |

### 3.1 Changed-document matrix

Every blocker changed these shared gate/traceability documents: root `README.md`, `docs/README.md`, `docs/product/PRD.md`, `docs/product/MVP-SCOPE.md`, `docs/product/DECISION-LOG.md`, `docs/product/ROADMAP.md`, `docs/testing/TEST-STRATEGY.md`, `docs/testing/RELEASE-CHECKLIST.md`, `docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md`, and this report.

The following additional source documents were changed for each blocker:

| Blocker | Additional Round 3 documents changed |
|---|---|
| `SPEC-AUTH-01` | `product/USER-FLOWS.md`; `architecture/ARCHITECTURE.md`; `architecture/ADR/README.md`; `architecture/ADR/ADR-002-authentication-strategy.md`; `architecture/ADR/ADR-004-session-management.md`; `security/SECURITY-REQUIREMENTS.md`; `security/THREAT-MODEL.md`; `ux/UX-SPEC.md`; `ux/SCREEN-INVENTORY.md` |
| `SPEC-AUTH-02` | `product/USER-FLOWS.md`; `architecture/ARCHITECTURE.md`; `architecture/DATABASE.md`; `architecture/ADR/README.md`; `architecture/ADR/ADR-002-authentication-strategy.md`; `architecture/ADR/ADR-004-session-management.md`; `security/SECURITY-REQUIREMENTS.md`; `security/THREAT-MODEL.md`; `ux/UX-SPEC.md`; `ux/SCREEN-INVENTORY.md` |
| `SPEC-FIN-01` | `product/USER-FLOWS.md`; `architecture/ARCHITECTURE.md`; `architecture/DATABASE.md`; `architecture/ADR/README.md`; `security/THREAT-MODEL.md`; `ux/UX-SPEC.md`; `ux/SCREEN-INVENTORY.md` |
| `SPEC-FIN-02` | `product/USER-FLOWS.md`; `architecture/ARCHITECTURE.md`; `architecture/DATABASE.md`; `architecture/ADR/README.md`; `architecture/ADR/ADR-003-database-choice.md`; `security/THREAT-MODEL.md`; `ux/UX-SPEC.md`; `ux/SCREEN-INVENTORY.md` |
| `SPEC-DEBT-01` | `product/USER-FLOWS.md`; `architecture/DATABASE.md`; `architecture/ADR/README.md`; `security/THREAT-MODEL.md`; `ux/UX-SPEC.md`; `ux/SCREEN-INVENTORY.md` |
| `SPEC-SCH-01` | `product/USER-FLOWS.md`; `architecture/ARCHITECTURE.md`; `architecture/DATABASE.md`; `architecture/ADR/README.md`; `security/THREAT-MODEL.md`; `ux/UX-SPEC.md`; `ux/SCREEN-INVENTORY.md` |
| `SPEC-REM-01` | `product/USER-FLOWS.md`; `architecture/ARCHITECTURE.md`; `architecture/DATABASE.md`; `architecture/ADR/README.md`; `architecture/ADR/ADR-008-notification-architecture.md`; `security/THREAT-MODEL.md`; `ux/UX-SPEC.md`; `ux/SCREEN-INVENTORY.md` |
| `SPEC-SEC-01` | `architecture/ARCHITECTURE.md`; `architecture/DATABASE.md`; `architecture/ADR/README.md`; `architecture/ADR/ADR-003-database-choice.md`; `security/SECURITY-REQUIREMENTS.md`; `security/THREAT-MODEL.md` |
| `SPEC-SEC-02` | `architecture/ADR/README.md`; `architecture/ADR/ADR-004-session-management.md`; `security/SECURITY-REQUIREMENTS.md`; `security/THREAT-MODEL.md`; `ux/UX-SPEC.md`; `ux/SCREEN-INVENTORY.md` |
| `SPEC-DEL-01` | `product/USER-FLOWS.md`; `architecture/ARCHITECTURE.md`; `architecture/DATABASE.md`; `architecture/ADR/README.md`; `architecture/ADR/ADR-007-deployment-architecture.md`; `security/SECURITY-REQUIREMENTS.md`; `security/THREAT-MODEL.md`; `ux/UX-SPEC.md`; `ux/SCREEN-INVENTORY.md` |
| `SPEC-UX-01` | `architecture/ADR/README.md`; `architecture/ADR/ADR-005-pwa-strategy.md`; `architecture/ADR/ADR-006-mobile-strategy.md`; `ux/UX-SPEC.md`; `ux/UI-DESIGN-SYSTEM.md`; `ux/SCREEN-INVENTORY.md` |
| `SPEC-GOV-01` | `architecture/ARCHITECTURE.md`; `architecture/DATABASE.md`; `architecture/ADR/README.md`; `architecture/ADR/ADR-005-pwa-strategy.md`; `architecture/ADR/ADR-006-mobile-strategy.md`; `architecture/ADR/ADR-007-deployment-architecture.md`; `security/SECURITY-REQUIREMENTS.md`; `security/THREAT-MODEL.md`; all three UX documents |

Paths in this matrix are relative to `docs/` unless shown as root `README.md`. ADR-001 itself was not edited because Round 3 changed its governance closure record in the ADR index and register without changing the proposed application-architecture choice.

## 4. AUTH decision packets

### 4.1 `SPEC-AUTH-01` — Post-verification outcome

**Before:** The flow allowed either an authenticated session or a return to sign-in, but did not define the complete decision record required to choose one.

**Decision required:** Product and Security owners must select exactly one outcome:

1. **Fresh authenticated session:** successful OTP consumption atomically activates the account and creates a newly generated/rotated authenticated session; no pre-verification identifier is promoted.
2. **Explicit sign-in:** successful OTP consumption activates the account but creates no authenticated session; the result directs the user to sign in explicitly.

The decision must also specify result-screen copy, onboarding transition, cookie/CSRF behavior, security-event behavior, multi-tab behavior, and retry behavior after an uncertain response.

**Fixed constraints:** OTP consumption is single-use and atomic; session fixation is prohibited; generic enumeration-resistant behavior remains; only a fresh authenticated context may enter onboarding.

**Accountable owner:** Product Owner.<br>
**Required co-approver:** Security Owner.<br>
**Consulted roles:** UX/Accessibility Owner, Architecture Owner, QA Owner.

**Required evidence:** Threat review of both branches; compact/expanded flow review; session-fixation and uncertain-response test design; approved Vietnamese result copy; recorded decision rationale.

**Acceptance criteria:**

- one outcome is selected explicitly in the Decision Log;
- `UF-AUTH-01`, PRD authentication requirements, ADR-002, ADR-004, security requirements, and test expectations contain one outcome and no alternative wording;
- session creation/absence, rotation, CSRF, redirect, audit event, and retry results are deterministic;
- Product and Security approver names, date, specification version, and evidence links are recorded.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** User Flows, Security Requirements, ADR-002, ADR-004, Test Strategy, Decision Log, this report.

**After:** **OPEN — decision ready.** No branch was selected in Round 3.

### 4.2 `SPEC-AUTH-02` — Authentication and session policy values

**Before:** Invitation, password, OTP, recovery, abuse, and session settings were grouped as one blocker with only partial proposed baselines.

**Decision required:** Approve every policy dimension below, including exact value, secure configurable range where applicable, and change authority:

| Dimension | Decision required |
|---|---|
| Invitation | Expiry, email binding rule, issuance authority, provisioning/audit procedure, revocation, replacement, and operator access |
| Password | Minimum/maximum, Unicode normalization/truncation behavior, compromised-password method/privacy contract, and rehash trigger |
| Verification OTP | Lifetime, attempts, resend cooldown, target/IP/global caps, supersession, and provider-uncertainty behavior |
| Password reset | Secret lifetime, request/consume limits, resend/replacement behavior, and failure handling |
| Login abuse | Account/IP/network/global thresholds, backoff/lock behavior, recovery, monitoring, and tuning authority |
| Session lifetime | Idle, absolute, recent-auth window, last-seen write policy, and disabled/deletion-pending enforcement |
| Rotation/replay | Rotation cadence, prior-token grace, concurrent-tab behavior, replay containment, and security-event behavior |
| Known-password change | Other-session revocation versus all-session revocation, current-session rotation/end, and user communication |

**Fixed constraints:** Mandatory single-use invitation codes; no email-allowlist admission; Argon2id; password-manager/paste support; digest-only secrets; generic responses; password reset revokes all sessions; no security questions.

**Accountable owner:** Security Owner.<br>
**Required co-approver:** Product Owner.<br>
**Consulted roles:** Architecture Owner, UX/Accessibility Owner, Operations Owner, Privacy/Legal Owner, QA Owner.

**Required evidence:** Current threat review; Argon2 benchmark on intended runtime; provider quota/failure assumptions; abuse-cost model; usability/accessibility review; concurrent-tab/replay test design; privacy review for compromised-password checks and metadata.

**Acceptance criteria:** Every table row has an approved value/range and named owner; proposed values are relabelled Accepted or replaced; ADR-002/004 and all auth/security/test documents agree; boundary, replay, expiry, enumeration, and provider-failure tests have exact expected outcomes; approver/date/evidence links are recorded.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** Security Requirements, ADR-002, ADR-004, Test Strategy, Decision Log, Governance Approval Register, this report.

**After:** **OPEN — decision ready.** Proposed baselines remain proposals.

## 5. FIN decision packets

### 5.1 `SPEC-FIN-01` — Transaction correction and void semantics

**Before:** Snapshot scenarios H–J retained blockers, but the complete set of choices required to remove them was not centralized.

**Decision required:** Approve all of the following:

- append-only correction representation, including whether every supported correction uses void + replacement;
- difference between correction and void and their API/state transitions;
- link behavior for schedule occurrences, debt payments, and planned purchases;
- current-month and prior-month reporting effects;
- supported/rejected balance-effect and snapshot-segment transitions;
- user consequence preview and reason requirements;
- idempotency retry response and stale-version behavior;
- audit-chain fields and UI history presentation.

**Fixed constraints:** No in-place history erasure; one effective financial effect; correction of closed prior history cannot rewrite authoritative current balance; no silent segment/effect movement; same-user/currency/anchor checks remain mandatory.

**Accountable owner:** Product Owner.<br>
**Required co-approvers:** Financial Integrity Owner, Data Owner, Security Owner.<br>
**Consulted roles:** UX/Accessibility Owner, QA Owner, Architecture Owner.

**Required evidence:** Completed expected results for snapshot scenarios H–J; linked-domain correction walkthroughs; threat review; idempotency and stale-write test design; UX consequence-preview review.

**Acceptance criteria:** H–J contain no unknown correction result attributable to `SPEC-FIN-01`; supported and rejected transitions are exhaustive; DB/API/UI/audit/report behavior is deterministic; all affected requirements and tests agree; named approvers/date/evidence are recorded.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** Architecture, Database, Test Strategy, Decision Log, ADR Index, this report.

**After:** **OPEN — decision ready.** Safety invariants remain fixed; correction model remains unselected.

### 5.2 `SPEC-FIN-02` — Snapshot/transaction serialization

**Before:** Specifications required one deterministic latest segment but did not select the PostgreSQL serialization mechanism or retryable conflict contract.

**Decision required:** Select and document one mechanism that defines:

- the per-account linearization point for snapshot creation and current-impact transaction writes;
- lock/isolation ordering and transaction boundaries;
- behavior when a snapshot wins, a transaction wins, or a client holds a stale version;
- whether the server rejects, retries internally, or requires deliberate user retry;
- stable idempotency result after timeout/commit uncertainty;
- conflict error code, safe message, and consequence preview;
- worker/operator behavior under the same account context.

Candidate mechanisms may be evaluated, but Round 3 does not select row locking, advisory locking, or serializable isolation.

**Fixed constraints:** Exactly one latest segment; no ambiguous attachment; no silent re-anchor; no duplicate effect; old segments never re-enter current balance.

**Accountable owner:** Data Owner.<br>
**Required co-approvers:** Architecture Owner, Security Owner, Financial Integrity Owner.<br>
**Consulted roles:** Product Owner, QA Owner, Operations Owner.

**Required evidence:** PostgreSQL concurrency spike on the intended transaction layer; deterministic race tests; deadlock/timeout behavior; idempotency timeout-after-commit proof; query/lock review; documented operational diagnostics without sensitive payload.

**Acceptance criteria:** Scenario J has one approved transaction-order/conflict result for every race branch; the selected mechanism and API contract are recorded in an accepted ADR amendment or new ADR; Database, Architecture, Security, Flow, and Test documents agree; evidence and approvers are linked.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** Architecture, Database, Test Strategy, Decision Log, ADR Index, this report.

**After:** **OPEN — decision ready.** No serialization primitive was selected.

## 6. DEBT decision packet

### 6.1 `SPEC-DEBT-01` — Historical payment correction with later events

**Before:** The blocker named deterministic replay or a fresh lender-reported balance but lacked branch-specific safety and closure evidence.

**Decision required:** Product and Financial Integrity owners must select one supported policy, or explicitly define a bounded combination:

1. **Explicit-fact replay:** replay the complete ordered chain only when every outstanding-affecting input and pre-state is explicit; any gap blocks replay.
2. **Mandatory fresh lender-reported balance:** correct cash/history facts, but do not recompute current outstanding; require a new explicit lender-reported balance/as-of value.

The decision must address void, date reorder, later principal, later lender adjustments, occurrence links, audit presentation, and partial failure.

**Fixed constraints:** Cash and debt state are separate; KFin never infers principal, interest, fee, accrued interest, amortization, payoff, or outstanding; unsafe computation remains unavailable.

**Accountable owner:** Product Owner.<br>
**Required co-approvers:** Financial Integrity Owner, Data Owner.<br>
**Consulted roles:** Security Owner, UX/Accessibility Owner, QA Owner.

**Required evidence:** Exact expected outcomes for DCT-08 and DCT-09 plus multi-event variants; lender-balance UX review; chronological replay proof if selected; audit/idempotency test design; no-inference review.

**Acceptance criteria:** One supported policy is explicit; every later-event/missing-state/date-reorder branch has an exact result; DCT-08/09 are no longer blocked; outstanding cannot be inferred; PRD, Flow, UX, Database, Security, and Test documents agree; approvals/evidence are recorded.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** Database, User Flows, Test Strategy, Decision Log, this report.

**After:** **OPEN — decision ready.** Neither policy was selected.

## 7. SCHEDULE decision packet

### 7.1 `SPEC-SCH-01` — Recurrence boundaries and series editing

**Before:** Three separate product decisions were grouped under one broad blocker.

**Decision required:** Approve each dimension independently:

| Dimension | Required decision |
|---|---|
| Yearly 29 February | Choose 28 February, 1 March, skip non-leap years, or another explicitly reviewed result; define return to 29 February in leap years |
| Bounds | Maximum interval for weekly/monthly/yearly schedules, maximum end date/duration, future occurrence generation horizon, per-run batch, and per-user active-series limits |
| Series edit | Supported fields and behavior for `this occurrence` and `this and future`; split-point semantics; reminder regeneration; preservation of confirmed/skipped/cancelled history |

**Fixed constraints:** MVP supports one-off and every-N-week/month/year only; no daily/arbitrary RRULE; missing monthly day 29/30/31 uses the month’s final local date; generated occurrences are idempotent; time passage never confirms money.

**Accountable owner:** Product Owner.<br>
**Required co-approvers:** Data Owner, Architecture Owner.<br>
**Consulted roles:** UX/Accessibility Owner, Operations Owner, QA Owner.

**Required evidence:** Fixed-clock leap-year/short-month/timezone matrix; bounded generation/load analysis for at most 50 users; series-edit UX walkthrough; edit-versus-worker race design; history-preservation tests.

**Acceptance criteria:** Every decision-table row has one outcome; API/UI fields and bounds are explicit; recurrence and series-edit tests have exact expected results; PRD, Flows, Database, UX, Security, and Test documents agree; approvers/evidence are recorded.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** PRD, User Flows, Database, Test Strategy, Decision Log, this report.

**After:** **OPEN — decision ready.** Monthly missing-day behavior remains fixed; yearly and edit/bound choices remain open.

## 8. REMINDER decision packet

### 8.1 `SPEC-REM-01` — Catch-up selection and suppression

**Before:** The no-burst boundary was fixed, while stage selection, recovery window, and suppression record remained open.

**Decision required:** Approve one complete policy tuple:

- whether a catch-up notification is emitted at all after one missed stage and after multiple missed stages;
- deterministic stage precedence if one is emitted;
- maximum recovery age/window;
- treatment of first-overdue versus pre-due/due-today stages;
- persisted status/reason for each non-selected elapsed stage;
- behavior after timezone change or late occurrence creation;
- race result if occurrence state changes during recovery.

Round 3 does not select `latest`, `earliest`, `most severe`, `none`, or any other precedence.

**Fixed constraints:** At most one catch-up notification per occurrence/recovery evaluation; no multi-stage burst; occurrence + stage uniqueness; state recheck; no financial-state mutation; in-app only.

**Accountable owner:** Product Owner.<br>
**Required co-approvers:** Architecture Owner, Operations Owner, QA Owner.<br>
**Consulted roles:** UX/Accessibility Owner, Security Owner.

**Required evidence:** Exact RCT-04–RCT-07 outcomes; fixed-clock/timezone tests; worker outage and late-creation simulations; state-race proof; Vietnamese content and accessibility review; deduplication evidence.

**Acceptance criteria:** The complete policy tuple is recorded; RCT-04–RCT-07 have one expected result each; suppressed stages are auditable without notification spam; PRD, Flow, ADR-008, Database, UX, Security, and Test documents agree; approvers/evidence are recorded.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** PRD, ADR-008, Test Strategy, Decision Log, this report.

**After:** **OPEN — decision ready.** No catch-up precedence was selected.

## 9. SECURITY and DATA LIFECYCLE decision packets

### 9.1 `SPEC-SEC-01` — PostgreSQL RLS versus compensating controls

**Before:** The blocker required RLS or a risk-approved alternative without branch-specific acceptance criteria.

**Decision required:** Select exactly one beta posture:

1. **RLS required:** define covered tables/actions, trusted tenant context, connection-pool reset, worker/operator/migration roles, bypass policy, failure mode, and policy tests.
2. **RLS omitted for beta:** record accepted residual risk and mandatory compensating controls, including owner-scoped repositories, composite ownership constraints, least-privilege DB roles, architecture tests preventing unscoped access, two-user API coverage, and review requirements.

**Fixed constraints:** Application-level authorization, server-derived identity, owner-scoped queries, same-user relationships, least privilege, deny-by-default behavior, safe unavailable responses, and two-user testing remain mandatory under either branch.

**Accountable owner:** Security Owner.<br>
**Required co-approvers:** Data Owner, Architecture Owner.<br>
**Consulted roles:** Operations Owner, QA Owner, Privacy/Legal Owner.

**Required evidence:** PostgreSQL/pool context spike; every private table/action matrix; two-user positive/negative tests; worker/operator path review; connection-reuse leakage test; residual-risk record if RLS is omitted.

**Acceptance criteria:** One branch is selected in ADR-003 or a dedicated ADR; table/action and role coverage is exhaustive; pool/worker/operator behavior is deterministic; compensating controls and residual risk are explicit where applicable; evidence and approvals are linked.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** Security Requirements, ADR-003, Test Strategy, Decision Log, ADR Index, this report.

**After:** **OPEN — decision ready.** PostgreSQL remains selected; RLS posture remains unselected.

### 9.2 `SPEC-SEC-02` — User-visible security history

**Before:** Documents referenced security history without an approved event classification or disclosure policy.

**Decision required:** Classify each event family as user-visible, operator-only, both, or not retained, and decide notification/display/retention behavior:

- successful and failed sign-in/risk events;
- session creation, rotation/replay response, and revocation;
- password change/reset and verification changes;
- invitation/account activation events;
- account lock/disable and deletion request/cancellation;
- profile/email/timezone/base-currency security-relevant changes;
- operator/support access and incident actions.

For visible events, approve safe detail fields, approximate device/network wording, timestamps/timezone, acknowledgement/deep link, and retention/display window.

**Fixed constraints:** No password, OTP, bearer token, precise geolocation claim, internal detection rule, financial amount/note, or reliable account-enumeration signal may be disclosed.

**Accountable owner:** Product Owner.<br>
**Required co-approvers:** Security Owner, Privacy/Legal Owner.<br>
**Consulted roles:** UX/Accessibility Owner, Operations Owner, Support Owner, QA Owner.

**Required evidence:** Threat/privacy review; Vietnamese content review; event-by-event disclosure table; screen-reader/compact-screen prototype review; retention consistency review; test expectations for safe fields and authorization.

**Acceptance criteria:** Every event family has one classification; visible fields and delivery behavior are explicit; operator-only events cannot leak through user APIs; Security, PRD/Flows, UX/Screens, Database retention, and Test documents agree; approvals/evidence are recorded.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** Security Requirements, ADR-004, UX Specification, Test Strategy, Decision Log, this report.

**After:** **OPEN — decision ready.** No event family was newly classified in Round 3.

### 9.3 `SPEC-DEL-01` — Deletion and restore exclusion

**Before:** The accepted seven-day/purge baseline existed, while operational, legal, and storage decisions remained broad.

**Decision required:** Approve:

- user request and cancellation channels plus identity/recent-auth requirements;
- account/session behavior during `deletion_pending`;
- complete first-party table/field and provider deletion map;
- minimum retained pseudonymous evidence, purpose, legal basis, access, and expiry;
- independently protected restore-exclusion register storage, subject digest/key rotation, access, replication, expiry, and outage behavior;
- backup restore re-deletion sequence and activation gate;
- legal-hold authority, scope, notice, expiry, and audit;
- provider deletion proof and failure/escalation behavior.

**Fixed constraints:** Seven-day cancellation window; post-deadline active-data purge/anonymization under an approved map; restored data cannot reactivate a deleted account; reusable auth secrets are not retained.

**Accountable owner:** Privacy/Legal Owner.<br>
**Required co-approvers:** Product Owner, Security Owner, Operations Owner.<br>
**Consulted roles:** Data Owner, Support Owner, Incident Owner, QA Owner.

**Required evidence:** Vietnamese legal/privacy opinion; complete deletion inventory/map; provider contracts/settings; cancellation/purge race tests; restore drill using the current tombstone register; key/access review; user communication and support procedure.

**Acceptance criteria:** Every system/provider/data category has a disposition; request/cancel/purge states are deterministic; retained fields have lawful purpose/expiry; restore cannot resurrect data; legal-hold behavior is authorized; evidence/approvals are linked across Security, Database, Flows, Tests, and Release Checklist.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** Security Requirements, User Flows, Database, Test Strategy, Decision Log, Governance Approval Register, this report.

**After:** **OPEN — decision ready.** Legal and operational choices remain open.

## 10. UX evidence packet

### 10.1 `SPEC-UX-01` — Visual, usability, content, and accessibility evidence

**Before:** The UX specification correctly separated evidence classes but had no closure manifest with required metadata and owner sign-off.

**Decision/evidence required:** Produce and approve the manifest defined in the UX Specification for compact/expanded prototypes, Vietnamese content, moderated usability tasks, keyboard, screen reader, zoom/reflow, contrast, touch targets, reduced motion, error/offline/conflict states, and critical financial/auth/reminder/deletion comprehension.

**Fixed constraints:** UX specification review is not visual acceptance; visual acceptance is not usability or accessibility acceptance; automated checks alone do not prove WCAG conformance or usability.

**Accountable owner:** UX/Accessibility Owner.<br>
**Required co-approver:** Product Owner.<br>
**Consulted roles:** Security Owner, Financial Integrity Owner, QA Owner, Privacy/Legal Owner.

**Required evidence:** Dated artifact versions; reviewer/participant profile; device/browser/assistive-technology matrix; task script; observed results and defects; approved thresholds; remediation/retest links; explicit sign-off.

**Acceptance criteria:** Every manifest row has a dated artifact and named approver; critical tasks and required states are covered; no unresolved severe accessibility/usability defect remains; Vietnamese content is approved; evidence links are stable and privacy-safe.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** UX Specification, Screen Inventory, Test Strategy, Governance Approval Register, this report.

**After:** **OPEN — evidence ready.** No prototype, study, or accessibility evidence was created by documentation work.

## 11. GOVERNANCE evidence and approval packet

### 11.1 `SPEC-GOV-01` — Named authority, physical limits, and evidence control

**Before:** Required roles and broad evidence classes existed, but named assignments, physical-limit dispositions, and a controlled approval record did not.

**Decision/evidence required:** Complete the Governance Approval Register with:

- one named accountable person and backup/delegate policy for every required role;
- conflict/escalation and quorum rules;
- approved money/note/page/job/recurrence/rate-limit bounds owned by the correct domain;
- stable evidence locations, version/hash/date, reviewer, result, and expiry/review trigger;
- specification and ADR sign-off records;
- change-control and supersession history.

**Fixed constraints:** Role labels cannot substitute for a named approver at acceptance; silence is not approval; evidence must be reproducible and privacy-safe; an ADR cannot become Accepted solely to clear a gate.

**Accountable owner:** Product Owner for governance completion.<br>
**Required co-approvers:** Architecture Owner, Engineering Owner, Security Owner, QA Owner, Operations Owner, Release Owner, Privacy/Legal Owner, UX/Accessibility Owner.<br>
**Consulted roles:** Web/PWA Owner, Financial Integrity Owner, Data Owner, Incident Owner, Support Owner.

**Required evidence:** Completed approval register; approved physical-limit table; linked formula/flow/architecture/security/UX/test reviews; ADR review records; change-control audit.

**Acceptance criteria:** No mandatory role is unassigned; every physical bound has value/rationale/owner/test; all required evidence records have version/date/reviewer/result; every Proposed/Blocked ADR has an evidence-based disposition; register and source documents agree.

**Primary blocker-specific documents (see §3.1 for the complete change matrix):** Specification Index, ADR Index, Test Strategy, Governance Approval Register, Decision Log, this report.

**After:** **OPEN — evidence/assignment ready.** Round 3 assigned role responsibilities but did not invent people, approvals, limits, or evidence.

## 12. ADR impact

Round 3 does not change any ADR status:

| ADR | Status after Round 3 | Round 3 effect |
|---|---|---|
| ADR-001 | Proposed | Governance evidence contract clarified; no architecture spike evidence supplied |
| ADR-002 | Blocked | `SPEC-AUTH-01`/`02` closure contract added; no outcome/value approved |
| ADR-003 | Blocked | `SPEC-SEC-01` branch criteria added; no RLS posture selected |
| ADR-004 | Blocked | Auth/session and security-event criteria clarified; no policy approved |
| ADR-005 | Proposed | UX/governance evidence remains absent |
| ADR-006 | Proposed | UX/governance evidence remains absent |
| ADR-007 | Proposed | `SPEC-DEL-01` lifecycle architecture boundary clarified; governance/provider/legal evidence remains absent |
| ADR-008 | Blocked | `SPEC-REM-01` policy tuple and closure evidence clarified; no catch-up policy selected |

**Accepted — none.** Proposed — ADR-001, ADR-005, ADR-006, ADR-007. Blocked — ADR-002, ADR-003, ADR-004, ADR-008.

`SPEC-FIN-02` resolution must create or amend an ADR before that blocker can close. Round 3 does not create an ADR that pretends an unselected serialization option is a decision.

## 13. Validation and change scope

Round 3 validation must confirm:

- all twelve `SPEC-*` blockers appear in this report and the centralized register;
- every blocker has decision boundary, owner roles, evidence, acceptance criteria, source documents, and post-state;
- no ADR status changed without approver/evidence;
- the Implementation Gate remains CLOSED;
- no source code, package, migration, Docker configuration, infrastructure implementation, or executable application/test artifact was added.

## 14. Gate statement

**Implementation Gate: CLOSED**

Round 3 makes the remaining blockers decision-ready. It does not resolve them by documentation alone.
