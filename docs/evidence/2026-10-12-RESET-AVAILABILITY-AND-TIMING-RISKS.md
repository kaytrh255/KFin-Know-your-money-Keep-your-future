# Reset-surface risk: F-3 (availability) and F-8 (timing) — analysis, measurements, and mitigation proposal

> ## Status: F-3 MITIGATED (remote vector closed in code) — **not closed** · F-8 CONFIRMED, awaiting a mitigation decision
>
> Both findings come from the pre-merge review of PR #10
> ([`docs/reviews/2026-10-12-PRE-MERGE-REVIEW-PR-10.md`](../reviews/2026-10-12-PRE-MERGE-REVIEW-PR-10.md), F-3 and F-8).
> Part A was written as analysis only: **nothing was implemented when §§A.1–A.6 were written**, and the
> working tree then implemented exactly what the review measured.
>
> **§A.7 was added later the same day** and records what changed after that: option **R2** was implemented
> as the durable fix together with **R1** detection, with a regression suite that fails on the pre-fix code
> and passes on the fixed code. Part B (F-8) and everything in §A.1–§A.6 remain analysis: no F-8 mitigation
> is implemented, and §A.5's option costings are unchanged by §A.7.
>
> Two things are therefore true at once and must not be blurred:
>
> - The **remote** denial — any anonymous caller anywhere denying a victim's password recovery — is
>   **technically mitigated** in code, and the regression suite reproduces the attack against the previous
>   code and proves the fix (§A.7). The residual (§A.7.4) is limited to callers *sharing the victim's
>   network prefix*.
> - **F-3 is not closed.** The fix changes a `SPEC-AUTH-02` behaviour dimension (the scope of the
>   cumulative reset budget), and that amendment is **requested, not approved** (§A.7.6). Until an
>   authorised owner signs it — or a governance decision explicitly accepts the residual — the finding
>   stays open, and this document does not decide it.

