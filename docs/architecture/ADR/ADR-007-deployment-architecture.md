# ADR-007 — Deployment Architecture

**Status:** Proposed<br>
**Date:** 2026-10-07<br>
**Decision owners:** Unassigned<br>
**Related:** [Architecture specification](../ARCHITECTURE.md), OQ-01, OQ-09, OQ-10

## Context

KFin needs production TLS, DDoS/WAF/rate controls, a Web/PWA origin, API and background work, private PostgreSQL, backups, monitoring, health checks, isolated environments, and rollback. Initial demand is small and does not justify Kubernetes or a custom platform team. Provider, region, domain, budget, data residency, and operational ownership are unresolved.

## Decision

Use this vendor-neutral topology:

```text
Cloudflare edge
  → one KFin origin
    → versioned static Web/PWA assets
    → /api to a managed container/application runtime
    → worker/scheduler from the same immutable image
      → private managed PostgreSQL
    → approved email and observability providers
```

Deployment requirements:

- Cloudflare manages public DNS/TLS, DDoS protection, WAF baseline, coarse IP/network rate limits, and origin shielding. Application controls remain required.
- Web and API are browser-visible under the same site/origin.
- API and worker run from one immutable OCI image/release; configuration selects the process.
- Managed PostgreSQL is reachable only through private/restricted network paths, uses TLS, encryption at rest, automated backups, and provider-supported PITR where approved.
- Local/test, staging, and production have separate configuration, credentials, databases, email modes, and telemetry labels. Production data never populates lower environments.
- GitHub Actions runs required checks, builds once, signs/identifies the artifact, and promotes that same artifact through staging to production with approval.
- Secrets use managed secret storage and workload identities/least-privilege credentials; none are in Git, image layers, frontend bundles, or CI logs.
- Schema migration is gated and uses expand/migrate/contract compatibility when rollback could otherwise fail.
- Health/readiness checks and smoke tests gate rollout. Rollback selects the prior compatible artifact; data rollback/forward recovery is separately rehearsed.
- Proposed beta targets are RPO ≤ 24 hours and RTO ≤ 8 hours, subject to business approval and provider capability.

The specific compute/database/email/monitoring vendor and region cannot be accepted before OQ-01/OQ-09 are resolved.

## Alternatives considered

### Single unmanaged VPS with local PostgreSQL

**Benefits:** low cost and direct control.<br>
**Rejected as default:** patching, backup/PITR, database isolation, failover, secret/monitoring setup, and operator bus factor create avoidable beta risk. It is viable only with demonstrated operations capability and equivalent controls.

### Kubernetes

**Benefits:** portability, orchestration, scaling ecosystem.<br>
**Rejected:** substantial complexity and attack/operations surface without workload need.

### Fully serverless edge/functions and serverless database

**Benefits:** low idle cost and automatic scale.<br>
**Not selected by default:** runtime limits, database connections/transactions, job scheduling, regional behavior, observability, and pricing unpredictability need proof. A provider matching all constraints could still implement the logical topology after an ADR amendment.

### Major-cloud bespoke stack

**Benefits:** rich managed security/operations services.<br>
**Not selected yet:** may be appropriate, but vendor and team expertise/budget are unknown. Avoid assembling many services before requirements demand them.

### Direct application origin without Cloudflare

**Benefits:** fewer hops/provider dependencies.<br>
**Rejected under current product direction:** loses the specified edge protection layer; could be reconsidered only if chosen host provides equivalent controls and a new decision is approved.

## Reasoning

- Managed runtime/database reduce operational load for a small beta.
- Cloudflare satisfies the preferred edge concept.
- Standard containers/PostgreSQL preserve reasonable portability.
- Same-origin delivery simplifies secure cookies/CORS/CSRF and client configuration.
- One image keeps API/worker release compatibility visible.

## Consequences

### Positive

- Small number of production components.
- Clear isolation and recovery responsibilities.
- Reproducible releases and straightforward vertical scaling.
- Edge protection without modifying domain architecture.

### Negative / risks

- Several external providers are dependencies and subprocessors.
- Misconfigured Cloudflare caching/origin access could expose data or bypass controls.
- Single-region application/database may have an outage within accepted RTO.
- Managed egress/backup/log cost can surprise.
- Database migrations constrain instant rollback.

### Required controls

- Origin accepts only approved proxy paths where feasible and validates forwarded client information from trusted proxies only.
- Never edge-cache authenticated/API responses.
- Provider IAM/MFA, audit logs, least privilege, access reviews, and break-glass procedure.
- Backup failure alerts and restore drills.
- Infrastructure configuration review and drift/change record.
- Vendor status/incident response and data-processing terms.
- Cost/storage/egress alerts.

## Validation before acceptance

- Resolve jurisdiction/residency, provider, region, budget, domain, and owners.
- Document provider responsibility matrix and subprocessor list.
- Deploy staging; test TLS, origin restriction, WAF/rate control, cookies/CSRF, no-store caching, health checks, email, logs, and secrets.
- Perform migration, rollback, backup restore, credential rotation, and application outage exercises.
- Validate RPO/RTO against measured restore/redeploy time.

## Revisit when

- measured availability/capacity requires multiple replicas or regions;
- residency/regulation changes;
- provider cost/reliability breaches agreed thresholds;
- the team gains a justified platform requirement.
