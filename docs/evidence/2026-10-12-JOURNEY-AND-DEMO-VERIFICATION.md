# Journey, traceability and demo verification — 2026-10-12

**Revision verified:** `822736e` on branch `arena/bfaf5019-kfin-know-your-money-keep-your` (PR #10,
unmerged), plus the changeset this record belongs to.
**Environment:** local, disposable. PostgreSQL 17.6 (`synchronous_commit = on`), Node.js 22.22.3,
pnpm 10.34.6 via Corepack. No production system, no Supabase project, no real mail provider, and no
personal data were involved. Databases used: `kfin_test` (integration schema, created and dropped per
run) and `kfin_demo` (demo walkthrough, dropped and recreated for the run).

**Prepared by:** implementation review session (Arena agent), acting for — not as — the owners.

## 1. What was added, and what it changes about verification

| Added | What it proves that nothing else did |
|---|---|
| `apps/api/test/journey.integration.test.ts` (13 cases) | Every other API suite drives `buildApp` with in-memory fakes, and every `packages/database` suite drives repositories with no HTTP layer above them. This suite is the only one that walks **HTTP request → route → domain → PostgreSQL → response** through the production wiring, and asserts the persisted rows as well as the answers. |
| `package.json` `test:integration` now also runs `apps/api/test/*.integration.test.ts` | The journey suite runs in the existing gate and in CI. It is not a new pipeline and not a new workflow: the workflow already calls `pnpm run test:integration`. |
| `docs/development/DEMO-SCRIPT.md` | The demo is reproducible from the repository, with the outcomes actually observed rather than described. |
| `docs/implementation/REQUIREMENTS-TRACEABILITY-MATRIX.md` | Every in-scope MVP capability is mapped to implementation, verification and status — including the capabilities that do **not** exist. |

No production code, migration, pinned specification document or harness file was modified. The journey
suite is guarded exactly like the database integration suites (`TEST_DATABASE_URL` **and**
`KFIN_INTEGRATION_TARGET=non-production`), so it cannot run by accident against an unconfigured target,
and it confines itself to a schema it creates and drops.

## 2. Journey suite — first run after implementation (all 13 cases)

```
✓ apps/api/test/journey.integration.test.ts (13 tests) 681ms
  Test Files  1 passed (1)
       Tests  13 passed (13)
```

| # | Case | Boundary proven |
|---|---|---|
| 1 | Invited person admitted; usable unverified account; no session, no challenge, no mail | OQ-20 at the HTTP boundary, with SQL confirmation of three absences |
| 2 | Sign-in; session resolved from the cookie only | `401` without a cookie |
| 3 | Account bootstrap exactly once; balance reconciles to its snapshot | Idempotent replay returns the identical body, one account row, snapshot row equals the reported balance |
| 4 | Expense posted; stale write refused (`409`); replayed key is the same expense | Optimistic concurrency plus idempotency |
| 5 | Correction via preview → commit; append-only history | Source keeps its original amount and is `voided`; replacement carries the corrected amount via `supersedes_transaction_id`; exactly one posted row remains |
| 6 | Void removes the effect from the authoritative balance | Same balance before and after, row state `voided` with a reason |
| 7 | Occurrence stays projected, then posts exactly once on confirmation | Balance unchanged while `scheduled`; occurrence `confirmed` with a transaction id; balance delta equals the confirmed amount |
| 8 | Savings goal never touches the account balance | Balance **and** `financialStateVersion` unchanged across create + update |
| 9 | Monthly actuals reconcile to posted terminal rows | Report total equals the SQL sum; group totals equal the total |
| 10 | Two owners isolated across transaction, goal and account | `404` on foreign objects; foreign list empty |
| 11 | Password change revokes the other session; old password rejected | `401` for the revoked cookie, `401` for the old password |
| 12 | Reset through the mailed OTP revokes every session; code is single-use | Zero live sessions; replay refused |
| 13 | Operator-only security history stays off the user surface | `EVENT_VISIBILITY` boundary asserted from both sides |

## 3. Quality gate on this changeset