**Date:** 2026-10-12
**Prepared by:** implementation review session (Arena agent), acting for — not as — the owners
**Related:** [`2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md`](2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md) (D-4, D-5), [`2026-10-12-D5-UNVERIFIED-EMAIL-BETA-RISK.md`](2026-10-12-D5-UNVERIFIED-EMAIL-BETA-RISK.md) §2
**Implementation under review:** branch `arena/bfaf5019-kfin-know-your-money-keep-your` (PR #10, unmerged)
**Evidence environment:** disposable local PostgreSQL 17.6, `synchronous_commit = on`, `fsync = on`,
`full_page_writes = on`. No production or shared database was contacted.

---

# Part A — F-3: an unauthenticated attacker can deny password-reset completion

## A.1 Mechanism

`resetPassword` spends the cumulative per-target failure budget **before** it looks at any account or
challenge, deliberately, so the endpoint cannot be used as an existence oracle:

```
packages/database/src/auth-repository.ts
  registerAbuseAttempt('reset_target', target, …)                 // 1 per-IP-prefix and 1 per-target window
  registerAbuseAttempt('reset_ip',     …)
  registerAbuseAttempt('verification_target', target, …)          // the cumulative budget: limit 10, window 1 h
  … then: SELECT … FROM auth_challenges WHERE target_digest = $1  // only now is the target looked up
```

Two consequences follow from that ordering:

1. the budget is consumed by requests against an address that has **no account and no challenge**; and
2. once the counter exceeds its limit, the **next** request is refused with `429 AUTH_RATE_LIMITED` —
   including the request from the person who owns the account and holds the correct code.

`registerAbuseAttempt` throws `rateLimitedError(retryAfterSeconds)`; no security event is written on
that path, so the rejection is invisible to the operator today. `reset_ip` is keyed on a truncated
network prefix (`ipPrefixDigest`: IPv4 `/24`, IPv6 `/48`), so one prefix per hour is enough to sustain
the condition indefinitely.

## A.2 Measured evidence

Against the running API on a disposable cluster, using an address with **no account at all**
(`kfin_review_wire`, 2026-10-12):

| Attempt (same address, same source prefix) | 1 … 10 | 11 |
|---|---|---|
| `POST /api/v1/auth/password/reset` | `400 AUTH_CHALLENGE_INVALID` | **`429 AUTH_RATE_LIMITED`** |

Counters afterwards: `reset_ip = 10`, `verification_target = 10` — the cumulative budget was consumed
for an address that does not exist. The 15-minute windows are grid-aligned and the budget window is
aligned to the hour, so the condition persists until the hour rolls.

## A.3 Impact

| Dimension | Assessment |
|---|---|
| Confidentiality / integrity | Not affected. No account is taken over, no data is read, no code is guessed. |
| Availability | **Affected.** A known address can be kept unable to complete a password reset for the remainder of each hour window. `reset-request` still succeeds and still mails a code, so the user experience is "a code arrives and the form refuses it". |
| Who can be targeted | Any address the attacker knows. For a 50-user invited beta, addresses are known to anyone in the beta circle; the attacker must be external to be a threat. |
| Cost to the attacker | 10 unauthenticated requests per hour per `/24`; trivially rotatable. |
| Blast radius | Password *change* is unaffected, but it needs a live session. A user without a session and without their password is locked out for the window. Account status, financial data, and sessions are untouched. |
| Reversibility | Self-healing when the window rolls; the attacker can re-arm it every hour. |
| Detectability today | **None.** The 429 path writes no security event and no alert; the counters exist in `auth_attempt_counters` but nothing surfaces them. |

## A.4 The anti-enumeration implication, stated once

The pre-lookup spend is the *only* reason the endpoint is not an existence oracle: if the budget were
spent only when a live challenge exists for the target, then after the limit the response would become
`429` for an eligible address and stay `400` forever for an unknown one — a direct oracle, which
SEC-AUTH-04, `ARCHITECTURE.md` §9, and the OQ-20 revision forbid. **Any option below is judged by
whether it preserves that property.**

## A.5 Options

| # | Design (concrete enough to implement) | Availability effect | Anti-enumeration implication | Policy change? | Size |
|---|---|---|---|---|---|
| **R1 — operator-visible detection** | `registerAbuseAttempt` returns the new count instead of throwing immediately; the caller records an operator-only security event **only on the transition** (`count === limit + 1`), then throws exactly as today. Event: `password_reset_failed` (already in the `0004` CHECK and already classified `operator`), `outcome = 'blocked'`, `user_id = NULL` when the account is unknown, `target_digest` = the same `abuse:<scopeKind>` digest the counter uses, `ip_prefix_digest` for IP scopes, `metadata = { reason: 'reset_budget_exhausted', scope: '<kind>' }`. No migration needed (`security_events.user_id` is nullable; the `metadata` secret-key CHECK permits only the keys used). | None by itself — it makes the attack visible and answerable, it does not stop it. | **Preserved.** The response and its timing are unchanged; the event is written after the decision point and never reaches a client (`visibility = 'operator'`). | No | ~25 lines in `auth-repository.ts` + 2 integration tests (`security-events` row shape; transition-only bounding) |
| **R2 — key the budget by (target, network prefix)** | Key the `verification_target` counter on `target + '\|' + ipPrefix` instead of `target` alone, leaving the spend point (pre-lookup), the limit (10), and the window (1 h) unchanged. Existing counter rows simply age out. | **Removes the cross-network denial**: a third party on another network can no longer exhaust the victim's budget. | **Preserved.** The spend is still unconditional and still happens before the lookup, so the 11th request from *any* network is throttled identically whether or not the address exists. | **Yes** — it is a value/behaviour dimension of `SPEC-AUTH-02` (D-3) | Small: one scope value + the digest input, plus test updates |
| **R3 — shorten the window** | Cumulative window 1 h → 15 min (values in `packages/config/src/index.ts`). | Denial becomes shorter, not removable; the attacker re-arms at each boundary. | Preserved (unchanged ordering). | **Yes** — `SPEC-AUTH-02` | One config value + tests |
| **R5 — interim operator unlock runbook** | A documented, access-controlled operator step that clears the affected counter window row so a locked-out beta user can complete a reset within minutes. | Removes the practical impact for a 50-user beta. | Neutral — an operator action, not a client-visible difference. | Operational, not policy; needs an owner-approved runbook entry and the action must be logged. | Documentation only |
| **R4 — spend only when a live challenge exists** | Move the spend after the lookup. | Removes the no-account burn. | **Rejected: it creates the oracle** (§A.4). | — | — |
| **R6 — make `reset-request` behave differently once the budget is exhausted** | e.g. refuse to mail a code, or return a distinct body. | Cosmetic; the user still cannot complete a reset. | **Rejected: the difference is client-visible, so it discloses that the address is being targeted — and, by construction, that it exists.** | — | — |

### Why R2 does not meaningfully weaken brute-force resistance

The account-wide counter tightens an already-bounded number, it is not the bound itself: a challenge
retires after **5** failed attempts, and at most **3** challenges can be issued per hour (6 per 24 h),
so an attacker can make at most **15 wrong guesses per hour and 30 per day** against one account even
with no cumulative counter at all, against a 10⁶ code space. Keying R2 per network changes the counter
from a global per-account throttle to a per-network abuse signal; it does not open the guess space.

### Recommendation (analysis, not a decision)

Ship **R1 + R5** as the minimum that turns "recorded" into "handled", and take **R2** to the
`SPEC-AUTH-02` approval as the durable fix. R3 is the fallback if R2 is rejected. R4 and R6 must not be
adopted. **F-3 stays open until an authorised option ships**, and this document alone closes nothing.

## A.6 What F-3 needs from the owners

1. Authorise one option (or a combination) — recorded with the same signature discipline as D-3.
2. If R1 is chosen, confirm the operator response: who watches the events, how fast, and what they do.
3. If R5 is chosen, confirm the runbook owner and the access control on the counter-clearing action.
4. If R2 or R3 is chosen, re-approve the affected `SPEC-AUTH-02` values in the same decision.

## A.7 Implementation and verification (2026-10-12) — what shipped, and what it does not close

**Code commit:** `afc5201` — *fix(auth): scope the reset-target abuse budget to the caller's network (F-3)* —
on the PR #10 branch, child of `5629fa2`. **Status claim:** this is a *candidate implementation* of R2 plus
R1 detection. It ships no approval: the `SPEC-AUTH-02` amendment it needs is requested in
[`2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md`](2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md) §2.4 and
is **not signed**.

### A.7.1 What changed

| Where | Change |
|---|---|
| `packages/database/src/auth-repository.ts` — `targetNetworkKey(target, ipAddress)` | Composes the counter input as `"<target>\|<network-prefix-digest>"` (IPv4 /24, IPv6 /48 — the same truncated, digested network context the abuse evidence already stores, never a full address). A caller with no address yields the previous value, so that path is unchanged. |
| `resetPassword` — `reset_target` and `verification_target` | Both are now keyed by the composed value. The spend point, the ordering (still **before** any account or challenge lookup), and both limits/windows (10 per 15 min, 10 per 1 h) are unchanged. |
| `requestPasswordReset` — `reset_target` | Same composition. Because this counter is shared by both reset endpoints, the request endpoint and the verify endpoint now confine their spend to the caller's own network. |
| `registerAbuseAttempt` + `recordBudgetExhausted` | The R1 detection: an optional, awaited `onExhausted` callback that cannot alter the outcome, writing **one** `password_reset_failed` / `outcome = 'blocked'` / `metadata.reason = 'reset_budget_exhausted'` / `visibility = 'operator'` event on the `count === limit + 1` transition, whether or not the address exists. |

Deliberately **not** changed: the spend ordering that preserves anti-enumeration; every response body,
status and timing; `reset_ip`; the five-attempts-per-challenge cap; the 60-second resend cooldown; the
per-account issuance caps (still counted `WHERE user_id = $1`, i.e. still account-wide); login and
registration scopes; configuration values; schema and migrations (existing counter rows age out).

### A.7.2 The options against the five comparison axes

| Axis | **R1** detection | **R2** (target, network) — *implemented* | **R3** shorter window | **R5** operator runbook |
|---|---|---|---|---|
| Resistance to account enumeration | Preserved — event is operator-only | **Preserved** — spend stays unconditional and pre-lookup, so the `429` still lands on the same call for known and unknown addresses (asserted, §A.7.3) | Preserved | Neutral (operator action) |
| Victim availability and recovery | **None** — makes the attack visible, not stoppable | **Recovery restored for the remote vector**: the victim's own network's bucket is untouched, and their correct code completes the reset — previously the failing 429 (asserted) | Denial shortened, **not removed**: the attacker re-arms at each boundary and the victim can be held out indefinitely | Restores practical recovery *only while an operator is available* and only to the time it takes someone to act |
| Abuse resistance and operational burden | Unchanged resistance; **adds** an operational burden (somebody must watch the events — still unassigned, §A.7.6) | **Unchanged resistance.** The bound on guessing was never this counter: a challenge retires after 5 attempts and at most 3 challenges may be issued per account per hour (6/day), so ≤15 guesses/hour and ≤30/day against a 10⁶ space. Network-scoping the *throttle* opens no guess space; the `429` bound is now per network, which is what stops one network denying service. One event per tip-over, no paging contract defined | Slightly weaker as an account-wide throttle and still leaves the denial; buys ~15 minutes of attacker work | Neutral to resistance; the clearing action needs access control and logging to stay an accountable control |
| Database / schema changes | None (`security_events` already carries the type, outcome, digest and metadata keys) | **None** — no migration; keys are computed at write time and old rows age out | None (one config value) | None |
| Compatibility with existing tests and approved specifications | Compatible | **Incompatible with the current wording of `SEC-AUTH-20` and the `SPEC-AUTH-02` budget dimension** — that is precisely why F-3 is *not* closed (§A.7.6). Compatible with every other control and with the existing suite, which passes unchanged | Also requires a `SPEC-AUTH-02` value re-approval | No policy change, but needs a named owner — which cannot be invented |

R4 and R6 stay rejected for the reasons in §A.5 (oracle; targeted-address disclosure). R5 is **not adopted**:
the durable fix removes its need for the remote vector, and adopting it now would create an operational
control with no owner. It remains the fallback for the residual in §A.7.4 and would need the owner,
access control, an expiry/review date and the logged action that §A.6.3 asks for.

### A.7.3 Evidence

Attack reproduced against the previous code — the fix was temporarily reverted to its `5629fa2` content and
the new suite re-run against it (`npx vitest run packages/database/test/auth-access.integration.test.ts -t "F-3"`),
**4 failed / 2 passed**:

| Case | Pre-fix result |
|---|---|
| `the flood spends the attacker's own budget and the victim still completes the reset` | **FAILED** — the victim's own completion threw `AUTH_RATE_LIMITED` (this is F-3, mechanised) |
| `a flood on the request endpoint cannot stop the victim completing a reset` | **FAILED** — same `AUTH_RATE_LIMITED` |
| `counts concurrent flood requests without losing one` | **FAILED** — `expected [...] to have a length of 6 but got 3` (12 concurrent requests across two networks were charged to one counter) |
| `records one operator-visible event when a budget tips over, not one per request` | **FAILED** — `expected [] to have a length of 1` (no event existed) |
| `answers known and unknown addresses identically at the exhaustion boundary` | passed — the property the fix must **preserve** |
| `residual limitation: an attacker sharing the victim's network still shares the bucket` | passed — the residual is a property of both versions |

With `afc5201` applied, the same command reports **6 passed**, and the properties asserted are: the victim on
another network completes the reset after the flood; a request-endpoint flood cannot deny the victim (whose
own in-cooldown request answers `accepted: true, issued: false`, then succeeds after the cooldown); known and
unknown addresses produce identical outcome sequences through the exhaustion boundary
(`AUTH_CHALLENGE_INVALID` ×budget, then `AUTH_RATE_LIMITED`); 12 concurrent submissions across two networks are
counted exactly, 2×budget on their merits and the remainder throttled; exactly one operator event regardless of
flood length; and the shared-network residual is asserted rather than assumed.

Whole-gate result on this tree: `pnpm run check` **exit 0** — `evidence:check`, `evidence:test` **17/17**,
`typecheck` clean, and vitest **769 passed / 38 files**, which includes the real-PostgreSQL integration suites
(database + journey) run against a disposable local PostgreSQL 17.6 with the non-production target flag set;
`pnpm run web:build` exit 0. No production, Supabase, or shared database was contacted, and no credential
entered this record, the logs, or the repository.

### A.7.4 Residual limitations (documented and asserted, not assumed)

1. **A caller sharing the victim's network still shares the bucket.** Network scope removes the *remote*
   denial; a caller in the same /24 (IPv4) or /48 (IPv6) — a shared office, a CGNAT aggregation, a
   compromised host on the victim's own link — is indistinguishable at this layer and can still exhaust the
   bucket for the victim's address. This is strictly narrower than the finding as measured (which needed no
   relationship to the victim at all), and it is asserted by a regression case so it cannot be mistaken for
   an oversight.
