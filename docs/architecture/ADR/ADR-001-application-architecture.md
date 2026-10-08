# ADR-001 — Application Architecture

**Status:** Proposed<br>
**Date:** 2026-10-07<br>
**Decision owners:** Architecture Owner; Engineering Lead; Security Owner; Operations Owner<br>
**Exact blocker:** `SPEC-GOV-01` — no reviewed vertical-spike evidence yet proves same-origin routing, cookie/CSRF behavior, atomic domain write + outbox + worker claim, build/deploy ergonomics, and enforceable module boundaries; the Fastify/Vite choice therefore remains a proposal.<br>
**Related:** [Architecture specification](../ARCHITECTURE.md)

## Context

KFin must serve at most 50 initial users while handling sensitive financial information and retaining clear future module boundaries. It needs one responsive Web/PWA product, an API, scheduled work, PostgreSQL, reliable testing, and low operational burden. The product explicitly rejects premature microservices and distributed infrastructure.

The architecture must still keep authentication/invitations, users/deletion, aggregate-account balance snapshots and transactions, schedules, debt, savings, planned purchases, notifications, audit/security, and reporting conceptually separate.

## Decision

Use a **modular monolith** in a TypeScript monorepo:

- one React/Vite Web/PWA client;
- one Fastify API application composed from explicit feature modules;
- one optional worker process/command from the same repository, image, domain modules, and database;
- one PostgreSQL database;
- shared typed boundary schemas and one reusable UI/design-system package;
- same-origin browser delivery (`/api` behind the KFin origin).

Module code must expose application services/contracts and own its persistence access. Cross-module actions use in-process interfaces and shared database transactions, not network calls or direct ad hoc mutation of another module’s tables.

The worker is a deployment process, not an independently owned service. It may be colocated initially if the provider safely supports scheduled/background execution.

## Alternatives considered

### Microservices by domain

**Benefits:** independent deployment/scaling, stronger runtime boundaries.<br>
**Rejected now because:** operational, network, consistency, test, observability, and deployment complexity has no evidence at 50 users. Financial cross-module transactions would become harder.

### Full-stack Next.js application

**Benefits:** one framework/deployment, server rendering, broad ecosystem.<br>
**Not selected in this proposal because:** KFin is predominantly an authenticated application with no SEO requirement; an explicit static client/API boundary is easier to reuse in a later Capacitor shell and makes same contract available to other clients. This alternative remains viable if an implementation spike demonstrates lower total complexity without compromising PWA/mobile strategy.

### Separate React frontend plus NestJS API

**Benefits:** strong prescribed modules/dependency injection.<br>
**Not selected because:** the framework surface and conventions appear heavier than required; Fastify with enforced module boundaries should satisfy the small team/product. Reconsider if team expertise strongly favors NestJS.

### Serverless function per endpoint

**Benefits:** managed scaling and deployment.<br>
**Rejected now because:** fragmented composition, cold/start/runtime limits, database connection behavior, background jobs, and local transaction boundaries can add complexity with no beta need.

## Reasoning

- A modular monolith keeps financial operations transactionally coherent.
- One language lowers contract and staffing friction.
- A distinct client/API boundary supports the requested Web → PWA → future Capacitor direction.
- One database and release unit are easy to back up, monitor, and roll back.
- Module ownership creates an extraction seam only if future evidence requires it.

## Consequences

### Positive

- Low deployment and operational overhead.
- Straightforward local and integration testing.
- Atomic operations across schedule, transaction, debt, purchase, and outbox data.
- No distributed tracing/eventual consistency requirement for core paths.
- Shared web application can be packaged later.

### Negative / risks

- Module boundaries rely on engineering discipline and architecture tests.
- One API release can affect all capabilities.
- One database is a shared failure and contention boundary.
- Vite SPA + API requires deliberate same-origin routing and no-store policies.
- Worker and API schema compatibility must be managed during rolling releases.

### Required controls

- Dependency-boundary lint/architecture tests.
- Per-module service/repository interfaces.
- Backward-compatible schema/release procedure.
- API/worker health and database pool monitoring.
- No module-specific deployment without a new ADR.

## Validation before acceptance

- Thin vertical spike: Web → same-origin API → PostgreSQL in staging.
- Demonstrate secure cookie/CSRF behavior and preview/production routing.
- Demonstrate one atomic domain write + outbox + worker claim.
- Measure build/deploy/startup and test ergonomics.
- Confirm team can enforce module imports and transactions.

## Revisit when

- A module requires materially different scaling, compliance, availability, or deployment ownership;
- release coupling becomes a measured delivery problem;
- database contention cannot be resolved with ordinary indexing/query design;
- a second client makes the chosen boundary demonstrably unsuitable.
