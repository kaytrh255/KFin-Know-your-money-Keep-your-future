# Authentication-policy decision requests — D5, `SPEC-AUTH-01`, `SPEC-AUTH-02` (and the two open review findings)

> ## ⚠ NOT APPROVED — request only
>
> This file is a **request for owner decisions**. It is **not** an approval, **not** an accepted risk,
> and **not** evidence of any signature. No approver name, date, or signature has been entered: every
> approval field below is deliberately empty and **must be filled in only by the named owner**, in a
> later commit, with their own wording and their own record of what they read.
>
> Nothing in this repository may be read as saying D5 is accepted, `SPEC-AUTH-01` is ratified, or
> `SPEC-AUTH-02` is approved. As of this commit all three are **open**, and `EVID-AUTH-POLICY` in
> [`docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md`](../governance/APPROVAL-AND-EVIDENCE-REGISTER.md)
> is still `Missing / Not evaluated`.
>
> **Amendment A-1** (§2.4, the `SPEC-AUTH-02` budget-scope change implemented as a candidate in commit
> `afc5201`) is likewise **requested and unsigned**, and it is the reason F-3 is recorded as mitigated
> rather than closed.

**Date prepared:** 2026-10-12
**Prepared by:** implementation review session (Arena agent), acting for — not as — the owners
**Prepared after:** [`docs/reviews/2026-10-12-PRE-MERGE-REVIEW-PR-10.md`](../reviews/2026-10-12-PRE-MERGE-REVIEW-PR-10.md) (findings F-1, F-3, F-8)
**Implementation under review:** branch `arena/bfaf5019-kfin-know-your-money-keep-your` (PR #10, unmerged; head at the time of writing `4866d13`)
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2` (untouched)

## 1. What is being asked

| Ref | Decision requested | Who must sign (per the register) |
|---|---|---|
| **D-1** | Accept the unverified-email beta risks (D5): MVP **never** verifies an email address, and the operator, not the product, carries the consequences | **No register row exists** — see §1.1; the owners must first decide *who* signs and *where* |
| **D-2** | Ratify the retirement of the post-verification branch (`SPEC-AUTH-01`) | Accountable: **Product Owner**; approver: **Security Owner** (`APPROVAL-AND-EVIDENCE-REGISTER.md:68`) |
| **D-3** | Approve the authentication/session values, including the reset-OTP bounds (`SPEC-AUTH-02`) | Accountable: **Security Owner**; co-approval: **Product Owner** (register `:69`) |
| **D-4** | Decide how **F-3** (reset-request availability) is closed — it is not closed by any note | Product + Security; the chosen option determines whether `SPEC-AUTH-02` (D-3) must be re-approved |
| **D-5** | Decide how **F-8** (reset-request timing) is closed or accepted | Security, with Product for the latency/UX consequence |

Evidence already in the repository that these decisions can rest on:

- `pnpm run evidence:test` **17/17**; `pnpm run check` exit 0 (**681 passed / 69 skipped**);
  `pnpm run test:integration` **69/69** against real PostgreSQL 17.6; CI `verify` **success** on
  `4866d13`.
- `AUTH-REG`, `AUTH-RST`, `AUTH-UNV` cases in `packages/database/test/auth-access.integration.test.ts`,
  plus `apps/api/test/auth-write-defense.test.ts` (browser-write defense) and
  `packages/database/test/migration-contract.test.ts` (migration 0007 assertions + pinned checksum).
- A live HTTP run over the whole acceptance list, recorded in
  [`docs/implementation/MILESTONE-11-OTP-RESET-ONLY.md`](../implementation/MILESTONE-11-OTP-RESET-ONLY.md) §7.
- The measured behaviour behind D-4 and D-5 is in §2 and §3 below.

### 1.1 Who should sign D-1, and where should it live

The register has no D5 row, so the request cannot name an approver without inventing one. Two paths,
both of which are the owners' call:

| Option | What it means | Cost |
|---|---|---|
| **R-1a** — a dated `DECISION-LOG` entry | Treat the unverified-email beta risk as a product decision, recorded under `docs/product/DECISION-LOG.md` §8 change control with rationale and approver, then referenced from the register | Touches a normative document (not harness-pinned); needs a new dated entry, not a silent edit |
| **R-1b** — an evidence record plus a register row | Keep it as a risk acceptance in `docs/evidence/` and add the corresponding `EVID-AUTH-POLICY` row/status to `APPROVAL-AND-EVIDENCE-REGISTER.md` | The register **is** hash-pinned in `evidence/spec-fin-02/src/constants.mjs`; the pin must be updated **in the same commit** with the amendment recorded (the pattern used for OQ-20 in `9456067`) |

Recommended split, offered as analysis rather than as a decision: use **R-1a** for the *acceptance*
(a product decision) and **R-1b** for the *register status*, and put the F-3/F-8 outcome in the same
record so the residual risk and its mitigation ship together.

## 2. F-3 — reset-request availability (open, externally reachable)

### 2.1 What was measured

Against the running API on a disposable local cluster, with an address that has **no account at all**:

| Attempt | 1–10 | 11 |
|---|---|---|
| `POST /api/v1/auth/password/reset` response | `400 AUTH_CHALLENGE_INVALID` | **`429 AUTH_RATE_LIMITED`** |

Counters afterwards: `reset_ip = 10`, `verification_target = 10` — the cumulative per-account budget
was consumed for an address that has no account. The spend happens **before** the account lookup by
design (`packages/database/src/auth-repository.ts` `resetPassword`, budget spend at `:993-1001`,
lookup at `:1013`).

### 2.2 Impact

**Availability (the exploitable part).** An unauthenticated party who knows a victim's email address
can send ten requests for that address and exhaust the victim's hourly verification budget. The
victim's own `POST /api/v1/auth/password/reset` then returns `429` for the remainder of the fixed
1-hour window **even if they hold the correct OTP** — their `POST /api/v1/auth/password/reset-request`
still succeeds and still mails them a code, so the visible experience is "a code arrives and cannot be
used". Password *change* is not affected, but it requires an existing session; a user who has lost
their session and their password is fully locked out until the window rolls.

Cost to the attacker: 10 requests per hour per network. The `reset_ip` counter is keyed on a truncated
prefix (`ipPrefixDigest`: IPv4 `/24`, IPv6 `/48`), so a handful of rotating prefixes — or one prefix
per hour — sustains the lockout indefinitely. The attack is blind (it needs the address, not the code)
and leaves no user-visible trace: the rate-limit rejection records no security event and no alert
(`registerAbuseAttempt` throws `rateLimitedError` before any event is written), so today the operator
cannot even see it happening.

**Security (what the current design protects).** Spending the budget *before* the lookup is what keeps
the endpoint from being an existence oracle: if the budget were only spent when a live challenge
exists, the 11th request would answer `429` for a real account and `400` forever for an unknown one.
That would be a straightforward account-enumeration oracle, which SEC-AUTH-04 and the OQ-20 revision
forbid. The tension is real; it is not an oversight in the code.

**Scale of the residual brute-force exposure if the keying changes** (needed to judge the options): the
per-challenge attempt cap (5) and the issuance caps (3/hour, 6/24 h) already bound wrong guesses
against one account to **≤ 15 per hour and ≤ 30 per day**, and the code space is 10⁶. The account-wide
cumulative budget tightens the hourly figure from 15 to 10 — useful defence in depth, but **not the
load-bearing control**.

### 2.3 Options

| Option | What changes | Availability effect | Security effect | Who decides | Size |
|---|---|---|---|---|---|
| **R1 — detection and response** | Record an operator-visible security event on the *transition* into exhaustion (`password_reset_failed`, existing event type, `outcome='blocked'`, `user_id` null when the account is unknown, `target_digest`, `ip_prefix_digest`, `metadata.reason='cumulative_budget_exhausted'`), plus an operator alert | None by itself; makes the attack visible and answerable | None (event is operator-only; response unchanged, so no new oracle) | Product + Security confirm the operational response | ~20 lines in `registerAbuseAttempt` + a caller transition check; **no migration** (the event type and the operator classification already exist; `security_events.user_id` is nullable, `metadata` forbids secret keys) |
| **R2 — key the budget by (target, network prefix)** | The cumulative counter stops being account-global | Removes the cross-network lockout: a third party can no longer exhaust the victim's budget from another network | Brute-force bound stays the cap-driven ≤ 15/h, ≤ 30/day; the counter stops being a global per-account throttle and becomes a per-network one | **Required**: this is a `SPEC-AUTH-02` value/behaviour dimension (D-3) | Small code + test change |
| **R3 — shorten the enforcement window** | e.g. 1 h → 15 min | Lockout becomes shorter, not removable; attacker repeats at each boundary | Also reduces the guessing budget | `SPEC-AUTH-02` (D-3) | Config value + tests |
| **R4 — spend only when a live challenge exists** | Move the spend after the lookup | Removes the "no account / no challenge" burns | **Rejected: reintroduces the enumeration oracle** | — | — |
| **R5 — interim operator unlock runbook** | A documented operator step that clears the affected counter row so a locked-out beta user is unblocked within minutes | Removes the practical impact for the ~50-user beta | None; an operator action needs its own runbook entry and access control | Product + Security + Operations | Documentation only |

**Recommendation offered to the owners (not a decision):** ship **R1 + R5** now as the minimum that
makes the risk *handled* rather than *noted*, and take **R2** as the durable fix together with the
`SPEC-AUTH-02` approval it implies. R4 must not be adopted.

  **Explicitly not done in this changeset:** no limit value, key, window, or spend point was changed,
  because that would be a policy decision this session may not take. **F-3 therefore remains open and
  blocking**, and a risk note alone does not close it.

  > **Note added 2026-10-12 (later commit `afc5201`).** After this packet was written, the durable option
  > **R2 was implemented in code as a candidate**, together with **R1** detection, on the same PR #10 branch,
  > with a regression suite that fails on the previous code and passes on the new one
  > ([`2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md`](2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md)
  > §A.7). Nothing in §2.1–§2.3 is retracted: the measurements still describe the code as it was, and the
  > statement above is still true of *this* changeset. What changed is that the code now ships a candidate
  > that **needs the amendment in §2.4 to be signed**; the finding is therefore **mitigated but not closed**,
  > and the sentence "not mitigated in code" no longer describes the branch tip (see §5).

  ### 2.4 The exact `SPEC-AUTH-02` amendment this fix requires — and its approval request

  **Why an amendment is needed at all.** R2 changes a behaviour dimension that `SPEC-AUTH-02` is the
  decision for — the *scope and keying* of the cumulative reset failed-verification budget — and the current
  `SEC-AUTH-20` sentence says the budget is **per-account**. Shipping the fix without requesting the change
  would be a silent policy edit, so the deviation is recorded in public, in
  [`2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md`](2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md)
  §A.7, and the amendment is requested here. **No approval is claimed, and the amendment is not in force.**
  The review-ready rendering of this request — behaviour change, compatibility, the demonstrated/untested
  residual classification, the operator-response proposal and the blank signature blocks — is
  [`2026-10-13-A1-DECISION-PACKET.md`](2026-10-13-A1-DECISION-PACKET.md); **the wording below governs** if
  the two ever disagree.

  **Numbering note (2026-10-13).** Two series exist in the records: **D-1 ≡ D5** (both name the
  unverified-email beta risk acceptance — this packet's §1/D-5 block and the D5 record are the same decision),
  and **D-4** is the F-3 closure decision. Earlier records that wrote bare "D4"/"D9" meant **D-4**/**D-3**;
  those cross-references were corrected in the D5 record and `MILESTONE-11`. No decision text changed.

  **Amendment A-1 — reset cumulative-budget dimension (`SPEC-AUTH-02`, D-3).** Wording to be adopted
  verbatim in the decision record if the owners approve it:

  > **Cumulative reset failed-verification budget — scope and keying (amendment A-1, 2026-10-12).**
  > The cumulative budget is keyed on the normalized account identifier composed with the caller's
  > network-prefix digest (IPv4 /24, IPv6 /48; digest-only, never a full address): **10 failed
  > verifications per 1-hour fixed window per (account, caller network)**. A caller whose address cannot be
  > resolved keeps the account-only key. The spend remains unconditional and **before** any account or
  > challenge lookup. The per-challenge attempt cap (5), the 60-second resend cooldown and the issuance caps
  > (3 per account per hour, 6 per 24 hours) remain **account-wide and unchanged**. The transition into
  > exhaustion (`count = limit + 1`) writes exactly **one** operator-only security event
  > (`password_reset_failed`, `outcome = 'blocked'`, `metadata.reason = 'reset_budget_exhausted'`,
  > `visibility = 'operator'`), whether or not the address exists. The residual is explicit: a caller sharing
  > the victim's /24 or /48 shares the bucket.

  **Companion wording change in `SEC-AUTH-20`** (the requirement text, which currently reads "bounded by a
  cumulative **per-account** failed-verification budget across superseded challenges, a 60-second resend
  cooldown, and per-account, per-IP/network, and global issuance/cost caps"):

  > … be bounded by a cumulative **per-account, per-caller-network** failed-verification budget across
  > superseded challenges, a 60-second resend cooldown, and per-account, per-IP/network, and global
  > issuance/cost caps.

  This text has **not** been written into `docs/security/SECURITY-REQUIREMENTS.md`; only a clearly-marked
  *pending* pointer was added there, because rewriting a requirement before approval would be the silent
  edit this packet exists to prevent.

  **Consequential table change in §4 (D-3).** The D-3 row "Cumulative failed verifications" would read
  "10 per account per hour **per caller network** (fixed window, keyed on the target composed with the
  network-prefix digest)" — see the note added under that table.

  **Also required in the same signed commit** (deliberately **not** done by this session, because the change
  is unapproved):

  | Item | Why it must move with the signature |
  |---|---|
  | `docs/testing/TEST-STRATEGY.md` — a row for the network-scoped budget and the six regression cases | It is an authoritative document **pinned by SHA-256** in `evidence/spec-fin-02/src/constants.mjs`; any edit fails `evidence:check` unless the pin advances in the same commit with the revision recorded (the OQ-20 pattern), and `evidence/spec-fin-02/test/static-contract.test.mjs` pins the amended set exactly. |
  | `docs/architecture/DATABASE.md` §4.5 and the `APPROVAL-AND-EVIDENCE-REGISTER.md` `SPEC-AUTH-02` row | Same pinning mechanism; the register row is where the signature has to land. |
  | `docs/product/DECISION-LOG.md` — the dated decision entry | The change control for a value/behaviour decision, so the log and the code cite each other. |

  | Field | Value |
  |---|---|
  | Amendment | **A-1** — cumulative reset budget keyed per (account, caller network); exhaustion transition event |
  | Accountable owner (Security Owner, `APPROVAL-AND-EVIDENCE-REGISTER.md:69`) | _(name — not filled by this session)_ |
  | Co-approver (Product Owner) | _(name — not filled by this session)_ |
  | Implementation awaiting the decision | commit `afc5201` on the PR #10 branch (unmerged, undeployed) |
  | Evidence reviewed | ☐ `docs/evidence/2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md` §A.7 ☐ the six `F-3` integration cases ☐ pre-fix reproduction ☐ `pnpm run check` output ☐ other: ___ |
  | Residual the signer is also accepting | ☐ a caller sharing the victim's /24 (IPv4) or /48 (IPv6) can still exhaust the bucket ☐ accepted ☐ not accepted (then a further control is required — see R5) |
  | Date | _(not filled)_ |
  | Signature / evidence reference | _(not filled)_ |
  | Outcome | ☐ approve A-1 ☐ approve with conditions ☐ reject (then the code must revert to the pre-`afc5201` keying or another authorised option must ship) |

  **What signing A-1 does and does not do.** Signing it approves the *behaviour dimension* above; it does not
  by itself close F-3 — that also needs the acceptance of the residual (or a further control) and the
  operational response to the R1 event confirmed, as listed in §A.7.6 of the risks record. Rejecting A-1
  leaves F-3 open and the shipped candidate unauthorised, which is a merge blocker, not a merge risk.

  ## 3. F-8 — reset-request timing (open, low)

Measured (single samples, same-origin, warm server after the first request):

| Path | Body | Latency |
|---|---|---|
| Known address, challenge issued (a mail is sent) | `{"accepted":true}` | 11.8 ms *(first write request after boot — warm-up confounded)* |
| Known address inside cooldown (no mail) | `{"accepted":true}` | 5.0 ms |
| Unknown address (no mail) | `{"accepted":true}` | 4.2 ms |

Bodies are byte-identical (`cmp` clean); the difference is in latency and is therefore a potential
side channel for "a message was sent", which is exactly what the request path tries not to reveal. The
approved wording is "identical status, body shape, and **bounded** timing", so this is inside the
current text — but it is unquantified, and one sample is not a measurement.

| Option | What changes | Notes | Who decides |
|---|---|---|---|
| **M1 — measure properly** | A harness with N ≥ 30 per case from an unthrottled source, reporting median and p95 | Cheap and it decides whether anything else is needed; do this first | Security (evidence) |
| **M2 — latency floor** | Bring the non-issuing path up to a fixed floor (e.g. ≥ 15 ms) | 3-line change, adds ~10 ms to every reset request; masks rather than equalises | Security + Product (UX) |
| **M3 — equalise the work** | Perform the same challenge/event writes for ineligible targets and discard | Rejected: creates challenge rows and burns counters for addresses that have nothing to do with the request | — |
| **M4 — accept as bounded timing** | Record the measured numbers as residual risk under D-3/D-1 | Legitimate only with the numbers in hand, i.e. after M1 | Security |

### 3.1 Status update after this request was written (2026-10-12)

Nothing below changes an option or an approval field; it records what has been measured since, so that a
reader is not working from the unquantified numbers above.

- **M1 is done.** F-8 was measured properly — 40 samples per case across five cases, interleaved, plus an
  HTTP-boundary cross-check — and the detail lives in
  [`2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md`](2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md)
  Part B. Result: **the endpoint is not timing-equivalent** (issuing median 4.74 ms vs unknown 2.11 ms,
  essentially disjoint ranges; HTTP cross-check 8.24 ms vs 4.06 ms). The decision the owners still owe is
  **M2 (latency floor) or M4 (informed acceptance with the table attached)**; M3 stays rejected.
- **F-3 is unchanged and still open.** The same record's Part A restates the mechanism, re-measures
  `400 ×10` → `429` against an address that has no account at all, and costs options R1–R6, rejecting R4
  and R6 on the anti-enumeration argument stated in §2 of this request. **No limit, key, window, or spend
  point was changed.** R1 + R5 remain the recommended minimum; R2 remains the durable fix and will need
  the `SPEC-AUTH-02` approval it implies.
- **D5 now has a dated record with a proposed accountable owner** —
  [`2026-10-12-D5-UNVERIFIED-EMAIL-BETA-RISK.md`](2026-10-12-D5-UNVERIFIED-EMAIL-BETA-RISK.md) — which
  proposes **Product Owner** as accountable risk owner with **Security Owner** as co-approver, and leaves
  its acceptance block empty. Proposing a role is not a signature.
- **Every approval field in this file is still empty**, `EVID-AUTH-POLICY` is still
  `Missing / Not evaluated`, and none of D-1, D-2, D-3, D-4 or D-5 has been decided.

## 4. Approval fields — deliberately empty

**Instructions to the owner:** fill in only the block(s) you are approving, in your own commit, with
your own wording. Do not mark a decision approved on the basis of this file alone. If you approve with
conditions, the conditions are part of the decision and belong in the same record.

### D-1 — accept the unverified-email beta risks (D5)

| Field | Value |
|---|---|
| Decision | _(owner to state it in their own words)_ |
| Decision record location | _(R-1a and/or R-1b, per §1.1 — owner to choose)_ |
| Accountable owner | _(name — not filled by this changeset)_ |
| Co-approver, if required | _(name — not filled by this changeset)_ |
| Date | _(not filled)_ |
| Signature / evidence reference | _(not filled)_ |
| Outcome | ☐ approve ☐ approve with conditions ☐ reject |

### D-2 — ratify the retirement of the post-verification branch (`SPEC-AUTH-01`)

| Field | Value |
|---|---|
| Accountable owner (Product Owner) | _(name — not filled by this changeset)_ |
| Approver (Security Owner) | _(name — not filled by this changeset)_ |
| Evidence reviewed | ☐ `AUTH-REG`/`AUTH-RST` integration suite ☐ live HTTP run ☐ register→sign-in and reset→sign-in threat review ☐ other: ___ |
| Date | _(not filled)_ |
| Signature / evidence reference | _(not filled)_ |
| Outcome | ☐ approve ☐ approve with conditions ☐ reject |

### D-3 — approve the authentication/session values (`SPEC-AUTH-02`)

Values to be approved exactly as they stand in `packages/config/src/index.ts`:

| Bound | Value |
|---|---|
| OTP shape and lifetime | 6 digits, 10 minutes |
| Attempts per challenge | 5 |
| Resend cooldown | 60 seconds |
| Cumulative failed verifications | 10 per account per hour (fixed window, keyed on the target) |
| Issuance caps | 3 per hour, 6 per 24 hours |
| Reset consequence | every session revoked (`reason='password_reset'`), no session issued |
| Session lifetimes | 30-day idle, 90-day absolute; rotation grace 30 s |
| Abuse windows | 15 minutes; login 10 failures; reset 10 requests; registration 20; retention 8 windows |

| Field | Value |
|---|---|
| Accountable owner (Security Owner) | _(name — not filled by this changeset)_ |
| Co-approver (Product Owner) | _(name — not filled by this changeset)_ |
| Evidence reviewed | ☐ integration suite ☐ live HTTP run ☐ Argon2 benchmark ☐ provider quota assumptions ☐ usability/paste/autofill review ☐ other: ___ |
| Date | _(not filled)_ |
| Signature / evidence reference | _(not filled)_ |
  | Outcome | ☐ approve ☐ approve with conditions ☐ reject |

  > **Note (2026-10-12, amendment A-1).** The limit and window in the "Cumulative failed verifications" row
  > are unchanged (10 per 1-hour fixed window), but its **keying** changed in code (`afc5201`): the counter is
  > now per (account, caller network). An approval of this table alone would not cover that dimension — sign
  > §2.4 **A-1** for the keying, or request the keying be reverted.

  ### D-4 / D-5 — how F-3 and F-8 are closed

  | Field | F-3 | F-8 |
  |---|---|---|
  | Option chosen | _(not chosen by this packet's authors)_ — but the branch now **ships a candidate implementation of R1 + R2** (`afc5201`), so this field is now a *confirm/reject*, not a blank choice. The candidates remain R1 / R2 / R3 / R5 and any combination; if the owners choose one that is **not** R1 + R2 as shipped, that is a code change, not just a signature. | _(M1 / M2 / M4 — not chosen by this changeset)_ |
  | Requires `SPEC-AUTH-02` re-approval? | **Yes** — amendment A-1 in §2.4 (the cumulative budget's scope/keying). The rest of R1 is detection only and changes no approved value. | _(owner to state)_ |
  | Follow-up owner and date | _(not filled)_ — needed for the residual acceptance and for the R1 event's operational response (§A.7.6 of the risks record). | _(not filled)_ |
  | Does this close the finding? | ☐ yes, once the chosen option ships **and** A-1 is signed **and** the residual is accepted or controlled ☐ no — **today: mitigated, not closed** | ☐ yes ☐ no |
  | Signature / evidence reference | _(not filled)_ | _(not filled)_ |

## 5. Explicit non-claims

- No approver was named, no signature was simulated, and no decision is marked approved anywhere in
  this file or in this changeset.
  - F-3 is **not** closed and **not** accepted. As of the amendment note in §2.4, it is **mitigated in code
    for the remote vector** (commit `afc5201`, reproduced and regression-proven) while **remaining open**
    until the §2.4 amendment is signed and the shared-network residual is accepted or controlled. The
    original sentence of this packet — "not mitigated in code by this changeset" — remains true of *this*
    changeset; the branch tip has moved on, and the risks record's §A.7 is the authority on what shipped.
    It is a real, externally reachable availability weakness; the options and their costings are a request
    for a decision, not a substitute for one.
- F-8 is **not** quantified yet; the numbers in §3 are single samples and are labelled as such.
- This file does not close, weaken, or reinterpret any `SPEC-*` blocker, does not change any
  rate-limit value, and does not touch the SPEC-FIN-02 harness pins.
- PR #10 must not be merged on the strength of this file. It is the *input* to the decisions, not
  their outcome.
