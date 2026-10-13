# F-3 decision handoff — implementation frozen at `95093f2`

> **Prepared 2026-10-13 (Asia/Saigon) for the decision owners.** Implementation is **frozen**: no code,
> specification, migration, configuration, or pinned-digest change accompanies this handoff, and none is
> planned pending the decisions below.
>
> **All approval fields remain blank and every status `PENDING`.** No approver, owner, or date has been
> entered, and nothing here may be read as an approval, an acceptance, or an adopted procedure. This handoff
> is a *summary of* [`2026-10-13-A1-DECISION-PACKET.md`](2026-10-13-A1-DECISION-PACKET.md), which remains the
> working detail; the normative amendment wording stays §2.4 of
> [`2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md`](2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md).
>
> **This document is deliberately not committed.** It is delivered as a workspace artifact so the branch the
> owners will sign against stays exactly where it was verified.

## 0. Frozen state, verified

| Item | Verified value |
|---|---|
| Branch | `arena/bfaf5019-kfin-know-your-money-keep-your` (unchanged) |
| Head | `95093f23c813516d4f6eb74afa849a2e3da77f9e` — local and remote agree |
| Pull request | **#10**, `open`, `draft`, `mergeable`, 96 files, 15 commits |
| CI | run **38331576679** on `95093f2` — `verify` **completed / success**, 14/14 steps |
| Working tree | clean (0 changes) at the verified SHA |
| Governance checks re-run here | `evidence:check` clean (25 modules / 29 harness files) · `evidence:test` **17/17** · the three SHA-256 pins in `constants.mjs` **match** |
| Implementation freeze | No code change since `afc5201`; no change of any kind since `95093f2` |

Three decisions are outstanding. They are **independent**: each can be approved, modified, or rejected
without the others, although deciding #1 without #2 leaves F-3 open on the residual and deciding #2/#3
without #1 leaves the shipped keying unauthorised.

---

## 1. Decision 1 — A-1: the `SPEC-AUTH-02` reset-budget amendment

**The exact choice required.** Approve — or approve-with-conditions, or reject — the amendment reproduced
verbatim in the packet §8.1: the cumulative reset failed-verification budget is keyed **per (account,
caller network)** at the same limit and window (10 per 1 hour), the spend stays unconditional and
**pre-lookup**, the per-challenge cap (5), the 60-second resend cooldown and the per-account issuance caps
(3/hour, 6/day) stay **account-wide and unchanged**, and one operator-only event is written on the
transition into exhaustion. The signer is also asked to acknowledge the one weakening in §4.1 below.

**Security consequences.**
- Approved: the shipped fix keeps the remote denial closed — an anonymous caller on another network can no
  longer deny a stranger's password recovery, which is the measured F-3 attack. The behaviour then matches an
  approved specification instead of diverging from one.
- Rejected: the code must revert to the pre-`afc5201` keying or another authorised option must ship. F-3's
  remote denial — ten submissions from anywhere answering `429` to the owner's own correct code — returns and
  stays a merge blocker.
- Either way: anti-enumeration is untouched (known and unknown addresses answer identically through the
  boundary — asserted), and the true bound on guessing is unchanged because it was always the challenge and
  issuance caps, not this counter.

**Operational consequences.** Per-network buckets mean one network's flood no longer throttles another
network's users; the price is that the account-wide hourly ceiling on *evaluated* submissions moves from 10 to
15 in the worst case (§4.1). A new operator-only event (`password_reset_failed`,
`metadata.reason = 'reset_budget_exhausted'`) exists and has **no consumer** — decisions #2 and #3 are what make
it useful.

