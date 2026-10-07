# SPEC-FIN-01 — Snapshot Correction Semantics

**Status:** Proposed decision for GitHub Issue #1; owner approval and evidence pending<br>
**Policy identifier:** `snapshot_correction.v1`<br>
**Date:** 2026-10-07<br>
**Accountable owner:** Product Owner<br>
**Mandatory co-approvers:** Financial Integrity Owner, Data Owner, Security Owner<br>
**Related issue:** [GitHub Issue #1](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/issues/1)<br>
**Blocker state:** OPEN — approval/evidence ready<br>
**Implementation Gate:** CLOSED

## 1. Purpose and decision status

This specification defines the proposed MVP transaction-correction and void semantics required by `SPEC-FIN-01`. It makes prior-segment, cross-segment, reporting, linkage, idempotency, and observable concurrency outcomes deterministic without selecting the PostgreSQL serialization primitive reserved for `SPEC-FIN-02`.

The policy is deliberately conservative:

- corrections preserve the original snapshot segment and balance-effect classification;
- prior evidence is never overwritten;
- moving a transaction to another segment or changing `historical`/`current` effect is rejected as one correction;
- a closed prior segment can be corrected for reporting and audit purposes, but it can never be replayed into current balance; and
- a snapshot/correction race never auto-reanchors or silently retries against a different anchor.

This document is a decision candidate for review in the pull request linked from Issue #1. Creating the document, commit, or pull request is not owner approval. `SPEC-FIN-01` remains OPEN until mandatory owners approve it and the governance record links that approval. `SPEC-FIN-02` remains independently OPEN, and the global Implementation Gate remains CLOSED.

## 2. Normative terms

- **Source transaction:** the posted transaction selected for correction or void.
- **Replacement transaction:** the new posted transaction created by a correction.
- **Correction:** one atomic operation that voids the source transaction and creates exactly one replacement transaction.
- **Standalone void:** one atomic operation that voids the source transaction without a replacement.
- **Correction chain:** the append-only sequence connected by `supersedes_transaction_id`; it has at most one posted terminal transaction.
- **Original segment:** the immutable `balance_snapshot_id` attached to the source transaction.
- **Original effect:** the immutable `balance_effect` (`current` or `historical`) attached to the source transaction.
- **Closed segment:** a snapshot segment older than the latest authoritative snapshot.
- **Cross-segment transition:** any request that would change snapshot anchor, change balance effect, or make the replacement date/inclusion facts invalid for the original segment/effect.
- **Owning-domain link:** a schedule occurrence, debt payment, or planned-purchase completion whose integrity depends on the transaction.

`MUST`, `MUST NOT`, and `MAY` are normative.

## 3. Chosen record model

### 3.1 Correction

Every supported correction MUST use append-only **void + replacement** semantics in one database transaction:

1. lock/validate the source and relevant owned/link state under the approved concurrency mechanism;
2. verify that the source is the currently posted terminal transaction in its correction chain;
3. mark the source `voided` with actor, reason, timestamp, and correlation metadata;
4. create one posted replacement with `supersedes_transaction_id = source.id`;
5. preserve the source `user_id`, `account_id`, `currency`, `balance_snapshot_id`, and `balance_effect` exactly;
6. update any permitted owning-domain pointer atomically;
7. write audit and idempotency result metadata; and
8. commit all effects or none.

No transaction field is corrected in place. A replacement may itself be corrected later, producing a linear chain. Branching successors, more than one posted terminal transaction, and correction of a non-terminal/voided source are rejected.

### 3.2 Standalone void

A standalone void preserves the source row, marks it voided with a required reason/actor/time, creates no replacement, and removes its effective contribution from permitted aggregates. It is supported only when §7 permits the link transition. Repeating the same idempotent void returns the original result and cannot reverse the effect twice.

### 3.3 Editable and immutable facts

A replacement MAY change only:

- `amount_minor`;
- `occurred_on`, when §6 still classifies it in the original segment/effect;
- category and expense classification;
- the orthogonal unexpected flag;
- bounded note; and
- other non-authority presentation metadata explicitly approved by the transaction schema.

A correction MUST NOT change:

- owner or account;
- currency;
- income/expense direction (`kind`);
- snapshot anchor;
- `current` versus `historical` balance effect;
- `already_included_in_snapshot` meaning; or
- owning-domain identity/link except for the permitted atomic pointer transfer in §7.

Changing income to expense, expense to income, account/currency, anchor, or balance effect requires a deliberate standalone void followed by a separately confirmed new transaction where the owning-domain rules permit it. It is not represented as one correction.

## 4. Historical evidence and audit presentation

The source transaction and every earlier chain member MUST remain queryable; their original financial facts are immutable evidence, while the allowed `posted` → `voided` status transition is itself retained and audited. Normal aggregates count only the one posted terminal replacement, if any; voided rows are excluded from financial totals but remain visible in correction history.

Each correction/void record MUST retain or reference:

- source and replacement IDs, if applicable;
- source and replacement values for every changed field;
- original snapshot ID/as-of time and whether that segment was latest or closed at commit;
- original balance effect and inclusion classification;
- actor, required bounded reason, request/correlation ID, and timestamps;
- idempotency key scope and request digest/result reference;
- expected and committed versions/concurrency context;
- owning-domain link before/after; and
- current-balance and report-period consequences shown at confirmation.

Activity SHOULD show the posted terminal transaction with a `Corrected` marker. Detail MUST expose the complete chain, including standalone voids, without presenting a voided source as active. Audit/security logs use safe identifiers and result codes rather than unrestricted notes or full financial payloads.

## 5. Balance and report effects

### 5.1 Latest-segment current transaction

Correcting a posted `current` transaction attached to the latest snapshot removes the source effect and applies the replacement effect exactly once. The current-balance delta is:

```text
signed(replacement) - signed(source)
```

where income is positive and expense is negative. A standalone void applies `-signed(source)` exactly once.

Example: latest snapshot `1,000,000`; posted current expense `300,000`; correction to `250,000` produces current balance `750,000`, never `450,000`, `700,000`, or `1,050,000`.

### 5.2 Latest-segment historical transaction

Correcting or voiding a `historical` transaction never changes current balance. Period/category reports replace or remove only the active reporting fact.

### 5.3 Closed prior segment

Correcting or voiding any transaction attached to a closed segment never changes authoritative current balance, regardless of the source’s original `current` or `historical` effect. The latest snapshot remains the sole current anchor.

Example: an older segment contains a `300,000` expense, then a newer authoritative snapshot is `900,000`. Correcting the old expense to `250,000` leaves current balance exactly `900,000`. The applicable period report replaces `300,000` with `250,000` and exposes the correction marker/history.

### 5.4 Reporting

Monthly/category reports aggregate the posted terminal transaction by its approved replacement `occurred_on` and current fields. A correction may therefore change one or two historical report periods, but it never erases the chain. Any report result derived from a corrected chain MUST expose an amended/corrected indicator and source drill-down; no report-view tracking is implied.

Safe-to-spend receives no special correction rule. It recalculates from the authoritative latest-segment current balance and other `safe_to_spend.v1` inputs after commit. Prior-segment/historical corrections cannot enter current balance indirectly.

## 6. Segment/effect transition matrix

| Source context | Requested replacement | Result | Current-balance effect |
|---|---|---|---|
| Latest segment + `current` | Same anchor/effect; corrected date remains valid for that segment | Supported through void + replacement | Apply replacement minus source exactly once |
| Latest segment + `historical` | Same anchor/effect; corrected date/inclusion remains historical for that anchor | Supported through void + replacement | Zero |
| Closed segment + `current` | Same original anchor/effect; corrected date remains inside that segment’s valid interval | Supported through void + replacement | Zero |
| Closed segment + `historical` | Same original anchor/effect; corrected date remains valid as already included in that anchor | Supported through void + replacement | Zero |
| Any segment/effect | Requested `balance_snapshot_id` differs | Reject `FIN_CORRECTION_CROSS_SEGMENT_UNSUPPORTED`; no write | Zero |
| Any segment/effect | Requested `balance_effect` or inclusion meaning differs | Reject `FIN_CORRECTION_EFFECT_CHANGE_UNSUPPORTED`; no write | Zero |
| Any segment/effect | Corrected date would require another anchor/effect under snapshot/date rules | Reject `FIN_CORRECTION_CROSS_SEGMENT_UNSUPPORTED`; no write | Zero |
| Any segment/effect | Owner/account/currency/kind differs | Reject `FIN_CORRECTION_INVALID_TRANSITION`; no write | Zero |

For a `current` transaction in segment `S`, its corrected date must remain after/valid against `S` and before the next snapshot boundary when one exists, subject to the same-day explicit inclusion rule. For a `historical` transaction, its corrected date/inclusion must remain valid as already included in `S`. The server derives validity from authoritative snapshot facts; the client cannot choose a segment/effect field.

A rejected cross-segment request does not mutate the source. If the user is describing a genuinely different event, they may deliberately void the source where §7 permits and create a separate new transaction through the normal add flow. The two actions have separate consequence previews and are not disguised as one atomic correction.

## 7. Owning-domain link behavior

| Source link | Generic correction | Generic standalone void |
|---|---|---|
| No owning-domain link | Supported when all other rules pass | Supported |
| Schedule occurrence only | Supported only when direction/currency are unchanged; the occurrence remains confirmed and its `confirmed_transaction_id` atomically points to the replacement | Rejected with `FIN_CORRECTION_LINKED_DOMAIN_REQUIRED`; a confirmed occurrence may not be orphaned |
| Debt payment, including a scheduled debt occurrence | Generic path rejected; use `UF-DEBT-03`. Its cash transaction must still obey this specification. If `SPEC-DEBT-01` blocks the outstanding result, the whole domain correction is rejected with no partial cash correction | Generic path rejected; use the debt correction/void flow and its no-inference rules |
| Planned-purchase completion | Generic path rejected because purchase status and any savings-goal deduction require one owning-domain correction contract, which is not in MVP | Rejected; no transaction, purchase, or goal state changes |
| More than one incompatible owning-domain link | Reject as an integrity error and emit a sanitized reconciliation signal | Reject as an integrity error and emit a sanitized reconciliation signal |

A schedule-only correction transfers the active pointer but preserves the old pointer relationship in append-only audit evidence. Expected schedule values remain unchanged; the replacement supplies the confirmed actual amount/date. Any stale occurrence version rejects the whole correction.

Rejecting a linked generic path is an explicit MVP safety behavior, not permission to detach a link, synthesize a domain result, or partially apply a correction.

## 8. Consequence preview and user confirmation

Before commit, the UI/API contract MUST provide a preview generated from authoritative server state. It includes:

- source and proposed replacement amount/date/classification;
- source snapshot anchor/as-of, original effect, and latest-versus-closed label;
- current balance before, delta, and after, or an explicit `No current-balance change` result;
- report periods/categories added, removed, or changed;
- owning-domain link and whether the operation must use another flow;
- fixed rejection reason for an unsupported transition; and
- a state/version context that commit must revalidate.

A bounded correction reason is mandatory. Confirmation copy MUST distinguish `Correct transaction` (void + replacement) from `Void transaction` (no replacement), explain that evidence remains, and never imply bank/lender verification.

## 9. Concurrency and idempotency contract

### 9.1 Preconditions

Commit MUST revalidate, in one atomic operation:

- authenticated owner/account/currency;
- source is still posted and terminal;
- source version matches preview;
- latest snapshot ID and all financial state relevant to the preview match preview;
- requested date remains valid for the original segment/effect;
- owning-domain links and their relevant versions match preview; and
- idempotency key/request digest is compatible.

Any stale precondition returns HTTP `409` with `FIN_CORRECTION_STALE_STATE`, commits nothing, and requires refetch + new preview + deliberate resubmission. The server MUST NOT auto-reanchor, silently change effect, or automatically replay the user’s correction against refreshed state.

### 9.2 Snapshot/correction race

Snapshot creation and correction/void share one per-account logical serialization boundary:

- **Correction wins:** correction commits against the previewed latest anchor; the racing snapshot request commits nothing and returns HTTP `409` + `FIN_SNAPSHOT_STALE_STATE`, then requires deliberate retry from refreshed state.
- **Snapshot wins:** snapshot commits as the new authoritative anchor; the correction commits nothing and returns HTTP `409` + `FIN_CORRECTION_STALE_STATE`. On deliberate retry, the source is now in a closed segment and §5.3 applies.
- **Forbidden outcome:** both requests succeed from the same stale state, the correction silently moves to the new anchor, or both source and replacement effects remain active.

This defines externally observable behavior and test oracles. `SPEC-FIN-02` remains OPEN to select and prove the PostgreSQL lock/isolation/version mechanism that enforces the boundary.

### 9.3 Competing correction/void requests

When two requests target the same posted terminal transaction, at most one commits. The loser receives `FIN_CORRECTION_STALE_STATE`; it cannot create a branch or void the replacement. The same rule applies when a linked-domain version changes concurrently.

### 9.4 Idempotent retry and uncertain response

- Same idempotency key + same canonical request returns the original committed result, including source/replacement IDs and consequences.
- Same key + different request digest is rejected and never mutates state.
- Timeout after commit is recovered through idempotency lookup; retry cannot create another replacement.
- A stale/conflict result is stable for that key; a newly previewed request uses a new key.

The exact retention period and physical idempotency/serialization storage remain governed by approved security/data limits and `SPEC-FIN-02`.

## 10. Reproducible acceptance scenarios

All amounts are integer VND units. Every case asserts ownership, audit chain, one terminal posted result, report effect, idempotency, and no partial write.

| Case | Fixture/action | Required result |
|---|---|---|
| `FIN-COR-01` — latest amount correction | Latest snapshot `1,000,000`; current expense `300,000`; correct to `250,000` | Source voided, one replacement posted on same anchor/effect; current balance `750,000`; report contains only `250,000` active effect |
| `FIN-COR-02` — closed-segment correction | Old segment expense `300,000`; newer snapshot `900,000`; correct old expense to `250,000` | Current balance remains `900,000`; old report effect becomes `250,000`; source/replacement chain visible |
| `FIN-COR-03` — historical correction | Latest snapshot `1,000,000`; historical expense `300,000`; correct to `250,000` | Current balance remains `1,000,000`; report uses `250,000`; history retained |
| `FIN-COR-04` — valid date/report move | Closed-segment transaction date changes between two months while remaining valid in the original segment/effect | Current balance unchanged; source month removes and destination month adds only replacement effect; both show correction trace |
| `FIN-COR-05` — date crosses anchor | Corrected date would require another snapshot segment | `FIN_CORRECTION_CROSS_SEGMENT_UNSUPPORTED`; source remains posted; no aggregate/link change |
| `FIN-COR-06` — effect/anchor/kind tamper | Client sends a different anchor, `historical`/`current`, inclusion meaning, account, currency, or kind | Stable invalid-transition error; no write; sanitized signal for authority-field tampering where appropriate |
| `FIN-COR-07` — standalone void | Void an unlinked latest current expense; repeat after uncertain response | Source voided once; current balance reverses source once; no replacement; same-key retry returns original result |
| `FIN-COR-08` — links | Correct a schedule-only transaction; then attempt generic debt and purchase corrections | Schedule pointer transfers atomically; debt/purchase requests are rejected/delegated exactly per §7; no orphan/partial state |
| `FIN-COR-09` — idempotency | Parallel same-key/same-payload requests, then same key/different payload | Exactly one chain/result; compatible retries return it; different payload is rejected |
| `FIN-COR-10` — concurrency | Race correction against snapshot, another correction, and link-state update | Exactly one allowed winner per §9; a losing snapshot gets `FIN_SNAPSHOT_STALE_STATE`, other stale requests get `FIN_CORRECTION_STALE_STATE`; no auto-reanchor, branch, duplicate, or partial write |

Snapshot scenario H maps to `FIN-COR-01`; scenario I maps to `FIN-COR-02`; scenario J’s transition branch maps to `FIN-COR-05`/`06`, while its race branch maps to `FIN-COR-10` and remains dependent on `SPEC-FIN-02` mechanism evidence.

## 11. GitHub Issue #1 acceptance trace

| Issue acceptance criterion | Specification evidence |
|---|---|
| Historical evidence must not be silently rewritten | §§3–4; append-only source/replacement chain and audit presentation |
| Current balance remains based on latest authoritative segment | §5; closed-segment corrections have zero current-balance effect |
| Cross-segment behavior explicitly defined | §6; anchor/effect/date transitions are deterministically rejected |
| Concurrency behavior explicitly defined | §9; winner/loser/conflict/idempotency contract; physical primitive remains `SPEC-FIN-02` |
| Related documents synchronized | PRD, User Flows, Architecture, Database, Security, UX, Test Strategy, Release Checklist, Decision Log, blocker/governance registers |
| Tester can derive reproducible cases | §10 and the synchronized H–J / `FIN-COR-01`–`FIN-COR-10` matrices |

## 12. Approval and gate conditions

`SPEC-FIN-01` may move from OPEN to RESOLVED only when:

1. the Product Owner and mandatory Financial Integrity, Data, and Security co-approvers approve this exact policy/version;
2. approval date, approver identities, source commit, and pull request are recorded in the Approval and Evidence Register;
3. all synchronized documents contain no alternate correction behavior;
4. reviewers confirm that H–J and `FIN-COR-01`–`FIN-COR-10` are reproducible test specifications; and
5. any requested policy change is applied consistently before approval.

Runtime test execution is not claimed by this documentation task. `SPEC-FIN-02`, every other open blocker, and the global Implementation Gate remain unaffected and CLOSED.
