# Milestone 03 one-off schedule occurrences — verification record

**Recorded:** 2026-10-08<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Local environment:** Arena workspace; Node.js 22; no PostgreSQL/Supabase credentials, binaries, or container runtime<br>
**CI environment:** GitHub Actions `ubuntu-latest`; Node.js `22.22.0`; ephemeral synthetic `postgres:17.6-alpine`

This record separates checks actually executed locally from guarded PostgreSQL checks. It does not imply owner approval, FIN-RACE closure, Supabase behavior, production readiness, or release authorization.

## Commands actually executed locally

```text
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm run test:unit
corepack pnpm run test
corepack pnpm run check
git diff --check
```

## Observed local results

| Check | Observed result | Interpretation |
|---|---|---|
| Frozen install | Completed from the existing lockfile with pnpm `10.34.6` | Reproducible dependency resolution in this workspace |
| TypeScript application + tests | Completed successfully | Compile-time verification only |
| FIN-02 harness/static suite | `25` modules / `29` files checked; `16` tests passed | Frozen-baseline/harness validation only; not FIN-RACE evidence |
| Credential-free Vitest suite | `74` executed/passed, `0` failed | Domain, contract, API, migration-static, serializer-protocol, and prior financial checks |
| Guarded PostgreSQL suites in full local run | `14` skipped (`5` schedule + `8` correction + `1` foundation), `0` executed | No configured PostgreSQL target; no local database PASS is claimed |
| Patch whitespace | `git diff --check` completed successfully | Patch-format check only |

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
| Real PostgreSQL schedule integration | **PASS in CI run `37765521826`; NOT RUN locally — target unavailable** |
| `FIN-OCC-01..04` implementation evidence | Unit/static PASS locally; implemented PostgreSQL branches PASS in CI |
| Schedule-only `FIN-LINK-01` implementation evidence | Linked correction transfer and standalone-void rejection PASS in CI |
| Remaining `FIN-LINK-02..06` / debt / purchase shapes | **NOT RUN — implementation prerequisite** |
| Dedicated `FIN-RACE-01..08` and intended Supabase evidence | **OPEN/BLOCKED; not substituted by this suite** |

## GitHub Actions execution history

| Run | Head | Observed result | Disposition |
|---|---|---|---|
| [`37765370060`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37765370060) | `8142d9130b9fc674c29ccfbbb95d291188ea4a6b` | **FAILURE** in three schedule confirmation scenarios; harness, typecheck, and all `74` credential-free tests passed | The fixed integration clock was one day before the actual transaction dates, so domain validation correctly rejected future-dated posting. No PostgreSQL schedule PASS was claimed. The synthetic fixture clock was aligned with the reviewed occurrence date. |
| [`37765521826`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37765521826) | `a394a0586a8aa36caad33c3b922be44170f159fd` | **SUCCESS**; install, frozen-baseline harness, typecheck, `74` credential-free tests, the foundation test, all `8` correction tests, and all `5` schedule integration tests completed | Synthetic PostgreSQL 17.6 implementation evidence for this bounded one-off/explicit-confirmation slice and regression coverage for prior milestones. |

The successful run is narrow implementation evidence. It does not execute recurrence/reminder/debt/purchase services, the complete cross-domain claim matrix, the dedicated forced-order/fault-injected FIN-RACE suite, intended Supabase pooling, or production behavior.

## Open items retained

Recurrence and series-edit decisions, reminders, debt, planned purchases, savings, safe-to-spend reporting, trusted session delivery, UI/usability/accessibility evidence, owner/co-approver acceptance, intended Supabase pool behavior, RLS/runtime-role evidence, full FIN-RACE execution, security/legal/governance review, operations, and release gates remain **OPEN**.