2. **A caller arriving without a resolvable address keeps the previous target-only scope.** That is the
   pre-fix behaviour for that path, unchanged rather than worsened; the deployment must therefore resolve a
   trustworthy client address (proxy/`X-Forwarded-For` policy) for the mitigation to apply.
3. **The removed control** — an account-wide counter that every network shared — was itself the denial
   vector; it is replaced by a per-network counter with the same limit and window, and the account-wide
   bound on guessing is carried by the untouched per-account issuance caps.

### A.7.5 What this closes, and what it does not

The **remote** vector — "any unauthenticated caller denies a stranger's password recovery" — is technically
mitigated and regression-proven. F-3 is therefore no longer in the state the review measured it in.

F-3 is **not closed**, for two independent reasons, either of which alone would be enough:

1. the residual in §A.7.4 has not been accepted by any authorised owner; and
2. the change alters a `SPEC-AUTH-02` behaviour dimension (the scope of the cumulative reset budget) and the
   matching `SEC-AUTH-20` wording, and that amendment is **requested, not approved** (§A.7.6).

### A.7.6 What the owners still owe this finding

1. **Sign or reject the amendment** in
   [`2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md`](2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md) §2.4
   (D-4). Until then the code is a candidate, the specification text is unamended, and the divergence is
   disclosed here rather than silently reconciled.
