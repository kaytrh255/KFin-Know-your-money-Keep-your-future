# KFin Test Strategy

**Status:** Draft — FIN-01/02 cases specified; no execution evidence<br>
**Version:** 0.6<br>
**Release target:** Private Beta, at most 50 users<br>
**Current evidence:** None; no application has been implemented or tested

## 1. Purpose

Testing is an independent verification phase, not a synonym for compilation or successful startup. This strategy defines how KFin will produce evidence that approved product, UX, security, data, operational, and recovery requirements are satisfied.

## 2. Principles

1. Trace tests to requirement, flow, threat, and ADR IDs.
2. Prioritize authentication, authorization, money integrity, schedules, recovery, and private-data leakage by risk.
3. Test observable behavior and invariants, not implementation trivia.
4. Use a real PostgreSQL engine for persistence behavior; an in-memory substitute cannot validate SQL constraints/transactions/RLS.
5. Control time, timezone, randomness, email, and worker execution deterministically.
6. Test failures and concurrency, not only happy paths.
7. A flaky test is a defect; quarantining requires owner, reason, expiry, and equivalent coverage.
8. No production user data in any test environment or artifact.
9. Automated checks complement, not replace, accessibility, UX, security, and recovery review.
10. Never claim `PASS` without a reproducible run and retained evidence.

## 3. Traceability model

Each test or evidence item should reference applicable IDs:

```text
Requirement: PRD-EXP-03, SEC-APP-05
Flow: UF-FIN-04
Threat: TM-15, TM-16
Test: API-TXN-FASTADD-001, E2E-FASTADD-001
Evidence: CI run / report / review record
```

A release traceability report must show every normative MVP requirement as:

- covered and passing;
- covered manually with dated evidence;
- not applicable with rationale; or
- open/blocking.

Missing mapping is not implicitly passing.

### 3.1 Safe-to-spend requirement → flow → invariant → test matrix

All amounts below are exact integer VND units and validate `safe_to_spend.v1`. Each case uses a fixed evaluation instant and the user’s persisted IANA timezone. These are required cases, not current test evidence.

| Requirement → | Flow → | Invariant → | Test case | Fixture / action | Required result |
|---|---|---|---|---|---|
| PRD-DASH-07, PRD-FIN-02 | UF-DASH-01 | FIN-STS-INV-01, FIN-STS-INV-06 | STS-01 — balance only | Authoritative balance `B = 1,000,000`; no eligible outgoing or active goal | `1,000,000` |
| PRD-DASH-07, PRD-REM-01 | UF-DASH-01, UF-SCH-03 | FIN-STS-INV-02 | STS-02 — unpaid this month | `B = 1,000,000`; one unpaid outgoing `300,000` due before local month-end | `700,000`; occurrence appears in drill-down |
| PRD-DASH-07, PRD-REM-04 | UF-DASH-01, UF-SCH-04 | FIN-STS-INV-02 | STS-03 — unresolved overdue | `B = 1,000,000`; one unpaid overdue outgoing `200,000` from a prior month | `800,000`; overdue is not dropped at month rollover |
| PRD-DASH-07 | UF-DASH-01 | FIN-STS-INV-02, FIN-STS-INV-07 | STS-04 — horizon boundary | `B = 1,000,000`; `300,000` due on local month-end and `400,000` due next local day | `700,000`; month-end item included and next-month item excluded |
| PRD-DASH-07, PRD-INC-03 | UF-DASH-01, UF-SCH-01 | FIN-STS-INV-05 | STS-05 — projected income | `B = 1,000,000`; unreceived scheduled income `500,000` due this month | `1,000,000`; projected income is disclosed as excluded |
| PRD-DASH-07, PRD-INC-03 | UF-SCH-02, UF-DASH-01 | FIN-STS-INV-01, FIN-STS-INV-05 | STS-06 — received income | The `500,000` income in STS-05 is explicitly received and posted current-impact, making `B = 1,500,000` | `1,500,000`; effect comes only through authoritative balance |
| PRD-DASH-07, PRD-EXP-05 | UF-SCH-03, UF-DASH-01 | FIN-STS-INV-03 | STS-07 — paid outgoing transition | Before confirmation: `B = 1,000,000`, unpaid `O = 300,000`; after atomic confirmation: `B = 700,000`, `O = 0` | `700,000` before and after; never `400,000` |
| PRD-DASH-07, PRD-REM-03 | UF-SCH-04, UF-DASH-01 | FIN-STS-INV-02 | STS-08 — skipped/cancelled | `B = 1,000,000`; `300,000` outgoing is skipped or cancelled | `1,000,000`; neither terminal non-payment state is subtracted |
| PRD-DASH-07, PRD-SAV-05 | UF-SAV-01, UF-DASH-01 | FIN-STS-INV-04 | STS-09 — active reserve sum | `B = 1,000,000`; two active goal current amounts are `100,000` and `150,000` | `750,000`; both reserves sum while balance/monthly flow remain unchanged |
| PRD-DASH-07, PRD-SAV-07 | UF-SAV-01, UF-DASH-01 | FIN-STS-INV-04 | STS-10 — archived reserve exclusion | `B = 1,000,000`; active goal `100,000`; archived goal retaining `150,000` | `900,000`; archived history is retained but not reserved |
| PRD-DASH-07 | UF-DASH-01 | FIN-STS-INV-02, FIN-STS-INV-04 | STS-11 — combined deductions | `B = 1,000,000`; eligible `O = 300,000`; active `G = 250,000` | `450,000`, with both component lists inspectable |
| PRD-DASH-07, PRD-FIN-08 | UF-FIN-02, UF-DASH-01 | FIN-STS-INV-01, FIN-SNAP-INV-03 | STS-12 — historical-only backfill | `B = 1,000,000`; historical-only income `500,000` is added to selected-month reporting | `1,000,000`; month income changes, safe-to-spend does not |
| PRD-DASH-07, PRD-FIN-09 | UF-FIN-03, UF-DASH-01 | FIN-STS-INV-01, FIN-SNAP-INV-04 | STS-13 — newer authoritative anchor | Prior segment has current-impact income `200,000`; user creates newer snapshot `800,000` | `800,000`; prior-segment delta is not re-summed |
| PRD-DASH-07 | UF-DASH-01 | FIN-STS-INV-06 | STS-14 — negative result | `B = 200,000`; eligible `O = 300,000`; active `G = 50,000` | `-150,000`; signed shortfall is not clamped |
| PRD-DASH-07 | UF-DASH-01 | FIN-STS-INV-02, FIN-STS-INV-07 | STS-15 — timezone/month rollover | At one fixed UTC instant, an `April 15` outgoing is outside the horizon when the stored local month is March and inside it when the approved timezone change makes the local month April | Recalculation follows the persisted timezone/local month, produces one deterministic result, and exposes the changed horizon |

