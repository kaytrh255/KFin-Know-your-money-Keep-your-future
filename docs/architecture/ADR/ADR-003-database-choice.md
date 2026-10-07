# ADR-003 — Database Choice

**Status:** Proposed<br>
**Date:** 2026-10-07<br>
**Decision owners:** Unassigned<br>
**Related:** [Database specification](../DATABASE.md)

## Context

KFin needs exact financial records, ownership relationships, atomic multi-entity writes, schedule/reminder queries, persistent sessions, audit history, idempotency, reliable backups, and restoration. Initial scale is at most 50 users, so operational simplicity is more important than distributed throughput.

## Decision

Use a single **managed PostgreSQL** database as the transactional source of truth for identity/session metadata, financial domain data, reminder/outbox jobs, and audit/security records.

- Use normalized relational tables and constraints for core domain concepts.
- Use integer minor units for money and explicit ISO currency.
- Use transactions for linked financial/auth changes.
- Use JSONB only for bounded versioned metadata/job payloads where relational columns are not appropriate; never use it to avoid core constraints.
- Use a typed query/ORM layer while retaining reviewed SQL migrations and direct access to constraints/indexes/query plans.
- Keep the database on a private/restricted network with TLS, least-privilege runtime/migration/operator roles, encrypted managed storage/backups, and restoration testing.
- Use PostgreSQL-backed outbox/job claiming at beta scale rather than Redis or a broker.
- Evaluate Row Level Security as required defense in depth before final acceptance; application authorization remains mandatory either way.

## Alternatives considered

### SQLite

**Benefits:** extremely simple local deployment and testing.<br>
**Rejected for production:** concurrency, managed backup/PITR, networked deployment, operational tooling, and production multi-process use are poorer fits. It may be used only in isolated tooling if behavior is not substituted for PostgreSQL tests.

### MySQL/MariaDB

**Benefits:** mature relational systems and managed offerings.<br>
**Not selected:** PostgreSQL’s constraints, transactional behavior, indexing, RLS option, JSON support, and team/tool fit are preferred. MySQL could satisfy many requirements but offers no compelling advantage here.

### Document database

**Benefits:** flexible documents and fast schema iteration.<br>
**Rejected:** KFin has strong relationships, invariants, aggregations, and atomic cross-record actions. Flexibility would shift integrity into application code.

### Event-sourced ledger/CQRS

**Benefits:** full history and projections.<br>
**Rejected now:** conceptual/operational complexity exceeds requirements. Explicit posted/voided records and audit events provide sufficient traceability for MVP.

### Separate databases per module/user

**Benefits:** stronger isolation in theory.<br>
**Rejected now:** migrations, backups, reporting, transactions, pooling, and operation are unnecessarily complex for 50 users.

## Reasoning

- PostgreSQL is well suited to relational financial integrity and atomic operations.
- Managed service reduces backup/patching burden while retaining standard portability.
- One database aligns with the modular monolith and enables transactional outbox.
- Established indexing/query-plan tools support transparent optimization.

## Consequences

### Positive

- Strong constraints and transactions.
- Straightforward reconciliation and monthly aggregation.
- Mature backup/PITR ecosystem.
- Can support sessions and a small durable job queue without extra infrastructure.

### Negative / risks

- Database is a central dependency/failure domain.
- Job polling and rate counters can contend with domain workload if poorly designed.
- RLS and pooled request context add complexity if adopted.
- PostgreSQL-specific SQL and migration practices create some vendor coupling.
- Managed provider selection affects residency, cost, extensions, and recovery capability.

### Required controls

- Connection and statement limits; indexed bounded queries.
- Separate runtime/migration roles and restricted operator access.
- Migration rehearsal, automated backup, regular restore evidence.
- Slow-query/connection/storage monitoring.
- No public unrestricted endpoint.
- Cross-user authorization and database-policy tests.

## Validation before acceptance

- Before Release Candidate, select provider/region/version under OQ-16/OQ-17 and validate the accepted 90-day backup maximum.
- Validate ORM/query tool transaction and `BIGINT` behavior.
- Prototype composite tenant constraints and RLS with connection pooling.
- Load representative dashboard/schedule data and inspect plans.
- Complete a backup/restore rehearsal in a production-like environment before beta.

## Revisit when

- measured workload exceeds a single managed instance;
- retention/reporting needs justify a read replica or separate analytical store;
- job load harms transactional performance;
- legal residency requires a changed topology.
