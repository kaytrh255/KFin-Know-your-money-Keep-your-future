# A-1 decision packet — `SPEC-AUTH-02` reset-budget scope (F-3)

> ## ⚠ REQUEST ONLY — NOT APPROVED, NOT ACCEPTED, NOT ADOPTED
>
> This packet asks three named roles for three decisions. Every approval field below is **blank**, every
> status is **pending**, and no name, date or signature has been entered. It was prepared by the same
> implementation session that wrote the code under review, acting **for — not as —** the owners: the person
> who implemented A-1 is not the person who authorises it.
>
> **The normative amendment text is §2.4 of
> [`2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md`](2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md).** This
> packet is the review-ready rendering of it — the behaviour, the cost, the evidence, the residual and the
> exact request — and it quotes that wording verbatim in §8.1. If the two ever disagree, §2.4 governs and
> this packet is wrong.
>
> **F-3 is not closed by this packet.** It is mitigated for the remote vector in code and remains **OPEN**
> until A-1 is signed, the residual in §5 is accepted or controlled, and the operator response in §6 is
> adopted. KFin remains **NOT READY FOR RELEASE**.

**Date prepared:** 2026-10-13 (Asia/Saigon) · analysis and evidence gathered 2026-10-12/13 UTC
**Prepared by:** implementation review session (Arena agent), acting for the owners
**Implementation under review:** branch `arena/bfaf5019-kfin-know-your-money-keep-your`, PR #10, unmerged;
fix `afc5201`, records `dc78243`, regression suite `987b28e`
**Finding:** F-3 — an unauthenticated caller could exhaust a victim's password-reset budget
**Evidence record:** [`2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md`](2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md) §§A.1–A.7
**Environment:** disposable local PostgreSQL 17.6 (`synchronous_commit = on`, `fsync = on`); no production or
shared database contacted; no secret written into any record, log, or commit

---

## 1. The decision, in one page

**What is being asked.** Approve **amendment A-1**, which changes one dimension of an approved-behaviour
candidate: the *scope and keying* of the cumulative reset failed-verification budget (currently specified as
"per-account"; shipped as per-account-per-caller-network), and the operator-only security event written when
that budget tips over.

**Why a decision is needed at all.** F-3 was measured, not hypothetical: with the budget keyed on the address
alone, ten unauthenticated submissions against a known address — from anywhere, holding no code — answered
`429` to the address owner's own correct code for the rest of the window. The spend cannot be moved after the
account lookup without creating an existence oracle, so the key, not the ordering, had to change. The fix
(`afc5201`) is implemented and regression-proven, and it changes a behaviour dimension `SPEC-AUTH-02` is the
decision for. Shipping it without this request would be a silent policy edit; hence the request.

**What approving A-1 does.** It authorises the shipped keying and the event, with the residual in §5 stated
as the accepted limitation.

**What it does not do.** It does not close F-3 (the residual and the operational response are separate
decisions, §8.2/§8.3), does not change any limit, window, cooldown, issuance cap, spend point, response body
or schema, and does not touch F-8 or D5.

**What a rejection means.** The code must revert to the pre-`afc5201` keying or another authorised option
must ship; F-3 stays a merge blocker, and the whole system keeps the measured denial of password recovery.

**Cost of the decision.** Three signatures (§8), and one measurable defence-in-depth weakening: the
account-wide hourly ceiling on wrong-code submissions goes from **10 to 15** in the worst case analysed in
§2.3 — against a 10⁶ code space, a ten-minute challenge lifetime, and an account-level issuance cap of three
challenges per hour. That number is the honest price of removing the denial, and it is the number to weigh.

---

## 2. The behaviour change, exactly

### 2.1 What changes