### 3.2 Balance-snapshot scenario matrix A–J

Scenarios A–G retain approved required results. Issue #1 supplies proposed H–I/J correction semantics under `snapshot_correction.v1`; Issue #3 supplies proposed PostgreSQL enforcement under `account_financial_serialization.v1`. Both are test specifications only: owner approvals and runtime evidence are absent, both blockers remain OPEN, and no implementation is authorized.

| Scenario | Requirement → Flow | Invariants | Fixture / action | Required result / status |
|---|---|---|---|---|
| A — initial anchor | PRD-FIN-01 → UF-FIN-01 | FIN-SNAP-INV-01, FIN-SNAP-INV-02 | Onboarding snapshot is `1,000,000`; no transaction | Current balance is `1,000,000`; anchor/as-of visible |
| B — latest-segment income | PRD-FIN-02 → UF-FIN-05 | FIN-SNAP-INV-02 | Add posted current-impact income `200,000` to the latest segment | Current balance is `1,200,000` |
| C — latest-segment expense | PRD-FIN-02 → UF-FIN-04 | FIN-SNAP-INV-02 | Add posted current-impact expense `300,000` to the latest segment | Current balance is `700,000` |
| D — pre-anchor backfill | PRD-FIN-08 → UF-FIN-02 | FIN-SNAP-INV-03, FIN-SNAP-INV-07 | Add historical-only expense `300,000` before the anchor | Current balance remains `1,000,000`; selected-month outflow includes `300,000` with historical label |
| E — same local date | PRD-FIN-10 → UF-FIN-02 | FIN-SNAP-INV-05 | On the anchor’s local date, test explicit `already included = yes` and `no` choices | `yes` is historical and does not move balance; `no` is current-impact and moves it; omission is rejected |
| F — new segment | PRD-FIN-09 → UF-FIN-03 | FIN-SNAP-INV-04, FIN-SNAP-INV-06 | After snapshot `1,000,000` and current income `200,000`, create new authoritative snapshot `900,000` | Current balance is exactly `900,000`; prior delta remains evidence and is not added again |
| G — no whole-history reconciliation | PRD-DASH-03, PRD-FIN-08 → UF-DASH-01 | FIN-SNAP-INV-03, FIN-SNAP-INV-07 | Select a month containing current and historical-only records across a snapshot boundary | Monthly totals include eligible posted records; current balance uses latest segment only; disclosure explains why the figures do not reconcile by all-history summation |
| H — correction within latest segment | PRD-FIN-04, PRD-FIN-11 → UF-FIN-06 | FIN-SNAP-INV-02, FIN-SNAP-INV-08 | Latest snapshot `1,000,000`; posted current expense `300,000`; correct amount to `250,000` with no race | Proposed Issue #1 result: atomically void source + post one same-anchor/effect replacement; balance `750,000`; report has only active `250,000`; chain/idempotency/link evidence retained. Never count both effects. |
| I — correction concerning a closed prior segment | PRD-FIN-04, PRD-FIN-11 → UF-FIN-06 | FIN-SNAP-INV-04, FIN-SNAP-INV-08, FIN-SNAP-INV-10 | Older segment has expense `300,000`; newer authoritative snapshot is `900,000`; correct old amount to `250,000` | Proposed Issue #1 result: void + same-anchor/effect replacement; authoritative current balance remains exactly `900,000`; report replaces `300,000` with `250,000` and exposes correction history. |
| J — crossing/racing an anchor | PRD-FIN-11–13 → UF-FIN-03, UF-FIN-06 | FIN-SNAP-INV-09, FIN-SNAP-INV-10 | (a) request another anchor/effect/date requiring another segment; (b) race correction against a new snapshot from version `N` | (a) deterministic cross-segment/effect error and no write. (b) proposed account-row lock winner commits version `N+1`; losing snapshot gets `FIN_SNAPSHOT_STALE_STATE` or losing correction gets `FIN_CORRECTION_STALE_STATE`; no auto-reanchor/partial/duplicate. Runtime evidence remains `SPEC-FIN-02`. |

#### 3.2.1 `FIN-COR-01`–`FIN-COR-10` correction matrix

These are reproducible specification cases for the Issue #1 proposal. They are NOT RUN and cannot be labelled PASS.

| Case | Fixture/action | Required result |
|---|---|---|
| FIN-COR-01 — latest amount | Snapshot `1,000,000`; current expense `300,000`; correct to `250,000` | One voided source + one posted same-anchor/effect replacement; current `750,000`; active report effect `250,000` |
| FIN-COR-02 — closed segment | Older expense `300,000`; newer snapshot `900,000`; correct old to `250,000` | Current remains `900,000`; applicable report uses `250,000`; full chain visible |
| FIN-COR-03 — historical | Snapshot `1,000,000`; historical expense `300,000`; correct to `250,000` | Current remains `1,000,000`; report uses `250,000`; source retained |
| FIN-COR-04 — valid report-date move | Closed-segment date moves between months but stays valid in same anchor/effect | Current unchanged; source month removes and destination month adds replacement; both drill to chain |
| FIN-COR-05 — cross-anchor date | Proposed date requires another snapshot segment | `FIN_CORRECTION_CROSS_SEGMENT_UNSUPPORTED`; no write or aggregate/link change |
| FIN-COR-06 — authority-field tamper | Change anchor, effect, inclusion, owner/account/currency, or kind | Stable invalid-transition error; no write; safe tamper signal where appropriate |
| FIN-COR-07 — standalone void | Void unlinked latest current expense; retry after uncertain response | Reverse source exactly once; no replacement; compatible retry returns first result |
| FIN-COR-08 — owning links | Correct schedule-only transaction; try generic debt and planned-purchase paths | Schedule pointer transfers atomically; debt/purchase paths reject/delegate; no orphan or partial state |
| FIN-COR-09 — idempotency | Parallel same-key/same-payload, then same key/different payload | One chain/result; compatible retries return it; changed payload rejected |
| FIN-COR-10 — races | Race correction versus snapshot, correction, and link update | One winner; losing snapshot gets `FIN_SNAPSHOT_STALE_STATE`, other stale request gets `FIN_CORRECTION_STALE_STATE`; no auto-reanchor, branch, duplicate, or partial state |

All ten cases additionally assert same-user/currency ownership, required reason, consequence preview, one posted terminal row, report correctness, and append-only audit. Exact PostgreSQL race execution remains `SPEC-FIN-02` evidence.