2. **Decide the residual** in §A.7.4: accept it for the closed beta, or require an additional control
   (R5 operator runbook, or a future same-network control) — with a named owner, an expiry/review date, the
   access control on any counter-clearing action, and the logged action §A.6.3 asks for.
3. **Confirm the operator response to the R1 event**: who watches `password_reset_failed` /
   `reason = reset_budget_exhausted`, how fast, and what they do. The event is written today; nothing consumes
   it yet, and this session appoints nobody.

---

# Part B — F-8: the response bodies are identical, the latency is not

## B.1 What was measured, and how

The review's original observation (11.8 ms issuing vs 4.2–5.0 ms non-issuing) was a single sample taken
on a cold server and was explicitly labelled unquantified. It has now been measured properly.

**Method.** The shipped `PostgresAuthRepository` and the shipped SQL, against a scratch database on the
disposable cluster. Five cases, round-robin interleaved so that drift affects every case equally,
**10 warm-up calls per case discarded**, then **40 measured samples per case**. The only deviation from
shipped behaviour is that the abuse limits, resend cooldown and issuance caps were relaxed **for this
harness** so that one process could take repeated samples of the issuing path; no repository, config or
migration file was modified, and every shipped value is unchanged.
The probe (`/tmp/kfin-review/f8-measure.mts`, a scratch file outside the repository) was executed from the
repository root on 2026-10-12; the command sequence is reproduced in §B.5.

