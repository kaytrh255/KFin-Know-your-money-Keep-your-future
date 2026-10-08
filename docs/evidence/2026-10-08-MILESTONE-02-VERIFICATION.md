# Milestone 02 transaction corrections — verification record

**Recorded:** 2026-10-08<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Local environment:** Arena workspace; Node.js `v22.22.3`; no PostgreSQL/Supabase credentials, binaries, or container runtime<br>
**CI environment:** GitHub Actions `ubuntu-latest`; Node.js `22.22.0`; ephemeral synthetic `postgres:17.6-alpine`

This record separates tests actually executed locally from the guarded PostgreSQL tests executed in CI. It does not imply owner approval, FIN-RACE closure, Supabase behavior, production readiness, or release authorization.

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

- `FIN-COR-01..07` and `FIN-COR-09`: implemented and executed successfully against ephemeral PostgreSQL 17.6 in CI run `37758123849`.
- `FIN-COR-08`: **NOT RUN — implementation prerequisite**.
- `FIN-COR-10`: correction/correction and snapshot/correction branches executed successfully against PostgreSQL 17.6; linked-domain race branch is **NOT RUN — implementation prerequisite**.
- `FIN-LINK-01..06`: **NOT RUN — implementation prerequisite**.
- `FIN-OCC-01..04`: **NOT RUN — implementation prerequisite**.
- `FIN-RACE-01..08`: remain OPEN/BLOCKED as the dedicated forced-order, repetition, cleanup, pool, and commit-fault matrix. A passing foundation/correction integration test is not a FIN-RACE substitute.

## GitHub Actions execution history

| Run | Head | Observed result | Disposition |
|---|---|---|---|
| [`37757992207`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37757992207) | `3dbafb198293777bf3c0f9ee7c0cf7ebd34f1512` | **FAILURE** in all eight correction integration cases before their database actions; harness, typecheck, and `53` credential-free tests passed | The deterministic financial clock had not been injected into user/bootstrap fixture validation, so the fixed verification timestamp was compared with the runner clock. No correction PASS was claimed. The fixture was corrected to inject one clock through user, bootstrap, and financial services. |
| [`37758123849`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37758123849) | `2636b7242fec07cc041396b54d039a192eae7341` | **SUCCESS**; install, frozen-baseline harness, typecheck, `53` credential-free tests, the foundation integration test, and all `8` correction integration tests completed | Real PostgreSQL 17.6 implementation evidence for the unlinked `FIN-COR-01..07`, `FIN-COR-09`, and implemented `FIN-COR-10` branches. |

The successful run is narrow synthetic PostgreSQL implementation evidence. It does not execute linked-domain `FIN-COR-08`, the linked-state race branch, the dedicated repeated/fault-injected FIN-RACE suite, intended Supabase pooling, or production behavior.

## Open items retained

Named approvals, proposed ADR acceptance, intended Supabase pool behavior, linked-domain schema/services and evidence, full FIN-RACE execution, RLS/runtime-role evidence, authentication/session delivery, UI/usability/accessibility evidence, security/legal/governance review, operations, and release gates remain **OPEN**.
