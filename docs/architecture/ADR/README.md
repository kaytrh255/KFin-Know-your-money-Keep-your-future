# KFin Architecture Decision Records

Round 3 still records **zero Accepted ADRs**. Product decisions embedded within an ADR may already be fixed—for example mandatory invitation codes, managed PostgreSQL topology, and Web/PWA direction—but the complete ADR is not Accepted until every unresolved decision is authorized and every stated validation condition has evidence. Round 3 made blocker packets decision-ready; it did not approve an ADR or authorize implementation.

| ADR | Decision | Status | Decision-owner roles | Exact acceptance blocker |
|---|---|---|---|---|
| [ADR-001](ADR-001-application-architecture.md) | Modular monolith and TypeScript monorepo | Proposed | Architecture; Engineering; Security; Operations | `SPEC-GOV-01`: named approval/architecture spike evidence absent; Fastify/Vite remains proposed |
| [ADR-002](ADR-002-authentication-strategy.md) | Mandatory invitation-code email/password, verification, and recovery strategy | Blocked | Product; Security; Architecture | `SPEC-AUTH-01`, `SPEC-AUTH-02`, `RC-PROV-01`; decision packet exists, auth threat/benchmark/race/UX evidence absent |
| [ADR-003](ADR-003-database-choice.md) | PostgreSQL as transactional source of truth | Blocked | Architecture; Data; Security; Operations | `SPEC-SEC-01`, `RC-PROV-01`, `BETA-LEGAL-01`; no RLS posture or pool/isolation/restore evidence |
| [ADR-004](ADR-004-session-management.md) | Opaque revocable server-side sessions | Blocked | Security; Product; Privacy/Legal; Architecture | `SPEC-AUTH-01`, `SPEC-AUTH-02`, `SPEC-SEC-02`; no selected values/event policy or rotation/CSRF/privacy/race evidence |
| [ADR-005](ADR-005-pwa-strategy.md) | Installable PWA with restricted caching | Proposed | Web/PWA; Security; UX/Accessibility | `SPEC-UX-01`, `SPEC-GOV-01`: browser/cache/install/update/security/accessibility evidence absent |
| [ADR-006](ADR-006-mobile-strategy.md) | Web-first with future Capacitor reuse | Proposed | Product; UX/Accessibility; Architecture; Security | `SPEC-UX-01`, `SPEC-GOV-01`: compact Web/PWA usability/accessibility/device evidence absent |
| [ADR-007](ADR-007-deployment-architecture.md) | Cloudflare + managed application + private managed PostgreSQL | Proposed | Architecture; Operations; Security; Privacy/Legal | `SPEC-DEL-01`, `SPEC-GOV-01`: restore-exclusion/owner/topology evidence absent; `RC-PROV-01` and `BETA-LEGAL-01` remain later gates |
| [ADR-008](ADR-008-notification-architecture.md) | PostgreSQL worker/outbox for in-app reminders and required security email | Blocked | Product; Architecture; Operations; QA | `SPEC-REM-01`; complete tuple unselected and worker/race/content/accessibility evidence absent |

## Coverage decision for financial and scheduling specifications

Round 3 does **not** create a cosmetic Accepted ADR for fixed product formulas. The authoritative current-balance/snapshot rules, safe-to-spend formula, and no-inference debt boundary are normative requirements and data invariants in PRD, Architecture, Database, and the test matrices. A new or amended ADR is required when blocker resolution selects an architectural mechanism; documentation does not pre-approve that choice.

| Blocker | ADR coverage required before closure |
|---|---|
| `SPEC-AUTH-01`, `SPEC-AUTH-02` | ADR-002 and ADR-004 must agree on one approved outcome/policy and link evidence |
| `SPEC-FIN-01` | Issue #1 proposes product/data policy `snapshot_correction.v1`; no ADR is required for its conservative record semantics unless review introduces a material architecture choice. Mandatory owner approval/evidence remains open. |
| `SPEC-FIN-02` | **Mandatory** new ADR or explicit amendment selecting the PostgreSQL serialization/linearization mechanism that enforces the specified one-winner/endpoint-specific stale-state contract, with concurrency evidence |
| `SPEC-DEBT-01` | Product/data specifications define no-inference behavior; amend/create an ADR only if replay/rebase architecture is selected |
| `SPEC-SCH-01` | Product/data specifications define recurrence semantics; amend ADR-008 or create an ADR only for a material worker/storage mechanism change |
| `SPEC-REM-01` | ADR-008 must record the complete approved catch-up tuple and evidence |
| `SPEC-SEC-01` | ADR-003 must record RLS or compensating-control posture, residual risk, exact scope, and evidence |
| `SPEC-SEC-02` | ADR-004 must record event visibility/disclosure implications; a dedicated ADR is required if event architecture materially changes |
| `SPEC-DEL-01` | ADR-007 amendment or dedicated lifecycle ADR must record restore-exclusion/provider/storage architecture selected by the approved deletion policy |
| `SPEC-UX-01` | ADR-005/006 remain Proposed until applicable responsive/PWA/mobile UX/accessibility evidence exists; evidence does not create a new product choice |
| `SPEC-GOV-01` | Every ADR uses the controlled named-approval/evidence record; no status may change on role labels alone |

Recurrence semantics remain in product/data specifications unless a material architecture mechanism is selected. This coverage statement prevents both an unrecorded architectural decision and unnecessary ADR duplication.

## Status lifecycle

- **Proposed:** A candidate choice is documented, but required review or validation evidence is absent; implementation must not depend on it as settled.
- **Blocked:** One or more named decisions are unresolved, so acceptance and dependent implementation are prohibited.
- **Accepted:** Reviewed and approved with date/approvers and required evidence.
- **Superseded:** Replaced by another ADR, with link.
- **Deprecated:** Still present but no longer recommended.
- **Rejected:** Considered and deliberately not chosen.

## ADR rules

1. An ADR records one important architectural choice and its consequences; it does not replace product/security requirements.
2. Acceptance requires resolution of linked blockers, synchronized implementation/test implications, named accountable and mandatory co-approver sign-off, and versioned evidence satisfying the blocker’s binary criteria.
3. A changed accepted decision creates a new ADR or explicit amendment; history is not silently rewritten.
4. Alternatives must be represented fairly.
5. Consequences include operational and migration costs, not only benefits.

## Review record template

When an ADR is accepted, append:

```text
Decision/blocker IDs:
Exact selected outcome and values:
Alternatives rejected and rationale:
Decision date/timezone:
Named accountable approver:
Named mandatory co-approvers:
Linked specification version/commit:
Evidence IDs, versions, results, and defect disposition:
Accepted residual risk and compensating controls, if any:
Implementation issue/epic (only after the Implementation Gate opens):
Review/expiry trigger:
Supersedes/change record:
```

All ADR statuses remain unchanged after Round 3: Proposed — ADR-001, ADR-005, ADR-006, ADR-007; Blocked — ADR-002, ADR-003, ADR-004, ADR-008; Accepted — none.
