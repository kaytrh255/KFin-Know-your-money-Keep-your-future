# Milestone 01 financial foundation — verification record

**Recorded:** 2026-10-08<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Environment:** Local Arena workspace; Node.js `v22.22.3`; no PostgreSQL/Supabase credentials, binaries, or container runtime

This record distinguishes credential-free implementation verification from real PostgreSQL/FIN-RACE evidence. No owner approval, ADR acceptance, blocker closure, production readiness, or Supabase result is implied.

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

## CI status at this record revision

A GitHub Actions workflow was added to run the actual migration and conditional integration test against an ephemeral synthetic PostgreSQL 17.6 service. At the time this local record was written, that workflow had **NOT RUN** on the implementation commit. Its eventual result must be recorded from the check itself; the workflow definition is not evidence of execution.

## Open items retained

Named owner/co-approver approvals, accepted ADRs, approved physical limits, intended Supabase pool behavior, full FIN-RACE fault/race execution, FIN-LINK/FIN-OCC implementation and evidence, RLS decision/evidence, migration/runtime role provisioning, security/legal/governance review, and release gates remain **OPEN**.