| Dimension | Before (`5629fa2`) | After (`afc5201`) |
|---|---|---|
| `reset_target` counter key | `digest('abuse:reset_target', address)` | `digest('abuse:reset_target', '<address>\|<ip-prefix-digest>')` (IPv4 /24, IPv6 /48) |
| `verification_target` cumulative budget key | `digest('abuse:verification_target', address)` | `digest('abuse:verification_target', '<address>\|<ip-prefix-digest>')` |
| Limit and window | 10 failures per 15 min (`reset_target`); 10 per 1 h (`verification_target`) | **Unchanged** |
| Spend point | Unconditional, **before** any account or challenge lookup | **Unchanged** — this is what keeps the endpoint from becoming an existence oracle |
| `reset_ip` throttle | 10 per 15 min per network prefix | **Unchanged** |
| Per-challenge attempt cap | 5 | **Unchanged**, still account-scoped |
| Resend cooldown / issuance caps | 60 s · 3 per account per hour · 6 per account per 24 h | **Unchanged and still account-wide** (`withinIssuanceCap` counts `WHERE user_id = $1`) |
| Security event on exhaustion | None | One operator-only `password_reset_failed` / `outcome = 'blocked'` / `metadata.reason = 'reset_budget_exhausted'` / `visibility = 'operator'`, on the `count === limit + 1` transition only |
| Caller with no resolvable address | Address-only key (the pre-fix state) | **Unchanged** — falls back to the same key; `reset_ip` is skipped for that request. See §5.2 |
| Schema, migrations, configuration values | — | **None changed**; existing counters age out |

### 2.2 What this restores, and what it does not

Restored: a third party on another network can no longer deny the address owner's recovery. The owner's own
network keeps its own bucket, so their correct code still completes (asserted, §4).

Not restored, and not claimed: an attacker *inside the victim's* /24 or /48 shares that bucket (§5.1).

### 2.3 The one thing that gets weaker — stated plainly

The account-global counter was a defence-in-depth ceiling on *all* wrong-code submissions against one account,
regardless of source network.

| | Pre-fix binding ceiling | Post-fix binding ceiling |
|---|---|---|
| Evaluated wrong-code submissions per account per hour | **10** (account-global counter) | **15** (three challenges × five attempts — the account-scoped issuance caps and per-challenge cap) |
| Per account per 24 h | 30 (issuance caps, unchanged) | 30 (unchanged) |
| Per account per network per hour | 10 | 10 (unchanged) |

Reaching 15 requires the attacker to obtain all three hourly challenges from at least two networks, and every
submission still fails once the challenge retires — measured directly: across three attacking networks, only
**five** submissions were ever evaluated against the code digest (§4, case 5). Against a 10⁶ space and a
ten-minute challenge lifetime, the additional five guesses per hour are not a materially different
brute-force posture; they are, however, a real reduction in defence in depth, and the signer should accept it
knowingly rather than discover it later.

Mail cost is not weakened: a challenge — and therefore a message — is issued only within the account-wide
caps (3/h, 6/day), so a flood from many networks cannot multiply reset mail to one address.

---

## 3. Compatibility

| Surface | Effect | Evidence |
|---|---|---|
| Existing tests | None weakened — the regression suite is **+350 / −0** lines on the pre-fix file, and all pre-existing cases still pass | `git diff --numstat 5629fa2 987b28e -- packages/database/test/auth-access.integration.test.ts` |
| Application code | One helper, one optional callback, three call-site key changes; `+89 / −4` lines in `auth-repository.ts` | commit `afc5201` |
| API contract, statuses, bodies, timing | Unchanged in shape; the event is operator-only and never client-visible | `recordBudgetExhausted` writes `user_id = NULL`, `visibility = 'operator'` |
| Schema / migrations | None. `security_events` already allows the type, outcome and metadata keys (the `0004` secret-key CHECK forbids `password/otp/code/token/secret/sessionToken`; A-1 uses none) | migration `0004` |
| `SEC-AUTH-20` | **Diverges.** The approved text says "a cumulative **per-account** failed-verification budget"; the branch implements per (account, caller network). Disclosed, not silently reconciled: a **pending** pointer sits under the requirement and the register row, and the replacement sentence waits in §2.4 | `docs/security/SECURITY-REQUIREMENTS.md` |
| Pinned authoritative documents | **Not touched** — 0 files changed among the five pinned documents and the evidence harness between `5629fa2` and `987b28e` | see §8.4 for the post-approval procedure |
| Operational surface | A new event will exist with **no consumer**: nothing watches, alerts on, or rotates it today | §6 |

