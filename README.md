# KFin — Know your money, Keep your future

KFin is a production-oriented personal finance management platform being designed for an initial Private Beta of at most 50 real users.

## Current phase

**Specification foundation — implementation has not started.**

The current repository intentionally contains product, UX, architecture, security, database, and testing specifications only. All documents are drafts pending review; proposed architecture decisions are not yet accepted.

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

Do not implement application functionality until:

1. accepted product decisions in the [decision log](docs/product/DECISION-LOG.md) are reflected consistently across specifications;
2. product/UX/security/architecture/database/test specifications are reviewed and approved;
3. relevant proposed ADRs are accepted;
4. implementation work is traceable to requirements and tests.

The priority is: **correct product → excellent UX → secure architecture → maintainable implementation → reliable production system**.
