# Milestone 02 transaction corrections — verification record

**Recorded:** 2026-10-08<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Local environment:** Arena workspace; Node.js `v22.22.3`; no PostgreSQL/Supabase credentials, binaries, or container runtime

This record separates tests actually executed locally from guarded PostgreSQL tests that require CI or another explicitly designated non-production target. It does not imply owner approval, FIN-RACE closure, Supabase behavior, production readiness, or release authorization.

## Commands actually executed locally

```text
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm run test:unit
corepack pnpm run check
git diff --check
```

## Observed local results

| Check | Observed result | Interpretation |
|---|---|---|
| Frozen install | Completed from the existing lockfile with pnpm `10.34.6` | Reproducible dependency resolution in this workspace |
| TypeScript application + tests | Completed successfully | Compile-time verification only |
| FIN-02 harness/static suite | `25` modules / `29` files checked; `16` tests passed | Frozen-baseline and harness validation only; not FIN-RACE evidence |
| Credential-free Vitest suite | `53` executed/passed, `0` failed | Domain, contract, API, migration-static, serializer-protocol, and correction unit checks |
| Guarded PostgreSQL suites in full local run | `9` skipped (`8` correction + `1` foundation), `0` executed | No explicitly designated PostgreSQL target was available; no local database PASS is claimed |
| Patch whitespace | `git diff --check` completed successfully | Patch-format check only |

## Automated correction coverage added

- Pure current-balance correction/void deltas and cross-segment date validation.
- Strict preview/commit contracts with mandatory bounded reason and reviewed context.
- Trusted-principal owner derivation for preview, correction, void, history, and reporting routes.
- Stable work-discovered correction-stale idempotency receipt without version/audit mutation.
- Guarded real-PostgreSQL scenarios for `FIN-COR-01..07`, `FIN-COR-09`, competing corrections, snapshot/correction race, idempotent replay/digest conflict, chain cardinality, monthly amended reporting, and two-user isolation.

## Status boundaries

- `FIN-COR-01..07` and `FIN-COR-09`: implemented with automated guarded PostgreSQL assertions; runtime status remains pending until that suite executes on a real target.
- `FIN-COR-08`: **NOT RUN — implementation prerequisite**.
- `FIN-COR-10`: correction/correction and snapshot/correction branches implemented with guarded PostgreSQL assertions; linked-domain race branch is **NOT RUN — implementation prerequisite**.
- `FIN-LINK-01..06`: **NOT RUN — implementation prerequisite**.
- `FIN-OCC-01..04`: **NOT RUN — implementation prerequisite**.
- `FIN-RACE-01..08`: remain OPEN/BLOCKED as the dedicated forced-order, repetition, cleanup, pool, and commit-fault matrix. A passing foundation/correction integration test is not a FIN-RACE substitute.

## CI status at this revision

The current workflow is configured to execute both guarded integration files against ephemeral synthetic PostgreSQL 17.6. Its result will be recorded only after an actual current-head run completes; the test definition itself is not execution evidence.

## Open items retained

Named approvals, proposed ADR acceptance, intended Supabase pool behavior, linked-domain schema/services and evidence, full FIN-RACE execution, RLS/runtime-role evidence, authentication/session delivery, UI/usability/accessibility evidence, security/legal/governance review, operations, and release gates remain **OPEN**.