#### 3.2.2 `FIN-RACE-01`–`FIN-RACE-08` PostgreSQL concurrency matrix

These are reproducible tests for proposed `account_financial_serialization.v1`. They MUST run against intended PostgreSQL/driver/pool behavior with deterministic barriers; they are currently **NOT RUN**. Execution uses a versioned candidate commit frozen for evidence. That freeze is not owner approval, ADR acceptance, blocker resolution, or permission to open the Implementation Gate.

| Case | Forced fixture/action | Required result |
|---|---|---|
| `FIN-RACE-01` — snapshot vs transaction | Both requests use version `N` and latest snapshot `S`; force transaction-first, then snapshot-first | First commit increments to `N+1`; loser gets its operation-specific `409`; transaction is never silently moved to a new anchor; one latest snapshot/effect only |
| `FIN-RACE-02` — snapshot vs correction/void | Same reviewed state; force correction-first and snapshot-first, including linked schedule correction | One complete winner; losing snapshot gets `FIN_SNAPSHOT_STALE_STATE` or losing correction gets `FIN_CORRECTION_STALE_STATE`; source/replacement/link remain atomic |
| `FIN-RACE-03` — correction vs correction/void | Parallel different keys target one posted terminal source | One source transition and at most one replacement; loser stale; no branch, double reversal, partial link, or second version increment |
| `FIN-RACE-04` — snapshot vs snapshot/stale tab | Two snapshots or a deliberately stale tab use version `N`; force both orders | Exactly one new immutable latest snapshot and version `N+1`; loser stale; no duplicate effective anchor or overwrite |
| `FIN-RACE-05` — idempotency contention | Parallel same-key/same-digest, then same key/different digest, plus retry after committed version changed | Compatible calls return one stored result and one version increment; different digest gets `IDEMPOTENCY_KEY_REUSED`; replay is not stale |
| `FIN-RACE-06` — rollback cleanup and bounded retry | Force each of `55P03`, `40P01`, `40001` after the account lock on attempt one and, in exhaustion subcases, again on attempt two; commit a competitor between attempts in a stale subcase; force `57014` with request context cancelled; separately exhaust pre-retry budget and make rollback acknowledgement unconfirmable | Each confirmable case reaches `ReadyForQuery(I)`/driver-equivalent before check-in/result/fresh `BEGIN`; `57014`, insufficient budget, and unconfirmed cleanup start no retry; unconfirmed cleanup evicts the handle; changed state is stale; second transient is busy; no failed-transaction reuse/third attempt |
| `FIN-RACE-07` — timeout/commit uncertainty | Cut the connection before `COMMIT`, after `COMMIT` is sent, and after commit but before response; test original commit and rollback branches | Same key recovers one result or safely executes once after rollback; unresolved budget returns `FINANCIAL_RESULT_UNKNOWN`; no duplicate row/effect/version increment |
| `FIN-RACE-08` — scope, order, and bypass | Run covered user/worker/operator/domain writes on one account and parallel writes on distinct synthetic accounts; deliberately violate child-before-account order in test instrumentation | Same-account writes serialize; distinct accounts are not globally locked; every covered path uses account-first order; prohibited order/bypass fails architecture review/test |

Evidence execution requirements:

- record PostgreSQL/driver/ORM/pool/configuration and schema/spec/harness commits;
- force, do not merely hope for, each winner order; run at least 100 repetitions per order for FIN-RACE-01–05 with zero forbidden result;
- record exact SQLSTATE, attempt count, backoff, remaining budget and final state for every FIN-RACE-06 subcase, including both attempts, `57014`, budget-prevented retry and rollback-acknowledgement loss;
- capture same-connection protocol/driver events proving failure status → `ROLLBACK` → `ReadyForQuery(I)`/documented idle equivalent before check-in/result and before any fresh `BEGIN`/transaction identity;
- use an observer to prove no known account/child lock remains after cleanup, without assuming the original error itself released it;
- force deterministic clean reuse through a one-slot application pool or equivalent handle/session correlation; the next borrower runs sentinel/new-transaction work without `25P02`, inherited locks/settings/context;
- prove unconfirmed cleanup invalidates/closes the application handle before response, checks it in nowhere, starts no internal retry on another connection, and cannot hand that handle to the next borrower; distinguish managed-pooler backend reuse from application-handle reuse;
- use connection/proxy fault injection at each FIN-RACE-07 cut point; before-`COMMIT` loss must confirm backend/session termination before same-key re-execution;
- prove one version increment for a winner and zero for stale/replay/rollback;
- capture sanitized lock/query evidence, p95/p99 lock wait/transaction duration, defects and rerun disposition; and
- register producer, named mandatory reviewers, date and artifact digest under `EVID-FIN-CONCURRENCY`.

Documentation, mocked locks, sleep-only races, or an in-memory database cannot produce closure evidence.

### 3.3 Debt-payment correction safety matrix

| Requirement → | Flow → | Invariant → | Test case | Explicit facts | Required result / status |
|---|---|---|---|---|---|
| PRD-DEBT-02, PRD-DEBT-03 | UF-DEBT-02 | DEBT-INV-01, DEBT-INV-02, DEBT-INV-03, DEBT-INV-04 | DCT-01 — no split | Total payment `300,000`; no split and no lender-reported balance | Cash outflow posts; outstanding amount/as-of remain unchanged; no component is inferred |
| PRD-DEBT-02, PRD-DEBT-03 | UF-DEBT-02 | DEBT-INV-02, DEBT-INV-03, DEBT-INV-04 | DCT-02 — partial without principal | Total `300,000`; explicit interest `50,000`; `250,000` unclassified | Outstanding remains unchanged; remainder is visibly unclassified, not principal or fee |
| PRD-DEBT-02 | UF-DEBT-02 | DEBT-INV-03, DEBT-INV-04 | DCT-03 — explicit principal | Prior outstanding `1,000,000`; explicit principal `200,000`; no later event | Outstanding becomes `800,000`; interest/fee remain only as explicitly entered |
| PRD-DEBT-02 | UF-DEBT-02 | DEBT-INV-04 | DCT-04 — lender-reported balance | User explicitly selects new lender-balance mode with `750,000` and as-of date | Outstanding becomes exactly `750,000`; principal deduction is not also applied and no difference is labelled as inferred interest/principal/fee |
| PRD-DEBT-03 | UF-DEBT-02 | DEBT-INV-02, DEBT-INV-03 | DCT-05 — invalid/complete split | Components exceed total, or a `complete` split omits explicit zero/value | Write is rejected; KFin does not repair or redistribute components |
| PRD-DEBT-05 | UF-DEBT-03 | DEBT-INV-05, DEBT-INV-07 | DCT-06 — cash-only correction | Old/replacement payments have no outstanding effect; total/date changes | Linked old/new cash records are preserved; outstanding amount/as-of remain unchanged |
| PRD-DEBT-05 | UF-DEBT-03 | DEBT-INV-05, DEBT-INV-06 | DCT-07 — latest explicit-effect correction | No later outstanding event; exact pre-state, old effect, and replacement principal or lender balance are all explicit | Atomic old/new evidence and exact consequence preview; only explicit replacement facts can affect outstanding |
| PRD-DEBT-06 | UF-DEBT-03 | DEBT-INV-08 | DCT-08 — later payment/adjustment | Correction/void target has a later outstanding-affecting payment or balance adjustment | **BLOCKER — `SPEC-DEBT-01`:** no automatic recomputation, rebase, or guessed preview; exact workflow requires Product Owner approval with Financial Integrity and Data co-approval |
| PRD-DEBT-06 | UF-DEBT-03 | DEBT-INV-02, DEBT-INV-08 | DCT-09 — missing state/reordered as-of | Pre-state is absent, dates would reorder, or result requires deriving any omitted component/outstanding | Operation is blocked; only a separately explicit lender-reported balance adjustment is safe; no inferred value |

