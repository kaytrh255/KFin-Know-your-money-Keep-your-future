# Approval and Evidence Register

**Status:** Controlled template; FIN-01/02 candidates recorded, approvals/evidence incomplete<br>
**Version:** 0.3<br>
**Last reviewed:** 2026-10-07<br>
**Implementation Gate:** CLOSED

## 1. Purpose

This register is the controlled governance artifact required to close `SPEC-GOV-01` and to record approvals/evidence for every pre-implementation `SPEC-*` blocker. It does not itself authorize a decision. A row is valid only when it contains a real named approver, date, source version, stable evidence reference, and explicit result.

Round 3 defines role accountability but does not invent named people, approvals, evidence, or physical limits. All incomplete rows remain OPEN.

## 2. Evidence quality rules

Every approval or evidence record must include:

1. stable artifact title and location;
2. artifact version, commit, or immutable hash;
3. production date and review date;
4. author/producer and named reviewer;
5. applicable environment, device, browser, runtime, provider, or database version;
6. scope and method;
7. objective expected result and observed result;
8. PASS, FAIL, or ACCEPTED-RISK result with rationale;
9. linked defects/remediation and retest where applicable;
10. privacy-safe handling and an expiry/review trigger.

`PASS` cannot be recorded for absent evidence. A role label, meeting attendance, pull-request merge, or lack of objection is not approval.

## 3. Authority and assignment register

| Required authority | Accountable scope | Named primary | Named delegate | Appointment evidence | Status |
|---|---|---|---|---|---|
| Product Owner | Product scope, user outcomes, policy choices, gate coordination | Unassigned | Unassigned | Missing | OPEN |
| Architecture Owner | Application architecture, integration boundaries, ADR coherence | Unassigned | Unassigned | Missing | OPEN |
| Engineering Owner | Technical feasibility, implementation stewardship after gate opening, engineering standards | Unassigned | Unassigned | Missing | OPEN |
| Web/PWA Owner | Browser/PWA implementation boundary, cache/install/update behavior after gate opening | Unassigned | Unassigned | Missing | OPEN |
| Security Owner | Threat acceptance, auth/session values, authorization and security controls | Unassigned | Unassigned | Missing | OPEN |
| QA Owner | Verification strategy, acceptance evidence, defect disposition | Unassigned | Unassigned | Missing | OPEN |
| Operations Owner | Runtime operations, recovery, observability, supportability | Unassigned | Unassigned | Missing | OPEN |
| Release Owner | Release control, go/no-go coordination, rollback/hold authority | Unassigned | Unassigned | Missing | OPEN |
| Privacy / Legal Owner | Vietnam privacy/legal basis, retention, deletion, legal hold | Unassigned | Unassigned | Missing | OPEN |
| UX / Accessibility Owner | Visual, content, usability, and accessibility acceptance | Unassigned | Unassigned | Missing | OPEN |
| Financial Integrity Owner | Financial formulas, balance effects, debt no-inference controls | Unassigned | Unassigned | Missing | OPEN |
| Data Owner | PostgreSQL integrity, concurrency, retention maps, data lifecycle | Unassigned | Unassigned | Missing | OPEN |
| Incident Owner | Incident classification, response, restore and post-restore controls | Unassigned | Unassigned | Missing | OPEN |
| Support Owner | User support procedures and support-access boundaries | Unassigned | Unassigned | Missing | OPEN |

### 3.1 Delegation and conflicts

Before any blocker can close, governance owners must approve:

- who may delegate and for how long;
- whether the delegate can accept risk or only review evidence;
- separation of evidence producer and approver for Security, Financial Integrity, Privacy/Legal, and QA decisions;
- escalation when required approvers disagree or are unavailable;
- quorum for cross-domain decisions;
- emergency decisions, expiry, and retrospective review;
- change authority after an approval is recorded.

These rules are unapproved and remain part of `SPEC-GOV-01`.

## 4. Blocker approval register