| Check | Command | Result |
|---|---|---|
| Locked install | `corepack pnpm install --frozen-lockfile` | **PASS** — no resolution drift |
| Evidence harness check | `corepack pnpm run evidence:check` | **PASS** — 25 modules / 29 harness files |
| Evidence harness tests | `corepack pnpm run evidence:test` | **PASS** — 17/17 |
| Typecheck | `corepack pnpm run typecheck` | **PASS** — exit 0 (the new suite is inside `apps/**/*.test.ts`) |
| Unit/API tests | `corepack pnpm run test:unit` | **PASS** — 681 passed / 0 failed |
| Integration | `corepack pnpm run test:integration` | **PASS** — **82 passed** (69 database + 13 journey), 8 files |
| Web production build | `corepack pnpm run web:build` | **PASS** — exit 0 |
| Browser end-to-end | — | **NOT RUN** — no browser runtime in this environment; see §6 |

Anti-skip note: the integration counts above are from a run where every case executed. The
anti-silent-skip guard written for the CI work (`.github/scripts/assert-integration-ran.mjs`, PR #11)
would fail the job if any case skipped; it is not yet on this branch, so the honest statement is that the
numbers come from a run that reported zero skips, not that a guard enforced it here.

## 4. Demo walkthrough — executed, not described

A live API (`npx tsx apps/api/src/server.ts`) against `kfin_demo`, driven by the same requests the client
makes. Observed transcript (abridged to the values that matter):

```
[register]  202 {"accepted":true}
[login]     200 userId=4277e734… session=cbf45042… csrfToken length 43
[account]   201 {"accountId":"18c29940…","snapshotId":"86947858…","financialStateVersion":"1"}
[balance]   5000000  (snapshot 86947858…)
[expense]   201 transactionId=e78a68b5… → balance 4750000, postedCurrentExpenseMinor 250000
[correction preview]  before 4750000 → after 4690000
[correction commit]   201 version 3, balance 4690000, reports: removed+added food
[void]      consequence delta +42000, balance 4690000
[schedule]  201 occurrence fb0189b2… state=scheduled presentation=upcoming, balance still 4690000
[confirm]   201 state=confirmed, balance 4202500 (−487500), occurrenceVersion 2
[savings]   create version 1 → update version 2; balance 4202500 and financialStateVersion 7 unchanged
[reports]   2026-10 expenseMinor 797500 = electricity 487500 + food 310000; transportation 0 (voided)
[events]    login_succeeded, registration_requested  (no operator-only events)
```

Arithmetic that matters: `797500 = 310000 + 487500` uses the **corrected** amount, not the original
`250000`, and excludes the voided `42000` — the report reads the terminal transaction of the chain.

**A failure that was real and is worth recording.** The first attempts at this walked into two
reproducibility traps, both now documented in DEMO-SCRIPT.md §3 and §6:

1. an API process left over from an earlier run kept port 3114 with a **different `AUTH_SECRET`**, so
   fresh, valid invitation codes were answered with `AUTH_INVITATION_INVALID` — a convincing domain error
   produced entirely by the environment;
2. an unset/incorrectly parsed idempotency key surfaced as `REQUEST_VALIDATION_FAILED` naming
   `idempotency-key`, which is how we confirmed the key travels as a **request header**, not a query
   parameter.

Neither was a product defect. Both are the class of mistake a demo script exists to prevent.

## 5. Traceability

[`docs/implementation/REQUIREMENTS-TRACEABILITY-MATRIX.md`](../implementation/REQUIREMENTS-TRACEABILITY-MATRIX.md)
maps every in-scope capability from `MVP-SCOPE` §2 to implementation, verification and status. Its
honest headline: the **financial core** (account, snapshots, transactions, corrections, voiding,
occurrences, savings, monthly actuals, isolation) is verified against real PostgreSQL through HTTP;
**safe-to-spend, debt, reminders, recurring patterns, planned purchases and account deletion are not
implemented**, and several of them are additionally blocked on unapproved decisions.

## 6. What this record does not claim

- **No browser interaction was verified.** The client is build-verified and unit-tested; responsive,
  accessibility and visual requirements remain unverified (MVP-SCOPE §6 condition 5).
- **No concurrency claim is new.** The `FIN-RACE-*` evidence still comes from the SPEC-FIN-02 harness;
  a passing harness is not proof that every race passed under production load.
- **No release authorization.** D5, `SPEC-AUTH-01` and `SPEC-AUTH-02` remain unsigned, F-3 remains open,
  and `docs/testing/RELEASE-CHECKLIST.md` is unsigned. Implementation progress does not close any of them.
- **F-8 remains measured-but-undecided**, and its numbers are unchanged by this record.