### 3.4 Reminder downtime and catch-up matrix

These cases establish the safe boundary. Rows marked with `SPEC-REM-01` cannot receive a fabricated expected stage until the Product Owner resolves the selection policy.

| Requirement → | Flow → | Invariant → | Test case | Condition | Required result / status |
|---|---|---|---|---|---|
| PRD-REM-02, PRD-REM-04 | UF-REM-01 | REM-INV-01, REM-INV-02, REM-INV-03, REM-INV-04 | RCT-01 — normal stage | Worker runs at one stage’s 09:00 local target for unresolved outgoing | One durable occurrence + stage notification; no scheduled-income stage; no duplicate first-overdue |
| PRD-REM-10 | UF-REM-01 | REM-INV-05, REM-INV-06 | RCT-02 — app closed | Web/PWA is closed at evaluation and remains closed | Eligible server evaluation is unchanged; no financial state change or external reminder channel |
| PRD-REM-10 | UF-REM-01 | REM-INV-06, REM-INV-07 | RCT-03 — delayed app return | User returns after persisted notifications already exist | Existing read/unread list appears; return creates no event, replay, stage burst, transaction, or paid state |
| PRD-REM-06, PRD-REM-11 | UF-REM-01 | REM-INV-03, REM-INV-08, REM-INV-09 | RCT-04 — one missed stage | Worker recovers after one target elapsed | At most one catch-up event and no duplicate; exact recovery-window/emit policy remains part of `SPEC-REM-01` |
| PRD-REM-11 | UF-REM-01 | REM-INV-08, REM-INV-09 | RCT-05 — multiple missed stages | Downtime spans 7-day, 3-day, and due-today targets | Never more than one catch-up notification for the occurrence in one recovery evaluation; **BLOCKER `SPEC-REM-01`** decides which stage, if any, and suppression records |
| PRD-REM-11, PRD-REM-12 | UF-REM-01 | REM-INV-04, REM-INV-08, REM-INV-09 | RCT-06 — late occurrence creation | Occurrence is created after one or several stage targets elapsed | State is rechecked and no burst occurs; **BLOCKER `SPEC-REM-01`** decides the one stage, if any |
| PRD-REM-06, PRD-REM-11 | UF-REM-01 | REM-INV-02, REM-INV-03, REM-INV-04, REM-INV-08, REM-INV-09 | RCT-07 — timezone change | Forward change makes stages elapsed; backward change revisits a local target | Recompute from persisted IANA timezone, never duplicate occurrence + stage, and emit at most one catch-up; **BLOCKER `SPEC-REM-01`** decides selection after a forward jump |
| PRD-REM-12 | UF-SCH-04, UF-REM-01 | REM-INV-04, REM-INV-05 | RCT-08 — resolved during delay | Occurrence becomes confirmed, skipped, or cancelled before claimed catch-up insert | No new reminder; no stale worker action changes financial state |
| PRD-REM-04, PRD-REM-06 | UF-REM-01 | REM-INV-03, REM-INV-04, REM-INV-05 | RCT-09 — retry/crash/concurrency | Retry, lease reclaim, or parallel workers evaluate same stage | One occurrence + stage notification, idempotent completion, and no payment mutation |
| PRD-REM-05 | UF-REM-01 | REM-INV-10 | RCT-10 — channel boundary | Any normal or catch-up path executes | In-app record only; no payment-reminder email, push, SMS, chat, or permission prompt |

### 3.5 Round 3 blocker closure evidence matrix

The suites below are specifications for evidence, not executed results. A blocker cannot close when only the test design exists. Each retained result must identify specification version, environment/tool/runtime, producer, named reviewer, date, expected/observed result, defects, and disposition in the Approval and Evidence Register.