| Blocker | Accountable owner | Mandatory co-approvers | Required decision/evidence record | Current record | Status |
|---|---|---|---|---|---|
| `SPEC-AUTH-01` | Product Owner | Security Owner | Post-verification outcome and threat/flow/test evidence | Missing | OPEN |
| `SPEC-AUTH-02` | Security Owner | Product Owner | Complete auth/session policy values and benchmark/threat/usability evidence | Missing | OPEN |
| `SPEC-FIN-01` | Product Owner | Financial Integrity, Data, Security Owners | Approve Issue #1 `snapshot_correction.v1`; H–J/`FIN-COR-01`–`10`; linked-domain/threat/UX review | Decision candidate documented; approvers/PR approval missing | OPEN — approval/evidence ready |
| `SPEC-FIN-02` | Data Owner | Architecture, Security, Financial Integrity Owners | Approve Issue #3 policy/ADR-009; execute `FIN-RACE-01`–`08` with idle-confirmed rollback, lock-release, clean reuse, unconfirmed-cleanup eviction/no-retry, query/latency and commit-fault evidence | Cleanup contract documented; approvers/Supabase PostgreSQL evidence missing | OPEN — approval/evidence ready |
| `SPEC-DEBT-01` | Product Owner | Financial Integrity, Data Owners | Historical correction policy and DCT evidence | Missing | OPEN |
| `SPEC-SCH-01` | Product Owner | Data, Architecture Owners | Leap-day/bounds/series-edit policy and boundary evidence | Missing | OPEN |
| `SPEC-REM-01` | Product Owner | Architecture, Operations, QA Owners | Catch-up policy tuple and RCT evidence | Missing | OPEN |
| `SPEC-SEC-01` | Security Owner | Data, Architecture Owners | RLS posture and isolation/residual-risk evidence | Missing | OPEN |
| `SPEC-SEC-02` | Product Owner | Security, Privacy/Legal Owners | Security-event classification and privacy/UX evidence | Missing | OPEN |
| `SPEC-DEL-01` | Privacy/Legal Owner | Product, Security, Operations Owners | Deletion/legal/restore decision and drill evidence | Missing | OPEN |
| `SPEC-UX-01` | UX/Accessibility Owner | Product Owner | Complete UX evidence manifest and sign-off | Missing | OPEN |
| `SPEC-GOV-01` | Product Owner | Architecture, Engineering, Security, QA, Operations, Release, Privacy/Legal, UX/Accessibility Owners | Completed authority, limits, evidence, and sign-off registers | Missing | OPEN |

## 5. Physical-limit decision register

Values below must not be guessed from framework defaults. Each final limit requires domain-owner approval, user consequence, validation behavior, and boundary evidence.

| Limit family | Exact decisions required | Accountable owner | Required co-approvers | Approved value | Evidence | Status |
|---|---|---|---|---|---|---|
| Money | Per-entry min/max, absolute-account bounds, currency minor-unit precision/scale, aggregate overflow behavior; no conversion behavior is introduced | Financial Integrity Owner | Product, Data Owners | Unset | Missing | OPEN |
| Financial concurrency | Lock/statement/request budgets, SQLSTATE/retry/jitter, same-connection rollback plus idle-before-release/result/fresh retry, unconfirmed-cleanup eviction/no-retry, commit recovery/errors | Data Owner | Architecture, Security, Financial Integrity Owners | Candidate: 2,000 ms lock; 5,000 ms statement; 8,000 ms attempts/cleanup/backoff; one retry at 25–75 ms; one 2,000 ms recovery | Supabase PostgreSQL `FIN-RACE`/rollback/pool/latency/fault evidence missing | OPEN — approval/evidence ready |
| Free text | Display name, category/name, notes, cancellation/correction reason, security-event safe detail | Product Owner | Security, Privacy/Legal, UX Owners | Unset | Missing | OPEN |
| Pagination | Default/max page size, cursor lifetime, stable ordering, bounded in-scope history/report range | Architecture Owner | Product, Data, QA Owners | Unset | Missing | OPEN |
| Schedule | Interval maximum, end/duration maximum, active series/user, generation horizon, per-run batch | Product Owner | Architecture, Data, Operations Owners | Unset | Missing | OPEN |
| Authentication | Password, OTP, invitation, session, login and reset rate/attempt/time bounds | Security Owner | Product, Architecture, Operations Owners | Unset | Missing | OPEN |
| Reminder worker | Claim batch, retry/backoff, catch-up recovery window, stale-lock timeout, concurrency | Operations Owner | Product, Architecture, QA Owners | Unset | Missing | OPEN |
| Audit/retention | Event display window, security retention, operational logs, tombstone/restore exclusion, provider records | Privacy/Legal Owner | Security, Operations, Data Owners | Unset | Missing | OPEN |