| Case | Path | mean | p10 | median | p90 | min | max |
|---|---|---|---|---|---|---|---|
| **A** | issuing — active account, a code is composed and mailed | 4.90 | 3.62 | **4.74** | 6.27 | 3.41 | 9.26 |
| **B** | unknown address — accepted, nothing looked up | 2.24 | 1.75 | **2.11** | 3.03 | 1.54 | 3.18 |
| **C** | cooldown — known active account, live challenge, nothing issued | 3.01 | 2.31 | **2.84** | 4.02 | 2.11 | 5.69 |
| **D** | locked account — accepted, nothing issued | 2.24 | 1.74 | **2.09** | 3.05 | 1.63 | 4.52 |
| **E** | malformed address — no account lookup at all | 1.89 | 1.44 | **1.91** | 2.34 | 1.32 | 2.95 |

Median deltas: **A−B = 2.62 ms**, **A−D = 2.64 ms**, A−C = 1.90 ms, B−E = 0.20 ms (milliseconds).

**Cross-check at the HTTP boundary**, shipped limits, same-origin, delivery adapter `none` so no sink
I/O is included: unknown n=4, median **4.06 ms** (3.74 – 4.73); issuing n=4, median **8.24 ms**
(7.68 – 8.94) — a **+4.2 ms** separation with disjoint ranges. The sample is small because the shipped
`reset_ip` limit of 10 per 15-minute window caps it by construction; it is a confirmation, not the
primary measurement.

