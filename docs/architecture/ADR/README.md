# KFin Architecture Decision Records

Round 1 review found **zero Accepted ADRs**. Product decisions embedded within an ADR may already be fixed—for example mandatory invitation codes, managed PostgreSQL topology, and Web/PWA direction—but the complete ADR is not Accepted until every decision and stated validation condition has evidence. None authorizes implementation while the specification gate is closed.

| ADR | Decision | Status | Decision-owner roles | Exact acceptance blocker |
|---|---|---|---|---|
| [ADR-001](ADR-001-application-architecture.md) | Modular monolith and TypeScript monorepo | Proposed | Architecture; Engineering; Security; Operations | `SPEC-GOV-01`: architecture/spike evidence absent; Fastify/Vite remains proposed |
| [ADR-002](ADR-002-authentication-strategy.md) | Mandatory invitation-code email/password, verification, and recovery strategy | Blocked | Product; Security; Architecture | `SPEC-AUTH-01`, `SPEC-AUTH-02`, `RC-PROV-01`; auth validation evidence absent |
| [ADR-003](ADR-003-database-choice.md) | PostgreSQL as transactional source of truth | Blocked | Architecture; Data; Security; Operations | `SPEC-SEC-01`, `RC-PROV-01`, `BETA-LEGAL-01`; data/restore evidence absent |
| [ADR-004](ADR-004-session-management.md) | Opaque revocable server-side sessions | Blocked | Security; Product; Architecture | `SPEC-AUTH-01`, `SPEC-AUTH-02`, `SPEC-SEC-02`; rotation/CSRF/cookie/race evidence absent |
| [ADR-005](ADR-005-pwa-strategy.md) | Installable PWA with restricted caching | Proposed | Web/PWA; Security; UX/Accessibility | `SPEC-GOV-01`: browser/cache/install/update/security validation absent |
| [ADR-006](ADR-006-mobile-strategy.md) | Web-first with future Capacitor reuse | Proposed | Product; UX/Accessibility; Architecture; Security | `SPEC-GOV-01`: compact Web/PWA usability/accessibility/device evidence absent |
| [ADR-007](ADR-007-deployment-architecture.md) | Cloudflare + managed application + private managed PostgreSQL | Proposed | Architecture; Operations; Security; Privacy/Legal | `SPEC-GOV-01`: logical spike/owner/target evidence absent; `RC-PROV-01` and `BETA-LEGAL-01` remain later gates |
| [ADR-008](ADR-008-notification-architecture.md) | PostgreSQL worker/outbox for in-app reminders and required security email | Blocked | Product; Architecture; Operations; QA | `SPEC-REM-01`; worker/race/content/accessibility evidence absent |

## Coverage decision for financial and scheduling specifications

Round 1 does **not** create a cosmetic Accepted ADR for fixed product formulas. The authoritative current-balance/snapshot rules, safe-to-spend formula, and no-inference debt boundary are normative requirements and data invariants in PRD, Architecture, Database, and the test matrices. `SPEC-FIN-01`, `SPEC-FIN-02`, and `SPEC-DEBT-01` explicitly block the remaining cross-segment, concurrency, and historical-correction choices. A new or amended ADR is required if resolving any blocker introduces an architectural choice; documentation does not pre-approve that choice.

Recurrence semantics remain in product/data specifications under `SPEC-SCH-01`; reminder delivery and catch-up architecture are covered by Blocked ADR-008 under `SPEC-REM-01`. This coverage statement prevents both an unrecorded architectural decision and unnecessary ADR duplication.

## Status lifecycle

- **Proposed:** A candidate choice is documented, but required review or validation evidence is absent; implementation must not depend on it as settled.
- **Blocked:** One or more named decisions are unresolved, so acceptance and dependent implementation are prohibited.
- **Accepted:** Reviewed and approved with date/approvers and required evidence.
- **Superseded:** Replaced by another ADR, with link.
- **Deprecated:** Still present but no longer recommended.
- **Rejected:** Considered and deliberately not chosen.

## ADR rules

1. An ADR records one important architectural choice and its consequences; it does not replace product/security requirements.
2. Acceptance requires resolution of linked open questions, implementation/test implications, and owner sign-off.
3. A changed accepted decision creates a new ADR or explicit amendment; history is not silently rewritten.
4. Alternatives must be represented fairly.
5. Consequences include operational and migration costs, not only benefits.

## Review record template

When an ADR is accepted, append:

```text
Decision date:
Approvers:
Linked specification version:
Implementation issue/epic:
Review/expiry trigger:
```
