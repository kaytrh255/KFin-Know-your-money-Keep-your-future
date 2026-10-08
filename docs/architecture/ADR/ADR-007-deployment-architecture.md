# ADR-007 — Deployment Architecture

**Status:** Proposed<br>
**Date:** 2026-10-07<br>
**Decision owners:** Architecture Owner; Operations Owner; Security Owner; Privacy/Legal Owner<br>
**Exact blocker:** The vendor-neutral topology/provider-deferral direction is accepted by OQ-09/OQ-17, but `SPEC-GOV-01` lacks the required logical-architecture spike and named owner/cost/RPO/RTO evidence. `SPEC-DEL-01` also leaves restore-exclusion storage/key/access/expiry, provider purge proof, and restore-activation behavior unapproved. `RC-PROV-01` and `BETA-LEGAL-01` separately block provider-specific Release Candidate and beta approval; no deployed readiness is claimed.<br>
**Related:** [Architecture specification](../ARCHITECTURE.md), OQ-09, OQ-10, OQ-16, OQ-17, OQ-18

## Context

KFin needs production TLS, DDoS/WAF/rate controls, a Web/PWA origin, API and background work, private PostgreSQL, backups, monitoring, health checks, isolated environments, and rollback. Initial demand is small and does not justify Kubernetes or a custom platform team. Product review selected a managed PaaS topology and Vietnam-first/Southeast-Asia preference, while deliberately deferring specific provider, final region, domain, and budget until before Release Candidate.

## Decision

Use this vendor-neutral topology:

```text
Cloudflare edge
  → one KFin origin
    → versioned static Web/PWA assets
    → /api to a managed container/application runtime
    → worker/scheduler from the same immutable image
      → private managed PostgreSQL
      → protected restore-exclusion register outside the application restore domain
    → approved email and observability providers
```

Deployment requirements:

- Cloudflare manages public DNS/TLS, DDoS protection, WAF baseline, coarse IP/network rate limits, and origin shielding. Application controls remain required.
- Web and API are browser-visible under the same site/origin.
- API and worker run from one immutable OCI image/release; configuration selects the process.
- Managed PostgreSQL is reachable only through private/restricted network paths, uses TLS, encryption at rest, automated backups, and provider-supported PITR where approved.
- The deletion restore-exclusion register uses a separately protected access/restore boundary so restoring an older application/database point cannot roll back the current tombstones with it; storage/key/expiry are selected with the provider addendum and deletion design. This is a minimal recovery-control record, not a new microservice.
- Local/test, staging, and production have separate configuration, credentials, databases, email modes, and telemetry labels. Production data never populates lower environments.
- GitHub Actions runs required checks, builds once, signs/identifies the artifact, and promotes that same artifact through staging to production with approval.
- Secrets use managed secret storage and workload identities/least-privilege credentials; none are in Git, image layers, frontend bundles, or CI logs.
- Schema migration is gated and uses expand/migrate/contract compatibility when rollback could otherwise fail.
- Health/readiness checks and smoke tests gate rollout. Rollback selects the prior compatible artifact; data rollback/forward recovery is separately rehearsed.
- Proposed beta targets are RPO ≤ 24 hours and RTO ≤ 8 hours, subject to business approval and provider capability.
- Backups have a 90-day maximum baseline, application logs 90 days, and minimized security/audit evidence 24 months, subject to legal reduction.
- Prefer a Southeast Asia region, but complete Vietnamese cross-border/data-residency review before beta.

Under accepted OQ-17, specific compute/database/email/observability vendors, domain, final region, and budget are deferred until before Release Candidate. This ADR can approve the logical topology only; it cannot evidence production readiness before a provider addendum and deployed validation.

### Round 3 data-lifecycle architecture boundary

`SPEC-DEL-01` remains **OPEN — decision ready**. Privacy/Legal, Product, Security, and Operations owners must approve the full deletion policy before Architecture records its implementation mechanism. Any ADR-007 amendment or dedicated lifecycle ADR must then specify:

- the restore-exclusion register’s trust/restore boundary, subject digest, storage, key rotation, least-privilege access, replication, expiry, availability and audit;
- the activation gate that obtains the current register and re-deletes restored data before any account becomes active;
- first-party/provider purge orchestration, retry, proof, escalation and legal-hold interaction;
- retained minimum evidence and its lawful purpose/expiry without reusable authentication secrets;
- restore drill and provider evidence linked to the approved deletion map.

Round 3 does not select a provider, storage service, key system, legal basis, retained field, or legal-hold policy. The seven-day cancellation and no-restored-account-reactivation boundaries remain fixed.

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
- Deferring vendor selection creates accepted late risk around networking, residency, backup/PITR, IAM, email deliverability, observability, cost, and deployment behavior.

### Required controls

- Origin accepts only approved proxy paths where feasible and validates forwarded client information from trusted proxies only.
- Never edge-cache authenticated/API responses.
- Provider IAM/MFA, audit logs, least privilege, access reviews, and break-glass procedure.
- Backup failure alerts and restore drills.
- Infrastructure configuration review and drift/change record.
- Vendor status/incident response and data-processing terms.
- Cost/storage/egress alerts.

## Validation before logical-architecture acceptance

- Confirm explicit acceptance of OQ-17’s provider deferral and its Release Candidate deadline.
- Validate locally/ephemerally that one immutable image can run API/worker, same-origin routing works, and standard PostgreSQL/provider adapters remain portable.
- Record provisional cost, RPO/RTO, residency, and operational-owner assumptions.
- Obtain the approved `SPEC-DEL-01` policy and validate the vendor-neutral restore-exclusion/activation boundary without claiming a provider-specific design.
- Record named approvers, source versions, evidence results and review trigger in the governance register.

## Additional Release Candidate gate

- Select provider, final region, budget, domain, and owners in a dated ADR addendum.
- Complete Vietnamese legal/residency review and provider responsibility/subprocessor register.
- Deploy production-like staging; test TLS, origin restriction, WAF/rate control, cookies/CSRF, no-store caching, health checks, email, logs, secrets, and retention automation.
- Perform migration, rollback, backup restore with the current independently protected deletion-tombstone register, credential rotation, and application outage exercises.
- Validate RPO/RTO against measured restore/redeploy time.

## Revisit when

- measured availability/capacity requires multiple replicas or regions;
- residency/regulation changes;
- provider cost/reliability breaches agreed thresholds;
- the team gains a justified platform requirement.