| Blocker | Mandatory decision-validation suite | Accountable review | Objective closure result | Current result |
|---|---|---|---|---|
| `SPEC-AUTH-01` | `AUTH-VRF-01`–`AUTH-VRF-06`: both candidate threat reviews; fresh-identifier/no-session assertion; cookie/CSRF; multi-tab; timeout-after-consume; compact/expanded result flow/content | Product + Security; QA evidence review | Exactly one branch is approved; selected branch passes all applicable cases; rejected branch is absent from source contracts | NOT RUN — OPEN |
| `SPEC-AUTH-02` | `AUTH-POL-01`–`AUTH-POL-12`: each invitation/password/OTP/reset/login/session/rotation/replay/password-change boundary, Argon2 benchmark, provider failure and abuse-cost tests | Security + Product; Architecture/UX/Operations/QA consultation | Every dimension has approved value/range/change owner and exact pass/fail outcomes; evidence covers lower/upper/expiry/replay/failure boundaries | NOT RUN — OPEN |
| `SPEC-FIN-01` | Issue #1 policy review plus H–J and `FIN-COR-01`–`FIN-COR-10`: void/replacement, same/prior/cross-segment, occurrence/debt/purchase links, report periods, idempotent retry and stale state | Product + Financial Integrity + Data + Security | Owners approve `snapshot_correction.v1`; one effective result only; current-balance/history constraints hold; all supported/rejected transitions and linked effects are exact | SPECIFIED, NOT RUN — OPEN |
| `SPEC-FIN-02` | ADR-009 review plus `FIN-RACE-01`–`FIN-RACE-08`: account-row lock/version, forced orders, idempotency, exact SQLSTATE/bounds, idle-confirmed rollback, lock release, deterministic clean reuse, unconfirmed-cleanup eviction/no-retry, commit uncertainty and bypass | Data + Architecture + Security + Financial Integrity | Owners approve `account_financial_serialization.v1`; real-PostgreSQL evidence on Supabase proves one winner/stale loser, idle-confirmed rollback before response/retry/check-in, fresh transaction per permitted retry, deterministic clean reuse, eviction/no-retry after unconfirmed cleanup, no duplicate/third retry and same-key recovery | SPECIFIED, NOT RUN — OPEN |
| `SPEC-DEBT-01` | DCT-08/09 plus `DEBT-HIST-01`–`DEBT-HIST-06`: later payment, later adjustment, date reorder, void, missing pre-state and partial failure | Product + Financial Integrity + Data | Approved policy yields exact safe result or explicit rejection for every branch; no inferred component/outstanding in state or preview | NOT RUN — OPEN |
| `SPEC-SCH-01` | `SCH-BND-01`–`SCH-BND-10`: leap/non-leap recurrence, return to leap year, interval/end/horizon/batch/user bounds, occurrence edit, future split, reminder regeneration, edit/worker race | Product + Data + Architecture | Every boundary has one result; generation is bounded/idempotent; confirmed/skipped/cancelled history is preserved | NOT RUN — OPEN |
| `SPEC-REM-01` | RCT-04–07 plus `REM-REC-01`–`REM-REC-07`: one/multiple missed stages, first overdue, recovery expiry, timezone, late creation, state change during claim and suppression audit | Product + Architecture + Operations + QA | Approved tuple produces zero/one expected catch-up; never a burst/duplicate/financial mutation; each elapsed non-selected stage is auditable | NOT RUN — OPEN |
| `SPEC-SEC-01` | `SEC-RLS-01`–`SEC-RLS-10`: private table × action matrix, two-user APIs, nested IDs, pool reuse, worker/operator/migration roles, bypass attempt and omitted-RLS architecture guard | Security + Data + Architecture | Selected branch covers every private path; cross-user attempts fail equivalently; trusted context cannot leak; omitted-RLS residual risk is signed if applicable | NOT RUN — OPEN |
| `SPEC-SEC-02` | `SEC-HIST-01`–`SEC-HIST-08`: every event class, owner/operator query separation, safe-field schema, authorization, enumeration, retention, Vietnamese content and screen-reader/compact presentation | Product + Security + Privacy/Legal | Every event has one approved class; forbidden fields never appear; visible events are understandable/accessible; retention and APIs match policy | NOT RUN — OPEN |
| `SPEC-DEL-01` | `DEL-LIFE-01`–`DEL-LIFE-10`: request/recent-auth, cancel/purge race, pending sessions, first-party/provider map, idempotent retry, legal hold, retained fields/expiry, tombstone outage/key access, backup restore drill | Privacy/Legal + Product + Security + Operations | Every category has disposition; one terminal state per race; no reusable secret remains; current tombstones prevent restored data activation | NOT RUN — OPEN |
| `SPEC-UX-01` | `UX-EVID-01`–`UX-EVID-10`: compact/expanded states, Vietnamese content, moderated critical tasks, keyboard, screen reader, 200%/400% reflow, contrast, targets, reduced motion and error/offline/conflict comprehension | UX/Accessibility + Product | Every manifest item has dated/versioned evidence and named sign-off; no unresolved severe accessibility/usability issue remains | NOT RUN — OPEN |
| `SPEC-GOV-01` | `GOV-EVID-01`–`GOV-EVID-08`: named authorities/delegates, conflict/quorum rules, physical-limit decisions, evidence metadata, spec/ADR trace, change history, risk expiry and cross-document consistency | Product + all mandatory domain owners | No mandatory role/value/evidence field is missing; every ADR/spec disposition is authorized, versioned and traceable | NOT RUN — OPEN |

The detailed decision dimensions and acceptance criteria are in the [Round 3 remediation report](../reviews/SPECIFICATION-REMEDIATION-ROUND-3.md); evidence metadata and sign-off are controlled by the [Approval and Evidence Register](../governance/APPROVAL-AND-EVIDENCE-REGISTER.md).

## 4. Test environments

| Environment | Purpose | Data | External services |
|---|---|---|---|
| Local | Developer feedback | Synthetic factories | Local/fake email; disposable PostgreSQL |
| CI isolated | Unit/component/integration/API/security automation | Deterministic synthetic, per-run database | Fakes/contract stubs; no real user email |
| Supabase PostgreSQL evidence project | SPEC-FIN-02 deterministic race, idle-confirmed rollback, lock-release, clean/evicted pool handling and commit-fault execution against a frozen candidate commit | Synthetic isolated accounts only; no production/beta data | Dedicated non-production Supabase project using intended driver/pool settings; candidate freeze is not approval, and this evidence target does not select the production provider under OQ-17 |
| Staging | Deployed E2E, DAST, headers, cache, provider sandbox, migration, performance | Synthetic seeded personas | Email sandbox/test domain; staging-only telemetry |
| Recovery exercise | Restore/rollback validation isolated from normal staging | Encrypted test backup or approved synthetic production-like set | Restricted; destroyed after exercise |
| Production | Post-deploy smoke and monitoring only; no destructive scanner/load test | Real beta data | Production providers |

Production credentials/data must never be available to routine CI. Environment banners and telemetry labels prevent confusion.

## 5. Test levels

### 5.1 Static and build verification

- Formatting, lint, strict TypeScript, dead/unreachable boundary rules.
- Dependency/module architecture tests prevent forbidden cross-module imports.
- API schema generation and compatibility checks.
- Migration lint/review rules.
- Secret scanning, dependency vulnerability/license/provenance checks, SAST.
- Reproducible production build and bundle inspection for secrets/source maps.
- Design-token/component usage checks where reliable.

Static success never replaces runtime tests.

### 5.2 Unit tests

Fast deterministic tests for domain/application logic without network or real database where persistence semantics are not the subject.

Priority units:

- integer-money addition/subtraction/bounds/format-contract conversion;
- current-balance calculation by latest immutable snapshot segment, historical-only exclusion, and selected-month inclusion of labelled backfill;
- safe-to-spend formula/version through mandatory cases `STS-01`–`STS-15`;
- classification and no-double-counting rules;
- recurrence next-date generation including 29/30/31, leap day, end date, timezone policy;
- due/due-today/overdue derived state;
- debt split reconciliation, outstanding update/correction, and no-split behavior that never assumes principal;
- manual savings current/target progress, as-of behavior, version conflicts, and old/new audit metadata;
- planned-purchase transition and linked-goal scalar deduction, including zero/partial/full bounds, idempotency, and no double counting;
- challenge/session/invitation expiry, rotation/consumption state machines, and password policy;
- eligible outgoing-obligation 09:00 user-local reminder stages, scheduled-income exclusion, once-only overdue deduplication, and month-end cash-flow-warning fingerprint;
- log/telemetry redaction helpers.

