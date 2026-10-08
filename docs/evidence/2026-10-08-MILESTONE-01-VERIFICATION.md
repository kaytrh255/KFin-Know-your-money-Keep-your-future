# Milestone 01 financial foundation — verification record

**Recorded:** 2026-10-08<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Local environment:** Arena workspace; Node.js `v22.22.3`; no PostgreSQL/Supabase credentials, binaries, or container runtime<br>
**CI environment:** GitHub Actions `ubuntu-latest`; Node.js `22.22.0`; ephemeral synthetic `postgres:17.6-alpine`

This record distinguishes local credential-free verification, the narrow foundation integration run against real PostgreSQL, and the still-unexecuted FIN-RACE closure matrix. No owner approval, ADR acceptance, blocker closure, production readiness, Supabase result, or FIN-RACE PASS is implied.

## Commands actually executed

```text
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run test:integration
corepack pnpm audit --prod
corepack pnpm licenses list --prod --json
git diff --check
node evidence/spec-fin-02/src/cli.mjs run --run-token milestone-01-final-local-2026-10-08
```

## Observed local results

| Check | Observed result | Interpretation |
|---|---|---|
| Frozen install | Lockfile up to date; install completed with pnpm `10.34.6` | Reproducible dependency resolution in this workspace |
| FIN-02 harness syntax/static check | `25` JavaScript modules and `29` harness files checked | Harness/static validation only |
| FIN-02 harness unit/static tests | `16` executed, `16` passed, `0` failed | Not FIN-RACE PostgreSQL PASS evidence |
| TypeScript application + test typecheck | Completed successfully | Compile-time verification only |
| Vitest full local suite | `43` executed/passed, `0` failed; `1` PostgreSQL integration test skipped | Credential-free domain/API/protocol/static tests passed; database behavior did not run |
| Explicit integration command | `1` test skipped, `0` executed | `TEST_DATABASE_URL` and explicit non-production target were unavailable |
| Production dependency audit | `No known vulnerabilities found` | Point-in-time package-manager advisory result only |
| Production dependency license list | `Apache-2.0`, `BSD-3-Clause`, `ISC`, `MIT` | Point-in-time package metadata; not legal approval |
| Patch whitespace check | `git diff --check` completed successfully | Patch-format check only |
| FIN-02 evidence command | Process exit code `2`; overall `BLOCKED` | No PostgreSQL behavior executed |

The final ignored local FIN-02 artifact is under `.artifacts/spec-fin-02/milestone-01-final-local-2026-10-08/`. It records:

- frozen source commit `a48d2c5683550859c1b4e19e9d06750616adc0a2`;
- PostgreSQL `NOT OBSERVED`;
- node-postgres `8.23.1`;
- pool mode `unknown`;
- every `FIN-RACE-01..08` case `BLOCKED`, `Executed: no`, `0` runtime assertions; and
- `evidence.json` SHA-256 `bcb0019f937ccf148856c772c7d5f162234b484c4c4be2ce21e97e72bfc26c4f`.

## Case status retained

- `FIN-LINK-01..06`: **NOT RUN — implementation prerequisite**. Owning schedule/debt/purchase link services are deliberately not implemented in this milestone.
- `FIN-OCC-01..04`: **NOT RUN — implementation prerequisite**. Occurrence persistence/services are deliberately not implemented in this milestone.
- `FIN-RACE-01..08`: **BLOCKED** locally. No case executed against PostgreSQL; no case is labelled PASS.
- The conditional financial-foundation integration test is implementation test infrastructure, not a FIN-RACE substitute. A mocked protocol/unit result cannot close SPEC-FIN-02.

## GitHub Actions execution history

The workflow uses only synthetic test data and an ephemeral `postgres:17.6-alpine` service. The following checks actually ran:

| Run | Head | Observed result | Disposition |
|---|---|---|---|
| [`37751096435`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37751096435) | `10e0e4e5b2f1258387c9cb44acc3d5efe1d0e68c` | **FAILURE** at `Validate evidence harness`; later steps did not run | The default shallow checkout did not provide the frozen baseline history required by the harness. Checkout was changed to `fetch-depth: 0`; no test PASS was claimed. |
| [`37751251597`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37751251597) | `d4fa3057c557ecf40c7534c53aa75d97b1ef0109` | Harness, typecheck, and credential-free tests passed; the real-PostgreSQL integration step **FAILED** | PostgreSQL `date` was decoded as a JavaScript `Date` where the local-date classifier requires `YYYY-MM-DD`. Database boundary selects were corrected to return date-only values as text; no integration PASS was claimed for this run. |
| [`37751446740`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37751446740) | `d8213b4b12e25b69b2679af4552afd88da46c27d` | **SUCCESS**; install, frozen-baseline harness checks, typecheck, `43` credential-free tests, and the single guarded foundation integration test all completed successfully | The integration test applied the real migration in an isolated schema and exercised bootstrap, serialization, replay, balance segmentation, stale-state rejection, and two-user isolation against PostgreSQL 17.6. |

The successful foundation integration run is real PostgreSQL implementation evidence, but it is not the separately specified fault/race matrix. It does not execute or close `FIN-RACE-01..08`, does not establish Supabase pool behavior, and does not approve production settings.

## Open items retained

Named owner/co-approver approvals, accepted ADRs, approved physical limits, intended Supabase pool behavior, full FIN-RACE fault/race execution, FIN-LINK/FIN-OCC implementation and evidence, RLS decision/evidence, migration/runtime role provisioning, security/legal/governance review, and release gates remain **OPEN**.