## B.2 Conclusion

**F-8 is confirmed: the reset-request endpoint is not timing-equivalent.** Identical response bodies are
not evidence of equivalence, and the measurements above show why: A and B/D have essentially disjoint
ranges (A min 3.41 ms vs B max 3.18 ms), so a client that can time the request can separate "an account
exists and a code was mailed" from "nothing was issued" — the enumeration signal the request path is
designed not to emit. Case C (known account inside cooldown, nothing issued) sits 0.73 ms above the
unknown case with overlapping ranges, so at this sample size it is **not** clearly separable; the strong
signal is the issuing path.

Severity remains **low**: the channel is noisy over a network, it requires many samples, and the
information revealed ("this address belongs to an active beta account") is modest. It is not, however,
zero, and it is not "bounded timing" in the sense the specification's wording assumed.

## B.3 Options

| # | Design | Cost | Anti-enumeration effect | Decider |
|---|---|---|---|---|
| **M1 — keep measuring** | Keep a repeatable harness in the repository and re-run it when the reset path or the database durability settings change | Small | None by itself; it prevents silent regression | Security (evidence) |
| **M2 — fixed response-time floor** | Apply a floor to the whole request path: measure the elapsed time and sleep the remainder of, say, 15 ms before responding, on **every** outcome, so both the issuing and the non-issuing paths land in the same band | ~10 ms added to every reset request; one small helper plus tests | Removes the separation for the median; p90 tails still differ, so it narrows rather than closes the channel | Security + Product (latency/UX) |
| **M3 — equalise the work** | Perform the same challenge/event writes for ineligible targets and discard them | Creates challenge rows and burns counters for addresses that have nothing to do with the request | Closes the channel | Rejected — side effects are worse than the finding |
| **M4 — accept with the numbers attached** | Record the measured deltas as residual risk under `SPEC-AUTH-02`, with this table as the evidence | None | Explicit rather than implicit | Security Owner |