Use table-driven and property-based tests for money/date/state invariants. A code-coverage percentage is a diagnostic, not the release goal; critical rules require branch and boundary coverage regardless of aggregate percentage.

### 5.3 UI component and design-system tests

- Semantic role/name/state/value and keyboard behavior.
- Focus-visible, focus trap/restore, dialog/sheet escape/back behavior.
- Error summary and live-region announcements.
- Money/date overflow, long translated labels, 200% zoom layouts.
- Component variants/states through Storybook or equivalent isolated harness if adopted.
- Automated axe-core checks plus visual regression at representative compact/expanded sizes.
- Reduced-motion and high-contrast/forced-color behavior where supported.

Visual snapshots must be reviewed; they cannot approve accessibility or UX automatically.

### 5.4 Database and integration tests

Run against the supported PostgreSQL version in disposable isolated databases.

- Migrations apply from empty and from the previous release; constraints/indexes/RLS exist as specified.
- Money, currency, owner-composite, status/link, uniqueness, and version constraints reject invalid writes.
- Transactions roll back fully at injected failure points; every retryable SQLSTATE and `57014` trace proves same-connection rollback reaches idle before check-in/response, and permitted retries start a fresh transaction only afterward.
- Pool tests prove no lock/failed state remains after cleanup, deterministically reuse a confirmed-clean handle, and evict/close unconfirmed cleanup with no check-in or retry on another connection.
- Concurrent snapshot creation and transaction creation serialize/fail safely; no record attaches to an ambiguous segment.
- Historical/current effect, old/latest segment, void/correction, and same-day inclusion constraints produce one explainable balance.
- Concurrent confirm/payment/savings update/purchase completion/idempotency requests produce one valid result and one goal deduction.
- Session rotation/revocation, invitation consumption/account creation, and challenge consumption are race-safe.
- Deletion request/cancel/purge claiming and restore-tombstone behavior are race-safe and idempotent.
- Outbox insertion is atomic with applicable domain writes.
- Worker lease/crash/reclaim/retry/dead-letter and duplicate execution are safe.
- Repository methods cannot omit tenant context; RLS pool context does not leak between users if accepted.
- Dashboard/month/schedule queries reconcile to seeded source records.
- Query plans use intended indexes under representative per-user volume.

### 5.5 API contract and behavior tests

For every endpoint:

- authentication requirement and session expiry;
- authorization/ownership for own, another user’s, nonexistent, and mismatched parent IDs;
- valid minimum/typical/maximum request and response schema;
- missing/extra/wrong-type/out-of-range/unsupported currency/date/body-size cases;
- mass-assignment and derived-field manipulation;
- content type, method, pagination/range and error envelope;
- idempotency first/retry/different-payload/parallel/expired key;
- optimistic concurrency conflict;
- no secret/private/internal error leakage;
- cache and security headers as appropriate.

OpenAPI is checked against handlers and consumer expectations. Contract compatibility is tested across the intended rolling-deployment window.

### 5.6 Security tests

Security automation and manual review map directly to [the threat model](../security/THREAT-MODEL.md).

#### Authentication and abuse

- Credential-stuffing/brute-force patterns across IP/account/global dimensions.
- Registration/login/reset/OTP/invitation enumeration content/status/timing/rate behavior.
- Invitation expiry, wrong-email binding, revoke/use/replay, parallel consumption, digest-only storage, atomic account creation, and rejection of registration without a valid code even if the email appears in any operator dataset; no email-allowlist bypass.
- OTP/reset expiry, attempt, resend, supersession, replay, concurrency, immediate secret-delivery uncertainty, and provider failures; verify no secret enters the ordinary outbox.
- Argon2id parameter benchmark and maximum concurrent hashing behavior.
- Password reset/change session invalidation.

#### Session, browser, and client

- Session fixation, idle/absolute expiry, rotation across tabs, retired-token replay, logout current/all.
- Cookie flags/domain/path and no token in URL/storage/log/cache.
- CSRF from form/fetch and missing/forged token/origin; CORS preflight and credential rules.
- CSP/header/clickjacking/referrer/open-redirect/source-map tests.
- Service-worker/Cloudflare/browser cache inspection before/after logout/update.
- Stored/reflected/DOM XSS corpus and email-template injection.

#### Authorization and injection

- Complete BOLA matrix: every private resource × read/create/update/delete/action × two users × nested parent mismatch.
- SQL injection/filter/sort/search corpus; malformed UUID/JSON/prototype fields.
- Direct database/RLS permissions and operator role tests.

#### Privacy, deletion, and retention

- Request/cancel/purge state machine across the seven-day grace boundary, including recent-auth and concurrent login/write attempts.
- Accelerated-clock expiry tests for approved maxima: encrypted backups 90 days, application logs 90 days, and minimized security/audit events 24 months.
- Provider-side purge evidence; purpose-limited pseudonymized restore-exclusion entries; register access, key rotation, tamper/omission handling, expiry, legal-hold controls; and restored-backup re-deletion.
- Vietnam/SEA region configuration and documented cross-border/subprocessor boundaries after OQ-17 provider selection.

#### Data leakage and supply chain

- Canary values injected into secrets, notes, amounts, email, and errors; scan logs/error tracking/analytics/cache/build artifacts.
- Secret scanner, SAST, dependency/SBOM/license, container image scan.
- DAST against staging within approved rate limits.
- Manual code/config/IAM/provider review and focused penetration testing before external beta.

A scanner report is triaged by exploitability and context; zero scanner alerts alone is not proof of security.

### 5.7 End-to-end tests

Playwright (or selected equivalent) runs through the deployed browser/UI/API/database boundary with isolated users.

Critical journeys:

