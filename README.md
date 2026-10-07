# KFin — Know your money, Keep your future

KFin is a production-oriented personal finance management platform being designed for an initial Private Beta of at most 50 real users.

## Current phase

**Specification foundation — implementation has not started.**

The current repository intentionally contains product, UX, architecture, security, database, and testing specifications only. Documents remain drafts pending owner approval/evidence; the Round 1 ADR audit records Proposed or Blocked status and zero Accepted ADRs.

Start with the [KFin Specification Foundation](docs/README.md).

## Specification areas

- [Product](docs/product/PRD.md)
- [MVP scope](docs/product/MVP-SCOPE.md)
- [Product decision log](docs/product/DECISION-LOG.md)
- [UX](docs/ux/UX-SPEC.md)
- [UI design system](docs/ux/UI-DESIGN-SYSTEM.md)
- [Architecture](docs/architecture/ARCHITECTURE.md)
- [Database](docs/architecture/DATABASE.md)
- [Architecture decisions](docs/architecture/ADR/README.md)
- [Security requirements](docs/security/SECURITY-REQUIREMENTS.md)
- [Threat model](docs/security/THREAT-MODEL.md)
- [Test strategy](docs/testing/TEST-STRATEGY.md)
- [Release checklist](docs/testing/RELEASE-CHECKLIST.md)

## Implementation gate

**CLOSED**

Do not implement application functionality until:

1. accepted product decisions in the [decision log](docs/product/DECISION-LOG.md) are reflected consistently across specifications;
2. product/UX/security/architecture/database/test specifications are reviewed and approved;
3. every required Proposed/Blocked ADR is genuinely Accepted with owner approval and evidence;
4. every pre-implementation `SPEC-*` blocker in the centralized register is resolved; Release Candidate and beta gates remain enforceable at their stated phases;
5. implementation work is traceable to requirements, flows, invariants, and tests.

The priority is: **correct product → excellent UX → secure architecture → maintainable implementation → reliable production system**.