**Evidence available.** Eight executed regression cases (six of which fail against the pre-fix source —
the victim's own completion throwing `AUTH_RATE_LIMITED`); 771 passing tests / 38 files and `pnpm run check`
exit 0 on a disposable PostgreSQL 17.6 with the non-production target flag; CI `verify` success on the frozen
SHA; the exact amendment text; and the post-approval pin-update procedure (packet §8.4).

**Accountable role.** **Security Owner** accountable, **Product Owner** co-approving — the register row
`APPROVAL-AND-EVIDENCE-REGISTER.md:69` names those roles. **Both are currently `Unassigned`**, so a signature
cannot be lawfully obtained until the appointment exists (`SPEC-GOV-01` open). No name is invented here.

**What remains unknown.** How many real beta users share an ISP/CGNAT prefix (no measurement exists); whether
the eventual deployment resolves client addresses at all (see §4.2–4.3); the real-world event volume the new
event will produce; and whether the 10 → 15 worst-case change sits inside the owners' risk appetite — that is
a judgment no test can supply.

---

## 2. Decision 2 — F-3 residual risks: accept, or require a control

**The exact choice required.** For the two demonstrated residuals — (a) a caller sharing the victim's IPv4 /24
or IPv6 /48 shares that bucket, and (b) a caller whose address cannot be resolved falls back to the
account-only key while `reset_ip` is skipped — choose one:
**accept both** (naming an accountable owner and an expiry/review date), or **require an additional control**
(the R5 operator-unlock concept, or a same-network control that does not exist yet and is not designed).

**Security consequences.**
- Accepted: the remote attack stays closed, but an attacker *inside* the victim's own network path can still
  exhaust their bucket, and addressless callers share one account-only bucket with each other. Both are
  strictly narrower than the finding as measured (which required no relationship to the victim at all).
- Require R5: removes the practical impact for a small beta while an operator is available, but adds an
  operational control with a load-bearing access-control requirement (see #3) and does not change either
  residual's mechanism.
- Unchanged either way: no account state is exposed, no session is granted, and the audit trail cannot be
  altered by any recovery action (`security_events` is append-only by trigger).

**Operational consequences.** Accepting means the support path must recognise the co-tenant case (a user
locked out by activity on their own uplink) and answer it without disclosure. Requiring a control means
someone must be accountable for executing it — which needs #3.

**Evidence available.** Case 8 asserts the shared-prefix bucket deliberately, so it cannot be mistaken for an
oversight. Case 7 asserts the addressless fallback and shows it is confined to that path: the same account
reset from a real network is unaffected. Code-level finding for the fallback's reachability: the API builds
Fastify **without `trustProxy`**, so `request.ip` is the socket peer address and a normal HTTP request always
carries one — the null path is a hardening gap, not a measured hole, today.

**Accountable role.** **Security Owner** (threat acceptance), **Product Owner** informed for the user-facing
consequence. Both `Unassigned`.

**What remains unknown.** Real co-tenancy rates under Vietnamese ISP/CGNAT aggregation; whether the deployment
will preserve the current "peer address" behaviour (if a proxy is introduced and `trustProxy` is enabled
without a trusted-hop policy, a caller could choose its own bucket — a deployment decision, not an A-1
defect); and whether an operator unlock would actually be available at the moment it is needed.

---

## 3. Decision 3 — the operator-response procedure: adopt or reject

**The exact choice required.** Adopt §6 of the packet as the response to a `reset_budget_exhausted` event —
roles, triage queries, safe recovery, escalation, retention — **or** adopt-with-changes, **or** decline. The
same signature must name the executing Operations Owner, a coverage window, and the **access control and
operator log** for the counter-clearing step.

**Security consequences.** Adopting turns a recorded event into a handled one and closes the "nobody sees it"
gap for the residual in #2. Declining leaves the event written but unread — detection without response — and
leaves the residual with no compensating control. The recovery action itself is deliberately narrow: it clears
one `auth_attempt_counters` row and can never touch or delete the append-only security event.

**Operational consequences.** Adopting requires a control the repository does not have today: an
access-controlled counter-clearing action with its own log. Without that, the procedure cannot be adopted
honestly. There is also no on-call rotation and no alerting consumer, so today's realistic capability is
"answerable after the fact", not "detected at the time" — the signer should state which of the two they intend.

**Evidence available.** Case 6 shows exactly one event per tip-over regardless of flood length; the event's
fields (keyed digests, bounded metadata, no secrets) and the immutability trigger are in migration `0004` and
the domain event map; the triage queries are indexed (`security_events_target_idx`); counter rows are pruned
(~2 h) and are therefore not evidence, while events retain for the 24-month baseline.

**Accountable role.** **Security Owner** (policy) and **Operations Owner** (execution). Both `Unassigned`.

**What remains unknown.** Whether a responder exists at all; the event volume under real traffic; alert
thresholds; and whether the counter-clearing action will be hosted by an operator console or by direct
database access — the latter needs its own access-control decision.

---

## 4. The four technical points, in plain language

### 4.1 The evaluated wrong-code attempts per account per hour: 10 → 15

Before the fix, one account-wide counter capped **all** wrong-code submissions against an account, from any
network, at **10 per hour** — that global cap was also the denial vector. After the fix that counter is
per (account, network), so the binding limits become the ones that were always account-wide: **five attempts
per challenge** and **three challenges issued per account per hour** → a worst case of **15 evaluated
submissions per hour** (and 30 per day, unchanged, from the daily issuance cap of 6).

Reaching 15 requires the attacker to obtain all three hourly challenges from at least two networks, and it was
measured directly: with three attacking networks, only **five** submissions were ever evaluated against the
challenge digest before it retired. Against a 10⁶ code space and a ten-minute challenge lifetime, five extra
guesses per hour is a negligible change to brute-force resistance — but it is a real reduction in defence in
depth, and it is stated here so it is accepted knowingly rather than discovered later. A single network still
gets exactly 10.

### 4.2 The shared-network bucket

The counter is keyed on the caller's network prefix: IPv4 /24 (256 addresses) or IPv6 /48. A caller inside the
victim's own prefix is indistinguishable from the victim at this layer and shares the bucket, so such a caller
can still throttle the victim's recovery. This is demonstrated (case 8), it is narrower than the original
finding (which needed no relationship to the victim), and no fix exists in the tree — the honest options are to
accept it or to require an additional control. What is **not** known: how common that co-tenancy is in
practice, because no data on the beta's ISP/CGNAT mix has been collected.

### 4.3 The unresolved-address fallback

If no client address is resolvable, the target counter falls back to the account-only key — the pre-fix
behaviour for that path — and the per-network `reset_ip` throttle is skipped entirely, because the repository
skips a scope whose value is absent. Addressless callers therefore share one bucket with each other
(demonstrated, case 7), though not with callers that do have an address. In the current build this path is
hard to reach: Fastify is constructed without `trustProxy`, so `request.ip` is the socket peer address. Two
things follow for the owners: the fallback should be treated as a stated limitation, and **if** the deployment
later introduces a reverse proxy, enabling `trustProxy` without a trusted-hop policy would let a caller pick
its own bucket and defeat the fix — a decision to take deliberately, in the deployment architecture, not by
default.

### 4.4 Detection when requests stay below the threshold

The event is written **only** on the transition into exhaustion (`count = limit + 1`), deliberately, so a
sustained flood cannot become an event flood. The consequence must be stated plainly: an attacker who stays
just under the limit — nine requests per window, per network — is **never recorded**, and "no events" therefore
does not mean "no probing". Attempt-level failures still exist for other paths, but the budget-specific signal
is transition-only. Nothing consumes the event today: no alert rule, no paging, no dashboard. Until decision #3
names an owner and a coverage window, the detection capability is evidence for after-the-fact reconstruction,
not an alarm.

---

## 5. Standing blockers — separate from the three F-3 decisions

None of the items below is a condition for deciding #1–#3, and approving all three does not move any of them.
They are listed so the F-3 decision is not mistaken for release readiness.

| # | Blocker | Current state (as recorded in the repository) |
|---|---|---|
| 1 | **F-8** — reset-request timing | **CONFIRMED**, no mitigation chosen. Issuing vs unknown medians 4.74 / 2.11 ms with largely disjoint ranges; HTTP cross-check +4.2 ms; single-session measurements. M2 mitigation or M4 informed acceptance unselected |
| 2 | **D5** — unverified-email beta risk | **Recorded, unsigned, not accepted.** Acceptance condition ties it to F-3; F-3 is now mitigated-but-open, so accepting D5 today still accepts an open F-3 |
| 3 | **`SPEC-AUTH-01`** | **Superseded** by OQ-20; awaiting Product + Security ratification (D-2) |
| 4 | **Other `SPEC-*` rows** | All 12 open in the register: `SPEC-AUTH-01/02`, `SPEC-FIN-01/02`, `SPEC-DEBT-01`, `SPEC-SCH-01`, `SPEC-REM-01`, `SPEC-SEC-01/02`, `SPEC-DEL-01`, `SPEC-UX-01`, `SPEC-GOV-01` — each awaiting named approvers and evidence |
| 5 | **ADRs** | ADR-002, ADR-003, ADR-004, ADR-008 **Blocked**; ADR-001, ADR-005, ADR-006, ADR-007, ADR-009 **Proposed** — none Accepted |
| 6 | **Governance roles** | `SPEC-GOV-01` open: **every** register authority (Product, Security, Operations, Release, Privacy/Legal, UX/Accessibility, QA, Data, Financial Integrity, and the rest) is `Unassigned` — this is what blocks signing #1–#3 |
| 7 | **Release gates** | All 11 `MVP-SCOPE` §6 conditions evaluated in the traceability matrix: 1, 2, 9, 10, 11 **OPEN**; 3, 4, 6, 7 **PARTIAL**; 5 and 8 **NOT RUN** |
| 8 | **Accessibility** | `SPEC-UX-01` open; WCAG 2.2 AA core-flow and small-screen review **NOT RUN**; 159 unchecked items in the release checklist |
| 9 | **Backup / restore / rollback** | No restore drill in an isolated environment and no rollback rehearsal evidence; requires infrastructure that the beta does not yet have |
| 10 | **Monitoring / incident readiness** | **NOT RUN** — no alert routing, no thresholds, no on-call, no incident runbooks; no consumer for the security events that do exist |
| 11 | **Privacy / legal** | `SPEC-DEL-01` open (deletion/legal/restore/provider contract), `SPEC-SEC-02` open (event classification), Vietnamese privacy/retention/consent review not done; Privacy/Legal Owner unassigned |
| 12 | **Unimplemented MVP capability** | Deletion requests, debt profiles, recurring patterns, the notification centre, planned purchases, safe-to-spend, and the installable PWA — all **NOT IMPLEMENTED** in the matrix; the financial core is the verified part |
| 13 | **Release checklist** | 159 items unchecked, including specification gates, and the sign-off section unsigned for the initial five-user cohort |

---

## 6. What happens after a decision — and what must not happen before one

Once the three decisions are signed (or rejected) by authorised owners:

1. The owner's **own signed commit** applies the amendment per packet §8.4: rewrite the `SEC-AUTH-20`
   sentence, update the `TEST-STRATEGY.md` budget row, advance the three pins in
   `evidence/spec-fin-02/src/constants.mjs` **in that same commit** with the new revision recorded, add the
   `DECISION-LOG.md` entry and the register approval row, then re-run `pnpm run evidence:check`,
   `pnpm run evidence:test` and `pnpm run check`.
2. F-3's status may move toward *closed* only when all three decisions are in force — including the residual's
   disposition and the operator response — and never on the strength of the code alone.

**Until that commit exists: no pinned document and no digest may be edited** (already true — verified above),
no approval field may be filled by anyone other than the named owner, and the branch stays at `95093f2`.

---

## 7. Non-claims

- **No approval, acceptance, adoption, signature, appointment, or date** is asserted or implied anywhere in
  this handoff, and none follows from the code existing, the tests passing, or CI being green.
- **F-3 is `MITIGATED` (remote vector, in code) and `OPEN`** (amendment unsigned, residual unaccepted,
  operator response unadopted). **F-8 is unresolved. D5 is unsigned. `SPEC-AUTH-01` is unratified.**
- **Nothing was merged, deployed, or run against production or Supabase**; no feature work or new
  specification cycle was opened; no code change was made for this handoff.
- **KFin remains NOT READY FOR RELEASE** until every applicable security, governance, and release requirement
  in §5 is genuinely satisfied and evidenced.