1. Single-use invite → registration/atomic consume → OTP verify → selected post-verification sign-in/session behavior → Vietnamese-first onboarding → aggregate account/initial snapshot.
2. Sign in → close/reopen context → resume session → logout/replay rejected.
3. Forgot/reset password → all old sessions rejected.
4. Global Add current expense on compact viewport → retry after simulated timeout → one current-impact record.
5. Add pre-snapshot historical expense → selected month changes but current balance remains fixed and labelled.
6. After `snapshot_correction.v1` is approved and the `SPEC-FIN-02` mechanism is evidenced, race a correction with a manual known-balance snapshot → exactly one winner; losing snapshot returns `FIN_SNAPSHOT_STALE_STATE` or losing correction returns `FIN_CORRECTION_STALE_STATE`, with no auto-reanchor/partial effect.
7. Flexible income + recurring salary explicit confirmation → exact monthly 4,630,000 VND example.
8. Recurring rent reaches 09:00 due/first-overdue stages but not paid → one notification/stage and explicit confirmation.
9. After `SPEC-DEBT-01` resolves blocked historical paths, debt create/payment/correction covers `DCT-01`–`DCT-09`; no component, interest, or outstanding is inferred.
10. Savings goal absolute current-amount update changes safe-to-spend but not cash/monthly flow.
11. Planned purchase completion creates exactly one expense and one user-confirmed goal scalar deduction (including zero/partial path).
12. Dashboard passes `STS-01`–`STS-15`, drills into source components, and explains snapshot anchor, historical-only records, projected-income exclusion, local month-end, and active goal reserve.
13. Cash-flow warning for 1,000,000 VND due versus 700,000 VND available.
14. Session revocation from another context.
15. Deletion request → authenticated cancellation race, or post-7-day purge/tombstone in accelerated test time.
16. Network loss/session expiry during form preserves safe draft and never claims save.
17. User A cannot reach User B snapshots, transactions, goals, or other private data through UI/deep links.

E2E tests are few, critical, deterministic, and backed by lower-level coverage—not a replacement for it.

### 5.8 UX, accessibility, and responsive testing

#### Automated

- axe-core on key pages/states.
- keyboard smoke flow.
- layout/visual regression at 320, 375/390, 768, 1024, 1280+ CSS px.
- text scaling/long-content/large-money fixtures.

#### Manual

- Keyboard-only and visible focus review.
- Screen reader: at minimum current VoiceOver/Safari and NVDA/Firefox or approved equivalents.
- 200% zoom and 400% reflow review.
- iOS Safari/PWA and Android Chrome/PWA keyboard, safe-area, orientation, date/numeric input, install/update/offline behavior.
- Color contrast, forced colors where relevant, reduced motion.
- Moderated usability tasks from the UX specification with representative beta users.

WCAG conformance is assessed by people plus tools. Core flow blocker/severe accessibility defects block release.

### 5.9 PWA and future mobile tests

MVP PWA:

- manifest/icon/start URL/display validity;
- install and uninstall on supported platforms;
- asset cache allowlist and authenticated route exclusion;
- offline shell/message with no queued financial write;
- update available during active form and safe activation;
- stale client/API compatibility;
- logout/back/cache/device-sharing inspection;
- no token/private data in Cache Storage/IndexedDB/service-worker messages.

Capacitor/native testing is out of MVP. If promoted, add platform unit/integration, secure storage, deep-link, lifecycle, permission, WebView, signing, store, and real-device tests before claiming support.

### 5.10 Performance, resilience, and abuse testing

The beta is small, but expensive or slow paths can still be attacked or regress.

Proposed service objectives under an agreed staging profile (warm service, representative dataset, normal network, 20 concurrent active requests unless a better measured model is approved):

| Measure | Proposed target |
|---|---|
| API read p95 | ≤ 500 ms server response for common Home/Activity/Schedule queries |
| API write p95 | ≤ 750 ms excluding external email; Global Add commits locally without waiting for provider |
| Error rate | < 1% non-user-error during controlled load |
| Page initial usable state | Define by device/network budget after prototype; measure Core Web Vitals, not an invented pass now |
| Worker normal reminder lag | ≤ 5 minutes from scheduled evaluation time under normal conditions |
| Recovery | RPO ≤ 24h / RTO ≤ 8h proposal, measured in drill |

Tests include:

- baseline/load/short spike/soak at multiple of expected 50-user behavior;
- login hashing concurrency and rate-limit behavior;
- dashboard/activity with representative years/records;
- recurrence/reminder catch-up after worker outage;
- database pool exhaustion, slow query, deadlock/lock timeout;
- email timeout/429/5xx after unknown acceptance;
- API/database temporary outage and process restart;
- large body/range/filter/idempotency-key abuse;
- resource monitoring and clean recovery after load.

Do not run uncontrolled load/DAST against production.

### 5.11 Backup, recovery, migration, and rollback tests

Before beta:

1. Create a production-like encrypted backup.
2. Restore to isolated environment with timed procedure.
3. Obtain the current independently protected restore-exclusion register, reapply deletion tombstones before activation, and prove purged users/financial data cannot be resurrected.
4. Verify schema/migration version, constraints, row counts, referential checks, user isolation, snapshot-segment balances, historical monthly reports, and representative financial reconciliations.
5. Start the exact application artifact against restored data and execute smoke journeys.
6. Verify backup/operator permissions, retention configuration, and audit logs.
7. Destroy restored data under procedure.
8. Record actual RPO/RTO evidence and gaps.

For each release with schema changes:

- migrate previous-release snapshot forward;
- run reconciliation/regression;
- run old/new app compatibility where rollout requires;
- rehearse app rollback and approved database roll-forward/back strategy;
- verify no long locks/unbounded backfill.

### 5.12 Required email and in-app notification tests

- Vietnamese authentication/security email content, escaping, plain-text/HTML accessibility, links, and minimal privacy.
- SPF/DKIM/DMARC and provider sandbox/domain configuration before Release Candidate.
- Secret-bearing immediate delivery uncertainty and non-secret outbox atomicity/idempotency.
- Email webhook signature/timestamp/replay/schema/idempotency where the selected provider uses callbacks.
- Eligible outgoing-obligation 7-day/3-day/due-today/first-overdue calculation at 09:00 user-local time; scheduled income receives no fixed-stage notification.
- `RCT-01`–`RCT-10` cover worker downtime, app closed at evaluation, delayed app return, late occurrence creation, timezone forward/backward changes, multiple missed stages, state resolution, retries, and channel boundaries.
- `SPEC-REM-01` must approve the one-stage-or-none catch-up/suppression policy; recovery never duplicates occurrence + stage and never creates a multi-stage burst.
- First-overdue does not repeat during long unresolved periods.
- Confirm/skip/cancel racing with reminder evaluation creates no stale authoritative state.
- Reading/dismissing, app close/reopen, or any email delivery result does not alter financial state or create reminder events.
- Unchanged month-end cash-flow warning is not spammed.
- No payment-reminder email, push, SMS, or permission path exists in MVP.

## 6. Test data and determinism

