# KFin Architecture Decision Records

All records are currently **Proposed**. They describe recommendations for review; none authorizes implementation while the specification gate is closed.

| ADR | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-application-architecture.md) | Modular monolith and TypeScript monorepo | Proposed |
| [ADR-002](ADR-002-authentication-strategy.md) | Invitation-gated email/password, verification, and recovery strategy | Proposed |
| [ADR-003](ADR-003-database-choice.md) | PostgreSQL as the transactional source of truth | Proposed |
| [ADR-004](ADR-004-session-management.md) | Opaque revocable server-side sessions | Proposed |
| [ADR-005](ADR-005-pwa-strategy.md) | Installable PWA with restricted caching | Proposed |
| [ADR-006](ADR-006-mobile-strategy.md) | Web-first with future Capacitor reuse | Proposed |
| [ADR-007](ADR-007-deployment-architecture.md) | Cloudflare + managed application + private managed PostgreSQL | Proposed |
| [ADR-008](ADR-008-notification-architecture.md) | PostgreSQL worker/outbox for in-app reminders and required security email | Proposed |

## Status lifecycle

- **Proposed:** Written for discussion; implementation must not depend on it as settled.
- **Accepted:** Reviewed and approved with date/approvers.
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
