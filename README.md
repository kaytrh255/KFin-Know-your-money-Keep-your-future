# KFin — Know your money, Keep your future

KFin is a production-oriented personal finance management platform being designed for an initial Private Beta of at most 50 real users.

## Current phase

**Specification foundation — implementation has not started.**

The current repository intentionally contains product, UX, architecture, security, database, governance, review, and testing specifications only. Documents remain drafts pending authorized owner decisions and evidence. Round 3 makes all pre-implementation blocker packets decision-ready, but every `SPEC-*` blocker remains OPEN; the ADR register still records Proposed or Blocked status and zero Accepted ADRs.

Start with the [KFin Specification Foundation](docs/README.md), then review the [Round 3 remediation report](docs/reviews/SPECIFICATION-REMEDIATION-ROUND-3.md) and [Approval and Evidence Register](docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md).

## Specification areas

- [Product](docs/product/PRD.md)
- [MVP scope](docs/product/MVP-SCOPE.md)
- [Product decision log](docs/product/DECISION-LOG.md)
- [SPEC-FIN-01 snapshot correction proposal](docs/product/SPEC-FIN-01-SNAPSHOT-CORRECTION.md)
- [UX](docs/ux/UX-SPEC.md)
- [UI design system](docs/ux/UI-DESIGN-SYSTEM.md)
- [Architecture](docs/architecture/ARCHITECTURE.md)
- [Database](docs/architecture/DATABASE.md)
- [Architecture decisions](docs/architecture/ADR/README.md)
- [Security requirements](docs/security/SECURITY-REQUIREMENTS.md)
- [Threat model](docs/security/THREAT-MODEL.md)
- [Test strategy](docs/testing/TEST-STRATEGY.md)
- [Release checklist](docs/testing/RELEASE-CHECKLIST.md)
- [Governance approval and evidence register](docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md)
- [Specification Remediation Round 3 report](docs/reviews/SPECIFICATION-REMEDIATION-ROUND-3.md)

## Implementation gate

**CLOSED**

Do not implement application functionality until:

1. accepted product decisions in the [decision log](docs/product/DECISION-LOG.md) are reflected consistently across specifications;
2. product/UX/security/architecture/database/test specifications are reviewed and approved;
3. every required Proposed/Blocked ADR is genuinely Accepted with named accountable/co-approver approval and versioned evidence;
4. every pre-implementation `SPEC-*` blocker in the centralized register is resolved against its Round 3 acceptance criteria—not merely documented; Release Candidate and beta gates remain enforceable at their stated phases;
5. the governance register contains named role assignments, approved physical limits, evidence records, and specification/ADR sign-offs;
6. implementation work is traceable to requirements, flows, invariants, and tests.

The priority is: **correct product → excellent UX → secure architecture → maintainable implementation → reliable production system**.