## B.4 What F-8 needs from the owners

Choose M2 or M4 (M1 should happen either way, M3 is rejected). Choosing M4 requires the measured table
to be attached to the acceptance — that is what makes it an informed acceptance rather than a note.

## B.5 Reproduction recipe (so the numbers can be re-derived, not trusted)

The measurement harness is deliberately **not** committed: the repository keeps exactly one verification
harness, and adding a second executable path would change what the pinned evidence check verifies. The
recipe below is complete enough to rebuild it in a scratch directory:

1. **Database.** Disposable local PostgreSQL cluster with `synchronous_commit = on`, `fsync = on`,
   `full_page_writes = on`. Create a scratch database and apply migrations `0001`–`0007` from
   `packages/database/migrations` with `MIGRATION_DATABASE_URL` pointing at it. Never point this at a
   shared or production database.
2. **Probe.** A TypeScript module run with `npx tsx` from the repository root that constructs the
   **shipped** `PostgresAuthRepository` against that database, seeded with:
   the relaxed limits and cooldown described in §B.1 (harness-only), one active `unverified` user, and
   one live challenge for case C.
3. **Cases.** Five targets as in §B.1: eligible-but-no-account (B), eligible active account (A), active
   account with a live challenge inside cooldown (C), `locked` account (D), malformed address (E).
   Round-robin the five cases, discard 10 warm-up samples per case, then take 40 samples per case, timing
   each call with `process.hrtime.bigint()` and reporting median/p10/p90/min/max. Assert the
   "was a code issued" flag per case (A true; B/C/D/E false).
4. **HTTP cross-check.** Recreate the database, apply the same migrations, seed active `unverified`
   users, start the API on a loopback port with `EMAIL_DELIVERY_ADAPTER=none`, and issue alternating
   `POST /api/v1/auth/password/reset-request` calls with `curl -w '%{time_total}'`, same `Origin` header,
   for an unknown address and for a seeded address. Shipped limits cap this at 10 calls per 15-minute
   window, so keep the sample small and label it as a confirmation. Note that with the delivery adapter
   set to `none` the cross-check excludes any mail-sink I/O, which is why its absolute numbers sit above
   the in-process ones.
5. **Cleanup.** Drop the scratch databases; never leave the cluster holding review data.

---

# Part C — Status and non-claims

| Finding | Status after this record (including §A.7, added later the same day) |
|---|---|
| **F-3** | **MITIGATED IN CODE FOR THE REMOTE VECTOR — NOT CLOSED.** §A.1–§A.6 analysed and measured it with nothing implemented; §A.7 records what then shipped (`afc5201`: R2 network-scoped counters + R1 detection), with the pre-fix reproduction and the passing suite. It stays open because amendment **A-1** is unsigned and the shared-network residual (§A.7.4) is unaccepted; both are required before merge, and a risk note still closes nothing. |
| **F-8** | **CONFIRMED, PENDING APPROVAL.** Measured; conclusion stated; mitigation (M2) or informed acceptance (M4) required. **No F-8 change was made**: §A.7 is Part A only. |
| D-3 / `SPEC-AUTH-02` | Still awaiting signature, and now **larger**: R2 shipped as a candidate, so the decision has to cover the budget's scope/keying (amendment A-1, §2.4 of the request packet) as well as the values. R3 remains the fallback if A-1 is rejected; B.3 M4 would extend what the signature must accept. |

§§A.1–A.6 and Part B changed no behaviour: no rate-limit value, key, window or spend point was touched
to produce the analysis, and no F-8 mitigation exists. §A.7 changed exactly one thing — the key the two
reset-target counters are composed from — and records it, its limits, and its evidence. No production
system was touched. No credit is claimed for closing either finding: this document is the input to the
owners' decisions, not their outcome, and the person who implemented §A.7 is not the person who
authorises it.