---

## 4. Evidence (executed, not asserted)

Six of the eight F-3 cases fail against the pre-fix source (`5629fa2`) and pass with the fix; the two that
pass in both are the ones asserting properties the fix must *preserve*.

| # | Case | Pre-fix | Post-fix |
|---|---|---|---|
| 1 | the flood spends the attacker's own budget and the victim still completes the reset | **FAIL** (`AUTH_RATE_LIMITED` on the victim's completion — F-3 mechanised) | pass |
| 2 | a flood on the request endpoint cannot stop the victim completing a reset | **FAIL** | pass |
| 3 | answers known and unknown addresses identically at the exhaustion boundary | pass (property to preserve) | pass |
| 4 | counts concurrent flood requests without losing one (12 concurrent, 2 networks) | **FAIL** (length 3, expected 6) | pass |
| 5 | a distributed flood across several networks is still bounded by the challenge, not by geography | **FAIL** (the victim's fresh code is refused) | pass |
| 6 | records one operator-visible event when a budget tips over, not one per request | **FAIL** (no event existed) | pass |
| 7 | residual: without a resolvable caller address the budget falls back to the account-only key | **FAIL** (the addressless flood consumed an addressed caller's budget) | pass |
| 8 | residual: an attacker sharing the victim's network still shares the bucket | pass (true in both versions — the limitation) | pass |

Suite: **8 cases**, `npx vitest run packages/database/test/auth-access.integration.test.ts -t "F-3"` →
`8 passed`. Whole gate on this tree: `pnpm run check` **exit 0** — `evidence:check` clean, `evidence:test`
**17/17**, `typecheck` clean, vitest **771 passed / 38 files** against disposable PostgreSQL 17.6 with the
non-production target flag, and `pnpm run web:build` exit 0. CI `verify` on PR #10: **success**.

*Reproduction note for reviewers:* `evidence:test` compares the pinned documents against the frozen commit
`a48d2c5…`, which a shallow clone does not contain — a shallow checkout fails four harness tests that have
nothing to do with F-3. Fetch full history first (`git fetch --unshallow`).

---

## 5. Residuals: what is demonstrated, and what is not

Each row separates the **behaviour we executed and observed** from the **conditions we have not tested**.

### 5.1 A caller sharing the victim's /24 (IPv4) or /48 (IPv6)

- **Demonstrated:** a caller inside the victim's prefix writes and exhausts the *same* bucket; the victim's
  own correct code is then throttled — asserted by case 8, deliberately, so the limitation cannot later be
  mistaken for an oversight.
- **Untested:** how much collateral exposure this is *in practice* for the beta — how many distinct beta
  users share a /24 under Vietnamese ISP/CGNAT aggregation, and whether a *legitimate* co-tenant's own
  retries could exhaust the bucket. No measurement exists, and no data supports a claim in either direction.
- **Reachability note:** the attacker must already be inside the victim's network path; this is the residual
  F-3 does **not** remove.

### 5.2 Requests where the caller's network address cannot be resolved

- **Demonstrated:** with no address, `targetNetworkKey` degrades to the bare target and `reset_ip` is skipped
  (`registerAbuseAttempt` returns early on an absent scope value). Any number of addressless callers
  therefore share one account-only bucket, and the per-network request throttle does not apply to them.
  Case 7 asserts the fallback, and that the same account reset *from a real network* is unaffected.
- **Untested / undecided:** whether that state is reachable in the deployed configuration at all. The API
  builds Fastify **without** `trustProxy`, so `request.ip` is the socket peer address and a normal HTTP
  request always carries one — the null path is a hardening gap rather than a measured hole. No test
  exercises it *through the API*, only through the repository.
- **Deployment dependency worth flagging:** if the app is later placed behind a reverse proxy and
  `trustProxy` is enabled without a trusted-hop policy, `request.ip` would follow `X-Forwarded-For`, and a
  caller could then choose its own "network" bucket — which would defeat the network scoping. That decision
  belongs to the deployment architecture (`ADR-007` contemplates proxies but no trust policy exists); it is
  **not** a flaw in A-1, and it must be made deliberately.

### 5.3 Concurrent and distributed abuse

- **Demonstrated:** 12 concurrent submissions across two networks are counted exactly once each, with no lost
  update (case 4); three networks each throttled on their own bucket, exactly one submission retiring the
  challenge, and only five submissions across all networks ever evaluated against the digest (case 5).
- **Untested:** behaviour under large-scale distribution — hundreds of networks, repeated challenge rearming,
  and any edge protection. **None is configured in the repository** (no CDN/WAF/rate-limit layer, no alerting
  consumer): the beta deployment's edge posture is undecided, so "distribution is bounded" rests on the
  account-scoped caps demonstrated here, not on any network-level defence.

### 5.4 Detection coverage (the R1 event)

- **Demonstrated:** exactly one event per tip-over regardless of flood length (case 6); the event carries
  keyed digests and bounded metadata, and `security_events` is append-only by trigger, so it cannot be edited
  or deleted afterwards.
- **Untested/known gap:** the event fires only on the transition into exhaustion. An attacker who stays just
  under the limit (nine requests per window) is never recorded. That is deliberate — one event per tip-over,
  not one per request — but it means **absence of events is not absence of probing**, and nothing consumes
  the event today (§6).

### 5.5 Not weakened, for completeness

Anti-enumeration (case 3: identical outcome sequences for known and unknown addresses through the boundary);
per-challenge cap, cooldown, issuance caps, `reset_ip` (unchanged code paths, cited in §2.1); mail volume per
address (bounded by the account-wide issuance caps). The unimplemented *global* email-cost cap that
`SEC-AUTH-20` mentions is a **pre-existing** gap, outside A-1, and is not claimed here as covered.

---

## 6. Operational response for the `reset_budget_exhausted` event — **PROPOSED, NOT ADOPTED**

> This section defines the response so a decision can be taken. It is **not** an adopted runbook: the roles
> it names are register roles, not people, and every register role assignment is currently `Unassigned`
> (`APPROVAL-AND-EVIDENCE-REGISTER.md` §3, `SPEC-GOV-01` OPEN). No named owner is invented here, and nothing
> below may be treated as an operating procedure until an authorized owner adopts it in writing.

### 6.1 Accountable roles (roles, not names)

| Role | Responsibility for this event | Register state |
|---|---|---|
| **Security Owner** | Owns triage policy, classification, and the decision to escalate or accept | `Unassigned` |
| **Operations Owner** | Owns execution: investigation, the recovery action, operator logging | `Unassigned` |
| **Product Owner** | Informed where a beta user is affected (support messaging, beta communications) | `Unassigned` |
| **Privacy / Legal Owner** | Consulted where an event involves personal data of a third party, or a disclosure request | `Unassigned` |

### 6.2 Triage — steps and the exact queries

1. **Confirm** the event: `event_type = 'password_reset_failed'`, `outcome = 'blocked'`,
   `metadata->>'reason' = 'reset_budget_exhausted'`, and read `metadata->>'scope'`
   (`reset_target` = the 15-minute request bucket; `verification_target` = the 1-hour cumulative budget).
2. **Bound the query.** Never scan the whole table: the events carry keyed digests only, and the operator
   either has a user conversation to anchor on (recompute the digest from the address) or inspects a bounded
   recent window.

```sql
-- one address, when support provides it (target_digest is indexed)
SELECT occurred_at, correlation_id, ip_prefix_digest, metadata
  FROM security_events
 WHERE event_type = 'password_reset_failed'
   AND target_digest = $1            -- keyedDigest(secret, 'event-target', address)
 ORDER BY occurred_at DESC
 LIMIT 50;

-- is this broad or one address? bounded window, aggregate only
SELECT target_digest, count(*) AS tip_overs, min(occurred_at), max(occurred_at)
  FROM security_events
 WHERE event_type = 'password_reset_failed'
   AND metadata->>'reason' = 'reset_budget_exhausted'
   AND occurred_at > now() - interval '24 hours'
 GROUP BY target_digest
 ORDER BY tip_overs DESC
 LIMIT 50;
```

3. **Classify** — (a) *benign*: one address, one network prefix, consistent with a user's own retries;
   (b) *targeted*: one address, several unrelated prefixes; (c) *campaign*: many addresses from one prefix, or
   many addresses and many prefixes; (d) *co-tenant*: the prefix matches the reporting user's own network
   (§5.1 — the expected residual case).
4. **Decide** — no action (benign, window rolls in ≤ 15 min) · wait-and-verify · forced unlock (§6.3) ·
   escalate (§6.4).

### 6.3 Safe recovery

The only sanctioned recovery is to let the window roll, or — with an approved access-controlled procedure —
to clear **the specific counter row**, never anything else:

```sql
-- find first, then delete only the matching row
SELECT scope_kind, window_start, count, last_at
  FROM auth_attempt_counters
 WHERE scope_kind = $1               -- 'reset_target' | 'verification_target'
   AND scope_digest = $2             -- the same digest the repository computed
 ORDER BY window_start DESC LIMIT 5;
```

**Why this is safe, and what is forbidden:**

- The action touches `auth_attempt_counters` only. `security_events` is append-only (trigger
  `kfin_security_events_immutable`), so **the audit evidence of the exhaustion cannot be erased by the
  recovery action** — the record of what happened survives the fix.
- No account state is changed: no password reset, no unlock of `locked`/`disabled`/`deletion_pending`
  accounts (those stay non-self-recoverable by design), no session granted, no disclosure to a caller of
  whether the address exists.
- The user still needs a fresh code respecting the 60-second cooldown and the issuance caps, and any new
  challenge is again attempt-capped.
- Required but **missing today**: an access control on the clearing action and an operator log entry for it.
  The repository has no operator-action audit surface; until one exists, this step cannot be adopted. That
  gap — not the counter mechanics — is what blocks adoption.

### 6.4 Escalation

| Trigger | Route |
|---|---|
| Campaign pattern (many addresses from one prefix) or any sign of sustained automation | Security Owner (role), with Operations Owner executing |
| A beta user reports being unable to complete a reset after a tip-over | Operations Owner executes §6.3; Product Owner informed for the support reply |
| The event involves a third party's data or a disclosure request | Privacy / Legal Owner, before any reply |
| Suspected provider cost impact | Product + Operations Owner (note the unimplemented global cost cap, §5.5) |

There is **no on-call rotation, no paging path and no alerting consumer** in place: escalation today means a
person reading the query output during working hours. Until the responsible role is appointed and an
alert path exists, the operational value of the R1 event is "answerable after the fact", not "detected at the
time" — and the packet should be read that way.

### 6.5 Evidence retention

| Item | Property | Basis |
|---|---|---|
| The exhaustion event (`security_events`) | Durable and immutable (append-only trigger); carries keyed digests plus metadata ≤ 2048 bytes; no secret keys permitted; baseline maximum retention **24 months**, subject to legal reduction and post-deletion minimization | DATABASE.md §4.7 (pinned — the retention value itself is subject to `SPEC-DEL-01`) |
| Counter rows (`auth_attempt_counters`) | **Ephemeral**: pruned by `pruneAbuseCounters` after 8 windows (~2 h at 15-minute windows) | code + `docs/config` `retentionWindows` |
| Practical consequence | Counter state is **not** evidence — capture the event rows; a "why did this user get throttled an hour ago" question is answerable only from the event, and only while retention holds | this packet |

Digests are keyed with the application secret, so the events are pseudonymous, not anonymous: correlating a
digest to an address requires the secret. Access to the event table and to the secret is therefore a
privacy-relevant control, and sharing an event externally requires the Security or Privacy Owner's sign-off,
not an operator's.

---

## 7. F-8 and D5 — consistency review (read only; nothing resolved)

I reviewed both records for statements that no longer hold, and corrected two reference errors. I resolved
nothing, and nothing here is an acceptance.

| Item | State | Check performed |
|---|---|---|
| **F-8** (reset-request timing) | **CONFIRMED, no mitigation chosen.** Part B of the risks record is unchanged by A-1 (§A.7 is Part A only); the measured deltas (issuing vs unknown, medians 4.74 vs 2.11 ms; HTTP cross-check +4.2 ms) still stand as single-session measurements, and M2/M4 remain unchosen | Part B read end to end; the D5 record's cross-reference to it is accurate |
| **D5** (unverified-email beta risk) | **Recorded, unsigned, not accepted.** Its acceptance condition — "F-3 must be resolved or explicitly accepted *before or with* this acceptance" — is *partly* satisfiable now: F-3 has an implemented, proven mitigation for the remote vector, but is not closed. Accepting D5 today would still be accepting an open F-3, and this packet does not claim otherwise | D5 record §3–§5 read against the current branch state |
| Numbering collision | The request packet calls the unverified-email decision **D-1** while the D5 record, `MILESTONE-11` and this session's earlier records called it **D5**; two records also referenced the retired-verification decision as plain "D4" | Corrected: §2.4's collision note and the cross-references now say **D-1 ≡ D5** and **D-4** where the intended reference is unambiguous; no decision text was altered |
| Residual-risk ledger | Unchanged: F-3 mitigated-not-closed, F-8 open, D5 unsigned, `SPEC-AUTH-01` superseded-unsigned, `SPEC-AUTH-02` open-pending-A-1 | cross-checked against the register rows |

---

## 8. The exact approval request

Three decisions, deliberately separable. **Each field below is blank; each status stays `PENDING` until real
approval evidence exists in a named owner's own commit.** Filing this packet approves nothing.

### 8.1 Amendment A-1 — `SPEC-AUTH-02` reset-budget scope (Security Owner accountable, Product Owner co-approving, per register `:69`)

Wording to be adopted verbatim (identical to §2.4 of the request packet, which governs):

> **Cumulative reset failed-verification budget — scope and keying (amendment A-1, 2026-10-13).** The
> cumulative budget is keyed on the normalized account identifier composed with the caller's network-prefix
> digest (IPv4 /24, IPv6 /48; digest-only, never a full address): **10 failed verifications per 1-hour fixed
> window per (account, caller network)**. A caller whose address cannot be resolved keeps the account-only
> key. The spend remains unconditional and **before** any account or challenge lookup. The per-challenge
> attempt cap (5), the 60-second resend cooldown and the issuance caps (3 per account per hour, 6 per 24
> hours) remain **account-wide and unchanged**. The transition into exhaustion (`count = limit + 1`) writes
> exactly **one** operator-only security event (`password_reset_failed`, `outcome = 'blocked'`,
> `metadata.reason = 'reset_budget_exhausted'`, `visibility = 'operator'`), whether or not the address exists.
> The residual is explicit: a caller sharing the victim's /24 or /48 shares the bucket.

Companion sentence to replace in `SEC-AUTH-20`: "… be bounded by a cumulative **per-account, per-caller-network**
failed-verification budget across superseded challenges, a 60-second resend cooldown, and per-account,
per-IP/network, and global issuance/cost caps."

| Field | Value |
|---|---|
| Decision | Approve / approve with conditions / reject amendment A-1 |
| Accountable owner — Security Owner | _(blank — to be completed only by the named owner)_ |
| Co-approver — Product Owner | _(blank)_ |
| Evidence reviewed | ☐ this packet ☐ risks record §A.7 ☐ the eight F-3 cases ☐ the pre-fix reproduction ☐ `pnpm run check` output ☐ other: ___ |
| Defence-in-depth reduction acknowledged (§2.3: 10 → 15 evaluated submissions/hour worst case) | ☐ acknowledged ☐ not accepted (reject A-1) |
| Date | _(blank)_ |
| Signature / evidence reference | _(blank)_ |
| Status | **PENDING** |

### 8.2 Residual acceptance — the shared-network and unresolved-address limits (§5.1–5.2)

| Field | Value |
|---|---|
| Decision | Accept the residual / require an additional control / reject |
| If "require a control" | R5 operator unlock runbook (§6.3) · a same-network control (not designed) · other: ___ |
| Accountable owner — Security Owner | _(blank)_ |
| Informed — Product Owner | _(blank)_ |
| Residual expiry / review date | _(blank — required if the residual is accepted)_ |
| Date | _(blank)_ |
| Signature / evidence reference | _(blank)_ |
| Status | **PENDING** |

### 8.3 Operational response adoption — §6

| Field | Value |
|---|---|
| Decision | Adopt §6 as the operator response / adopt with changes / do not adopt |
| Accountable owner — Security Owner (policy) | _(blank)_ |
| Executing owner — Operations Owner | _(blank)_ |
| Named on-call or coverage window | _(blank — none exists today)_ |
| Access control on the counter-clearing action and its operator log | _(blank — the missing control that blocks adoption)_ |
| Review date | _(blank)_ |
| Date | _(blank)_ |
| Signature / evidence reference | _(blank)_ |
| Status | **PENDING** |

### 8.4 If A-1 is approved: the formal amendment and pin-update procedure

Approval does **not** auto-amend the specifications. In the owner's signed commit, and in this order:

1. Rewrite the `SEC-AUTH-20` sentence in `docs/security/SECURITY-REQUIREMENTS.md` with the §8.1 companion
   text and remove the pending pointer; update the `SPEC-AUTH-02` register row status.
2. Update the pinned `docs/testing/TEST-STRATEGY.md` (its cumulative-budget row and the AUTH test list) to
   describe the network-scoped budget and the eight F-3 cases.
3. Advance the three SHA-256 pins in `evidence/spec-fin-02/src/constants.mjs` **in the same commit** and
   record the new revision (the OQ-20 pattern), updating `evidence/spec-fin-02/test/static-contract.test.mjs`
   expectations if the amended set changes; then run `pnpm run evidence:check` and `pnpm run evidence:test`.
4. Add the dated entry to `docs/product/DECISION-LOG.md` and the approval row to
   `docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md`.
5. Re-run `pnpm run check` and CI; then record F-3's status — which may move to *closed* only once §8.2 and
   §8.3 are also signed.

**Until that commit exists, none of those documents may be edited.** The pins in `constants.mjs` are a
deliberate approval instrument: moving them for an unapproved change would launder a candidate into an
approved revision, which is exactly what this packet refuses to do.

---

## 9. Non-claims

- **No approval, acceptance, adoption, signature, owner, or date** is asserted anywhere in this packet, and
  none may be inferred from the code existing, from the tests passing, or from CI being green.
- **F-3 is `MITIGATED` (remote vector, code) and `OPEN`** (governance + residual). It is not closed.
- **F-8 is unchanged and unresolved**; **D5 is recorded, unsigned and unaccepted**; `SPEC-AUTH-01` is
  superseded and unsigned; `SPEC-AUTH-02` is open and now also carries A-1.
- **Nothing was merged, deployed, or run against production or Supabase**, and no feature work or new
  specification cycle was opened.
- **KFin remains NOT READY FOR RELEASE** until every open `SPEC-*` gate, this amendment, the residual
  acceptance, the operator response, and the remaining release evidence are genuinely satisfied.