- Synthetic personas cover new user, income-heavy, irregular income, debt, multiple goals, overdue obligations, large amounts, empty data, and long localized labels.
- Factories create one user by default and require explicit second-user setup for isolation tests.
- Fixed clocks and injected IANA timezone enable month-end, leap, DST, and midnight tests.
- Random/property tests persist a failing seed.
- Email/provider adapters have deterministic fault modes: accepted, delayed, timeout-after-accept, transient failure, permanent failure, malformed/replayed webhook.
- No test secret resembles a production credential.
- Cleanup is scoped by run; parallel tests cannot share user/database state accidentally.

## 7. Browser/device matrix

Final versions are selected near release based on beta audience and current support. Minimum categories:

- latest and previous major Chrome/Edge desktop;
- latest and previous Safari desktop where available;
- current Firefox desktop;
- current iOS Safari and installed PWA on representative small/notched devices;
- current Android Chrome and installed PWA on representative small/medium devices;
- keyboard/mouse, touch, reduced motion, screen reader, and zoom modes.

Unsupported-browser behavior must be safe and understandable; it must not silently corrupt writes.

## 8. CI/CD test stages

### Pull request (fast gate)

- formatting/lint/types/architecture boundaries;
- unit/component tests and accessibility smoke;
- PostgreSQL integration/API tests in parallel groups;
- migration from baseline fixture;
- secret/SAST/dependency/license checks;
- production build and contract diff.

### Merge/main artifact gate

- full integration/security regression;
- container/image scan and artifact identification;
- E2E against ephemeral/deployed staging subset;
- visual/PWA smoke;
- publish evidence and immutable artifact.

### Staging promotion gate

- migration rehearsal;
- deployed headers/cookie/CORS/cache/health tests;
- provider-sandbox email/webhook tests;
- critical E2E, DAST, accessibility/responsive matrix;
- performance baseline comparison.

### Production promotion gate

- approved release checklist and risk register;
- backup/current restore confidence;
- migration/rollback plan and operator on call;
- cohort-specific go/no-go;
- post-deploy non-destructive smoke and monitoring confirmation.

## 9. Quality gates

A release is blocked when any applies:

- required specification/ADR unresolved for implemented behavior;
- failing or missing critical-flow test;
- unresolved critical/high security defect, data-isolation defect, or credential/session flaw;
- unexplained financial reconciliation mismatch;
- core WCAG blocker/severe issue;
- flaky critical test without equivalent reliable evidence;
- failed migration/restore/rollback rehearsal;
- missing observability/runbook/on-call ownership;
- performance/resource behavior exceeds approved limits with user or availability impact;
- legal/privacy/retention/provider decision missing.

Lower-severity accepted issues require owner, impact, workaround, expiry, and cohort review.

## 10. Defect severity

| Severity | Example | Release effect |
|---|---|---|
| S0 Critical | Cross-user disclosure/write, credential/token leak, unrecoverable corruption, malicious production control | Stop release/rollout; incident response |
| S1 High | Core financial wrong result, auth bypass, duplicate payment/transaction, backup cannot restore, core flow inaccessible | Block release/cohort expansion |
| S2 Medium | Recoverable non-core malfunction, material UX confusion, limited accessibility issue | Fix or explicit time-bounded acceptance before cohort decision |
| S3 Low | Cosmetic/non-blocking issue with safe workaround | Track and prioritize by evidence |

Security severity also considers exploitability and user scope; labels do not downgrade a threat mechanically.

## 11. Evidence and reporting

Retain for each release:

- commit/image/schema versions and environment;
- CI and test reports with timestamps/config;
- requirement/threat traceability matrix;
- migration/rollback and backup/restore records;
- DAST/SAST/dependency/manual security triage;
- accessibility/manual device/usability findings;
- performance profile/results;
- open defects/risk acceptances;
- release approvals and cohort decision.

Artifacts must not contain secrets or real financial data. Retention follows the approved security evidence policy.

## 12. Beta monitoring as validation

For each 5 → 10 → 25 → 50 cohort, review:

- error and latency rates;
- financial write failures/idempotency conflicts/reconciliation alerts;
- auth failures/rate limits/suspicious session activity;
- database pool/storage/slow query behavior;
- worker backlog/email failures;
- PWA/client release mix;
- accessibility/UX support reports;
- feature usage using privacy-safe events;
- incidents, near misses, and user feedback.

Monitoring can reveal defects but does not replace pre-release tests. Cohort expansion is an explicit decision, never automatic.

## 13. Strategy approval blockers

Round 3 defines the required suites in §3.5, but no suite has been executed and no authorized decision has been supplied. Therefore all pre-implementation rows remain OPEN:

| Priority | Blocker(s) | Test-strategy exit condition | Status |
|---|---|---|---|
| AUTH | `SPEC-AUTH-01`, `SPEC-AUTH-02` | Approved outcomes/values plus complete applicable `AUTH-VRF` and `AUTH-POL` evidence | OPEN |
| FIN | `SPEC-FIN-01`, `SPEC-FIN-02` | Owners approve `snapshot_correction.v1` and `account_financial_serialization.v1`; H–J/`FIN-COR` remain reproducible; real-PostgreSQL `FIN-RACE-01`–`08` evidence on Supabase proves ADR-009, idle-confirmed cleanup, deterministic clean reuse, and eviction/no-retry for unconfirmed cleanup | OPEN |
| DEBT | `SPEC-DEBT-01` | DCT-08/09 and `DEBT-HIST` outcomes are exact and preserve no-inference | OPEN |
| SCHEDULE | `SPEC-SCH-01` | `SCH-BND` results cover all approved boundary/edit/race choices | OPEN |
| REMINDER | `SPEC-REM-01` | RCT-04–07 and `REM-REC` use one approved tuple with no burst | OPEN |
| SECURITY | `SPEC-SEC-01`, `SPEC-SEC-02`, `SPEC-DEL-01` | `SEC-RLS`, `SEC-HIST`, and `DEL-LIFE` evidence passes for approved policies | OPEN |
| UX | `SPEC-UX-01` | Complete versioned `UX-EVID` manifest and named acceptance | OPEN |
| GOVERNANCE | `SPEC-GOV-01` | Complete `GOV-EVID`, assignments, physical limits, trace and sign-offs | OPEN |

`STS-01`–`STS-15` already define the accepted safe-to-spend formula but have no execution evidence. `RC-PROV-01` and `BETA-LEGAL-01` remain later gates for provider, residency, retention/deletion, production-like operation, legal/privacy approval, performance, RPO/RTO, vulnerability, release and cohort evidence.

**Implementation Gate: CLOSED.** A specified test, empty report, or documentation consistency check is not an executed PASS.
