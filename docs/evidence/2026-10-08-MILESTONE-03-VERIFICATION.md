# Milestone 03 one-off schedule occurrences — verification record

**Recorded:** 2026-10-08<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Local environment:** Arena workspace; Node.js 22; no PostgreSQL/Supabase credentials, binaries, or container runtime<br>
**CI environment:** Pending first implementation push

This record separates checks actually executed locally from guarded PostgreSQL checks. It does not imply owner approval, FIN-RACE closure, Supabase behavior, production readiness, or release authorization.

## Commands actually executed locally

```text
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm run test:unit
corepack pnpm run test
```

## Observed local results

| Check | Observed result | Interpretation |
|---|---|---|
| Frozen install | Completed from the existing lockfile with pnpm `10.34.6` | Reproducible dependency resolution in this workspace |
| TypeScript application + tests | Completed successfully | Compile-time verification only |
| Credential-free Vitest suite | `74` executed/passed, `0` failed | Domain, contract, API, migration-static, serializer-protocol, and prior financial checks |
| Guarded PostgreSQL suites in full local run | `14` skipped (`5` schedule + `8` correction + `1` foundation), `0` executed | No configured PostgreSQL target; no local database PASS is claimed |

## Coverage added

- Strict one-off contracts that reject recurrence fields, owner injection, and persisted presentation aliases.
- Pure outgoing date-boundary and incoming/outgoing confirmation presentation mapping.
- Additive migration checks for exact state enum, composite owner/account/currency/direction constraints, explicit policy, immutable authority, and active transaction uniqueness.
- Trusted-principal API tests for creation, list/detail, confirmation, skip/cancel route registration, validation, and BOLA resistance.
- Guarded PostgreSQL scenarios for one-off creation/replay; non-mutating upcoming/due/overdue derivation; outgoing Paid and incoming Received presentation; atomic transaction/link confirmation; competing confirmation; terminal skip/cancel; owner isolation; linked standalone-void rejection; and correction pointer transfer.

## Current evidence status

| Area | Status |
|---|---|
| Credential-free implementation checks | **PASS — executed locally** |
| Real PostgreSQL schedule integration | **NOT RUN locally — target unavailable** |
| `FIN-OCC-01..04` implementation evidence | Unit/static PASS; PostgreSQL execution pending CI |
| Schedule-only `FIN-LINK-01` implementation evidence | PostgreSQL execution pending CI |
| Remaining `FIN-LINK-02..06` / debt / purchase shapes | **NOT RUN — implementation prerequisite** |
| Dedicated `FIN-RACE-01..08` and intended Supabase evidence | **OPEN/BLOCKED; not substituted by this suite** |

## Open items retained

Recurrence and series-edit decisions, reminders, debt, planned purchases, savings, safe-to-spend reporting, trusted session delivery, UI/usability/accessibility evidence, owner/co-approver acceptance, intended Supabase pool behavior, RLS/runtime-role evidence, full FIN-RACE execution, security/legal/governance review, operations, and release gates remain **OPEN**.