## 6. Evidence manifest

| Evidence ID | Evidence class | Minimum coverage | Named reviewer | Artifact/version | Result | Status |
|---|---|---|---|---|---|---|
| `EVID-AUTH-POLICY` | Auth/session decision evidence | All `SPEC-AUTH-01`/`02` dimensions | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-AUTH-THREAT` | Threat and abuse review | Registration, verification, login, reset, session replay/revocation | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-AUTH-BENCH` | Runtime benchmark | Argon2id and selected request/session limits on intended runtime | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-FIN-CORRECTION` | Financial correction decision evidence | Issue #1 policy review; snapshot H–J; `FIN-COR-01`–`10`; linked domains, reports, idempotency/stale outcomes | Unassigned | Specification exists; PR/approval evidence missing | Not evaluated | OPEN |
| `EVID-FIN-CONCURRENCY` | PostgreSQL concurrency decision/runtime evidence | Issue #3/ADR-009; `FIN-RACE-01`–`08`; forced orders; version/idempotency; exact SQLSTATE bounds; idle-confirmed rollback before response/check-in/fresh retry; lock release; deterministic clean reuse; unconfirmed-cleanup eviction/no-retry; commit cut points; scope/bypass/latency | Unassigned | Contract candidate hardened; dedicated Supabase PostgreSQL execution/approval artifacts missing | Not evaluated | OPEN |
| `EVID-DEBT` | Debt correction evidence | DCT-08/09 and later-event/missing-state variants | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-SCHEDULE` | Recurrence evidence | Leap years, short months, timezone, series edits, bounds | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-REMINDER` | Reminder recovery evidence | RCT-04–07, outage/late creation/state races | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-RLS` | Data-isolation evidence | Every private table/action, pool reuse, workers/operators | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-SEC-HISTORY` | Event disclosure evidence | Event classification, privacy, content, accessibility | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-DELETION` | Data-lifecycle evidence | Request/cancel/purge/providers/legal hold/restore drill | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-UX-VISUAL` | Visual QA | Compact/expanded layouts and all critical states | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-UX-USABILITY` | Moderated usability | Critical auth, finance, debt, reminder, deletion tasks | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-UX-A11Y` | Accessibility | Keyboard, screen reader, zoom/reflow, contrast, targets, reduced motion | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-GOV-TRACE` | Governance/traceability | Requirements, flows, ADRs, tests, releases, owners | Unassigned | Missing | Not evaluated | OPEN |
| `EVID-OPS-RECOVERY` | Operations/recovery | Backup restore, tombstone reconciliation, monitoring/rollback | Unassigned | Missing | Not evaluated | OPEN |

## 7. Approval record template

Copy this table for each approved decision; do not overwrite historical records.

| Field | Required value |
|---|---|
| Decision/blocker | Stable ID |
| Outcome | Exact selected policy/value; no “as discussed” references |
| Alternatives rejected | Alternatives and rationale |
| Fixed constraints verified | Requirement/invariant IDs |
| Source specification version | Commit/hash and document sections |
| Evidence | Stable evidence IDs/links and versions |
| Accountable approver | Named person and role |
| Mandatory co-approvers | Named people and roles |
| Approval date | ISO date/time and timezone |
| Result | APPROVED, REJECTED, or ACCEPTED RISK |
| Conditions/expiry | Required follow-up and review trigger |
| Supersedes | Earlier decision record, if any |
| Change record | Documents synchronized and validation result |

## 8. Gate rule

`SPEC-GOV-01` remains OPEN until Sections 3–6 are complete and reviewed. Other blockers cannot cite this template as evidence; they must cite completed, versioned records. No Proposed or Blocked ADR may become Accepted, and the Implementation Gate may not open, merely because this register exists.
