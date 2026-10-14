# Solo-founder decision brief — F-3, A-1, and what must exist before real users

> **Prepared 2026-10-13 for the sole founder/developer of KFin.** This is **decision preparation, not a
> decision**. Every approval field below is blank and every status is `PENDING`; no approver, signature,
> role-holder, or completed review is claimed or implied. Nothing in this brief is an approval, and nothing
> here may be quoted as one.
>
> **What this brief is not.** It is not a specification cycle, not a remediation loop, and not a substitute
> for an independent security review. Where a security decision cannot be closed by the founder alone, this
> brief says so and offers the options — it does not pretend the gap away.
>
> **Nothing was changed to produce it.** No code, specification, pinned document, digest, migration, or
> approval field was touched. The brief is a new, uncommitted evidence file.

**Verified state at preparation time**

| Item | Value |
|---|---|
| Branch | `arena/bfaf5019-kfin-know-your-money-keep-your` |
| PR #10 head | `811728e840ba5dee450736bab278c297b4daefed` — local and remote agree; `open`, `draft`, `mergeable`, 97 files, 16 commits, `merged: false` |
| CI | run `38332502453` on `811728e` — `verify` **completed / success**, 14/14 steps |
| Working tree | clean (0 changes) |
| Governance checks | `evidence:check` clean · `evidence:test` 17/17 · 3 pinned digests match |

---

## 1. The governance reality of a one-person company

This matters before any decision below, because three of the five decisions are security decisions and the
repository's own draft governance rules do not contemplate a single person holding every role.

**What the current rules say.**

- `APPROVAL-AND-EVIDENCE-REGISTER.md` §3 lists twelve authorities — Product, Security, Operations, Release,
  Privacy/Legal, QA, Data, Financial Integrity, UX/Accessibility and others. **Every one is `Unassigned`.**
- §3.1 requires, before any blocker can close: a rule for **"separation of evidence producer and approver for
  Security, Financial Integrity, Privacy/Legal, and QA decisions"**. **Those rules are themselves unapproved**
  and remain part of the open `SPEC-GOV-01`.
- The approval-record template requires a **"named person and role"** for the accountable approver and for the
  mandatory co-approvers, and allows `ACCEPTED RISK` as an outcome with mandatory **conditions/expiry**.
- `SEC-GOV-04` requires every risk acceptance to document scenario, compensating controls, owner,
  **expiry/review date, and approver** — and forbids *silently* accepting critical data-isolation risk.
- `SEC-GOV-03` requires **named** accountable owners for production access, incident response, vulnerability
  triage, backup, restore and secret rotation **before beta**.
- The release checklist §0 states plainly that it **"cannot be used to manufacture an approval after
  implementation"**, and its sign-off table has a row for a **Security reviewer** and an **Operations owner**.

**The honest consequence.** As the sole founder you can lawfully decide product scope, risk appetite, budget,
and what you accept on your own account. You **cannot** produce an independent security review by signing
yourself, and no wording in this brief should be read as if you could. Concretely there is no ratified
single-person governance model in this repository, so you have exactly three honest paths for each security
decision:

| Path | What it produces | Cost | Limitation |
|---|---|---|---|
| **A — Independent review** | A genuine second-party security sign-off (`EVID-AUTH-THREAT`, `EVID-AUTH-BENCH` reviewers named) | Time and money; an external reviewer needs the branch, the evidence record and a scope | Slower, and no review is scheduled today |
| **B — Single-party acceptance, labelled as such** | A recorded `ACCEPTED RISK` by you as the accountable party, with scenario, compensating controls, **expiry/review date**, and an explicit statement that **no independent review was obtained** | Low; the record is honest about what it is | It does not satisfy §3.1's separation rule; it must therefore be revisited before the cohort expands |
| **C — Leave the decision open** | Nothing closes; the shipped fix remains an unauthorised candidate, and the release stays blocked | None in the short term | The remote denial-of-recovery attack stays in the code either way — path C does not remove it |

**Recommendation for the security decisions: path B now, with a commitment to path A before any expansion
beyond the invited cohort.** Rationale: for a closed, personally-invited five-user beta the *residual* exposure
is bounded and the alternative (leaving a stranger able to lock an invited user out of their own recovery) is
strictly worse. But path B is only defensible if the record says what it is, carries an expiry, and the
independent review happens before the circle widens. Editing the governance rules to invent a single-person
approval model is itself a decision you own — and it is **not** part of this task.

---

## 2. Decisions you can make yourself, as product owner

These are yours to make; no independent reviewer is needed, and no security claim is being made.

| # | Decision | Why it is yours |
|---|---|---|
| P-1 | **Beta cohort size and shape** — keep it at the planned five personally-invited users, or change it | Pure product scope; `MVP-SCOPE` §6 gate 11 already scopes the checklist to the initial five-user cohort |
| P-2 | **Who receives an invitation and how it is delivered** (out-of-band, to a channel you can verify) | Product and operational policy; it is also the main compensating control for D5 |
| P-3 | **What the beta promises users** — known limitations, supported browsers, no-uptime expectation, support route | Product communication; the checklist requires it to be *communicated*, not approved by anyone else |
| P-4 | **Which MVP features are deferred** (deletion UI, debt, recurring patterns, reminders, planned purchases, safe-to-spend, installable PWA) | All are recorded `NOT IMPLEMENTED` in the traceability matrix; deferral is a scope decision |
| P-5 | **Risk appetite for the closed beta** — i.e. whether you accept paths B above, with stated expiries | Owner's prerogative, provided it is recorded as acceptance, not as review |
| P-6 | **Budget and providers** (hosting, database, email, observability) under `OQ-17` | Commercial decision; it unblocks several hard blockers in §5 |
| P-7 | **Whether to adopt a single-person governance model** (role self-appointment, delegation/conflict rules) — a later, explicit decision, not this task | It is your company's governance design; it must be written down, not assumed |

---

## 3. Security risks that require explicit acknowledgement — and, where appropriate, independent review

Each of these is **not** closeable by product authority. They are listed separately so they are not bundled
into A-1.

| # | Risk | Why it needs acknowledgement | Independent review |
|---|---|---|---|
| S-1 | **F-3 remote denial of password recovery** (mitigated in code, unapproved) | The fix changes an approved-behaviour dimension; approving it is a security decision, not a product one | Recommended before cohort expansion; the amendment is small and reviewable in one sitting |
| S-2 | **F-3 residual — a caller inside the victim's `/24` or `/48` shares the reset bucket** | Demonstrated by a test; accepting it is a risk acceptance with a stated limitation | Should be part of the S-1 review |
| S-3 | **F-3 residual — callers with no resolvable address fall back to the account-only bucket** | Demonstrated; today hard to reach (no `trustProxy`), but the fallback is a real property | Same review; also a deployment-architecture decision (§5) |
| S-4 | **10 → 15 evaluated wrong-code attempts per hour, worst case** | A real reduction in defence in depth; must be accepted knowingly, not discovered later | Reviewer should confirm the bound (challenge cap × issuance cap) is the binding limit |
| S-5 | **Detection is transition-only** | Nine requests per window records nothing; "no events" ≠ "no probing" | Not reviewable yet — there is nothing to review until an alert consumer exists |
| S-6 | **D5 — every beta account's email stays unverified** | A product-shaped risk with security consequences (recovery depends on an unconfirmed address) | Security review recommended before public signup, not before the invited cohort |
| S-7 | **F-8 — reset-request timing is not equivalent** (issuing vs unknown medians 4.74 / 2.11 ms) | A measured enumeration side-channel, low severity, currently unmitigated | Measured and documented; a reviewer can validate the method rather than repeat it |
| S-8 | **No independent security review has happened at all** | `EVID-AUTH-THREAT`, `EVID-AUTH-BENCH` and every evidence row in the register is `Not evaluated`, `Unassigned` | This is the gap itself, not a risk inside it |

---

## 4. Operational controls that must exist before inviting real Private Beta users

The decisive question is not "can this be documented?" but "does it exist?". Four of these **cannot** be
closed by writing anything — they need software or infrastructure.

| # | Control | Can documentation close it? | Current state |
|---|---|---|---|
| O-1 | **A real email provider that can deliver a reset code to a stranger's inbox** | **No — needs code, a provider contract, domain, and credentials.** Only `none`/`memory`/`file` adapters exist, and the `file` sink is refused in production | Blocked behind `OQ-17` (provider selection — your P-6 decision). Without it, an invited user who forgets their password cannot recover it |
| O-2 | **Deployment with real TLS** | **No — needs infrastructure.** Production refuses insecure cookies (`AUTH_COOKIE_SECURE=true`), which requires HTTPS termination | `ADR-007` is Proposed; `OQ-17` deferred; no deployment exists |
| O-3 | **Monitoring + alert routing with a threshold and a responder** | **No — needs a monitoring stack.** No alert consumer exists for any security event, including the new F-3 event | `NOT RUN` (release gate 8) |
| O-4 | **Backup, restore, and rollback drill evidence** | **No — needs a database to back up and restore, and a rehearsal** | `PARTIAL` — migration rehearsal exists; restore/rollback needs infrastructure (gate 7) |
| O-5 | **Secret provisioning and rotation** (`AUTH_SECRET`, `FINANCIAL_PREVIEW_SIGNING_KEY`, DB credentials) | Partly — a written procedure plus a safe storage choice; the act itself is operational | Values are required deployment inputs; no rotation owner, no storage decision recorded |
| O-6 | **An access-controlled, logged path to clear an abuse-counter row** | **No — needs an operator tool with audit logging.** Direct database edits would bypass the audit design | Does not exist; this is why §6.3 of the A-1 packet cannot be adopted as written |
| O-7 | **Incident response: who is told, how fast, and what they do** | Yes — a short written procedure naming you as the only responder is legitimate, provided it is honest about working hours | `NOT RUN`; `SEC-GOV-03` requires a **named** owner before beta |
| O-8 | **Privacy/retention/consent for Vietnamese users** | Partly — requires legal review, and `SPEC-DEL-01` / `SPEC-SEC-02` are open | Not approved |
| O-9 | **Support boundaries** — support must never ask for a password or OTP | Yes — a written rule you can adopt as the only support person | Not adopted |

---

## 5. Decision 1 — A-1: the `SPEC-AUTH-02` reset-budget amendment

**Exact decision required.** Approve, approve-with-conditions, or reject the amendment recorded in
`2026-10-13-A1-DECISION-PACKET.md` §8.1: the cumulative reset failed-verification budget is keyed **per
(account, caller network)** at the same limit and window (10 per hour); the spend stays unconditional and
before any account lookup; the per-challenge cap (5), the 60-second resend cooldown and the per-account
issuance caps (3/hour, 6/day) stay account-wide; one operator-only event is written when the budget tips over.

**Trade-off and remaining risk.** Approving keeps the remote attack closed — today a stranger can send ten
requests and answer `429` to the real owner's own correct code for the rest of the hour. The price is the
worst-case ceiling on *evaluated* wrong-code submissions per account per hour moving **10 → 15**
(`10 × 30 = 300` vs a 10⁶ code space, with the daily cap unchanged at 30). Rejecting means reverting the
keying or shipping another authorised option — and keeping the denial of recovery, which for a financial app
is the worse trade for a beta.

**Recommended option: approve (path B — single-party acceptance, labelled as such), with three conditions.**
Rationale: the change removes a *remote* attack that needs no relationship to the victim; the residual it
introduces is narrow (§3 S-2/S-3); and the real bound on guessing was never this counter — it is the challenge
and issuance caps, which are untouched. Conditions: (a) the record states that no independent review was
obtained, (b) an independent security review is commissioned **before the cohort expands**, (c) a review date
is set.

**Evidence or safeguards required before Private Beta.** The eight executed regression cases (six fail on the
pre-fix code); the reproduction recipe; `pnpm run check` green with the pinned digests verified; the CI run;
and — as a safeguard, not a substitute — the founder's own read of the amendment wording, which is short
enough to review unaided, plus a written note of what was and was not reviewed independently.

**Approval record — remains blank until you decide.**

| Field | Value |
|---|---|
| Decision | _(blank — approve / approve with conditions / reject)_ |
| Accountable party | _(blank — name and role)_ |
| Independent reviewer | _(blank — none obtained; state this explicitly if path B)_ |
| Separation requirement (`SPEC-GOV-01` §3.1) | _(blank — record whether it is unmet and why)_ |
| Defence-in-depth reduction acknowledged (10 → 15) | _(blank)_ |
| Conditions / expiry / review date | _(blank)_ |
| Evidence reviewed | _(blank)_ |
| Date | _(blank)_ |
| Signature / evidence reference | _(blank)_ |
| Status | **PENDING** |

---

## 6. Decision 2 — F-3 residual risks: accept, or require a control

**Exact decision required.** For the two demonstrated residuals — a caller sharing the victim's `/24`/`/48`
shares the bucket, and a caller with no resolvable address falls back to the account-only bucket — choose:
**accept both** (with an owner and an expiry/review date), or **require an additional control** (an operator
unlock runbook, or a same-network control that does not exist and is not designed).

**Trade-off and remaining risk.** Accepting leaves a residual that requires the attacker to already be inside
the victim's network path — for a five-person invited beta, the realistic version of that is a shared household
or office connection, where the party "attacking" is often the same small group as the victim. Requiring a
control means building or operating something: the R5 unlock runbook needs O-6 (which does not exist), and a
same-network control is undesigned and would cost real engineering time.

**Recommended option: accept both residual cases with conditions and an expiry.** Conditions: (a) the cohort
stays closed and personally invited, (b) the operator triage in Decision 3 is adopted, (c) an independent
security review happens before expansion, (d) a review date is set. Rationale: the residual is strictly
narrower than the finding as measured, the exposure it leaves is low-probability for an invited cohort, and the
alternative spends engineering effort on a control whose trigger condition is unlikely to occur at this scale —
while the bigger launch blockers (O-1, O-2) are still unmet.

**Evidence or safeguards required before Private Beta.** The two cases asserting the residuals deliberately;
the code-level finding that `request.ip` is the socket peer address today; and a written statement of the
limitation in the beta's own limitations list so the first users are not surprised.

**Approval record — remains blank.**

| Field | Value |
|---|---|
| Decision | _(blank — accept / accept with conditions / require a control)_ |
| Accountable party | _(blank)_ |
| Residual accepted | _(blank — shared-network bucket / unresolved-address fallback / both / neither)_ |
| Compensating controls relied on | _(blank)_ |
| Expiry / review date | _(blank — required by `SEC-GOV-04` for any acceptance)_ |
| Independent reviewer | _(blank — none obtained)_ |
| Date | _(blank)_ |
| Signature / evidence reference | _(blank)_ |
| Status | **PENDING** |

---

## 7. Decision 3 — the operator response to a `reset_budget_exhausted` event

**Exact decision required.** Adopt, adopt-with-changes, or decline the response procedure in the A-1 packet §6
— accountable roles, triage queries, safe recovery, escalation, evidence retention. The procedure as written
includes a step that clears an abuse-counter row so a locked-out user can recover immediately.

**Trade-off and remaining risk.** Adopting the *triage and evidence* parts is nearly free and makes the new
event useful instead of silent. Adopting the *counter-clearing* step is not free: it needs an access-controlled,
logged operator action (O-6), and performing it by direct database access would bypass the audit design the
same repository deliberately built. Note that for this scale the clearing step is rarely needed at all: the
affected window rolls on its own within 15 minutes (request bucket) or one hour (cumulative bucket), and the
victim's own network is unaffected by another network's spend after the A-1 fix.

**Recommended option: adopt the triage, escalation and retention parts now; defer the counter-clearing step
until an audited operator path exists.** Rationale: this makes the event actionable for you as the only
operator, without creating an unaudited control path — and "wait for the window to roll" is an acceptable
answer for a five-user beta. Record the deferral as an accepted limitation with a review date, not as a
completed control.

**Evidence or safeguards required before Private Beta.** The transition-only event demonstrated by test; the
indexed triage queries; the append-only property of `security_events` (the audit trail survives any recovery
action); and an honest statement that response happens during your working hours only.

**Approval record — remains blank.**

| Field | Value |
|---|---|
| Decision | _(blank — adopt / adopt with changes / decline)_ |
| Accountable party (policy) | _(blank)_ |
| Executing operator | _(blank — sole operator today)_ |
| Counter-clearing step | _(blank — adopted / deferred until audited / declined)_ |
| Coverage window | _(blank — e.g. working hours only)_ |
| Review date | _(blank)_ |
| Independent reviewer | _(blank — none obtained)_ |
| Date | _(blank)_ |
| Signature / evidence reference | _(blank)_ |
| Status | **PENDING** |

---

## 8. Decision 4 — D5 / `SPEC-AUTH-01`: unverified-email registration policy (separate)

**Exact decision required.** Accept, accept-with-conditions, or reject the posture that **no email address is
ever verified**, for the invited beta cohort — and separately ratify the retirement of the post-verification
branch (`SPEC-AUTH-01`, superseded by OQ-20).

**Trade-off and remaining risk.** Accepting is what makes the beta usable at all without an email-verification
flow: registration consumes an invitation code and never emails, which removes an email-cost surface and a
delivery dependency. The cost is that every recovery message goes to an address the system has never
confirmed, that a mistyped address silently strands an account, and that the operator ends up carrying
identity decisions. Registering a *new* address to an existing account is not possible, which softens the
classic account-takeover angle. The `SPEC-AUTH-01` ratification is administrative but is a separate signature
from the risk acceptance — do not merge them.

**Recommended option: accept with conditions for the invited cohort, and ratify `SPEC-AUTH-01` separately.**
Conditions: (a) invitations are delivered out-of-band to a channel you can verify, (b) the beta states plainly
that email is unverified and that recovery depends on a working inbox, (c) an independent security review
before any public or self-service signup. Rationale: it matches the closed beta's reality, and its acceptance
condition — F-3 resolved or accepted — is now satisfiable only if you take Decision 1 and 2 first. **Order
matters: decide A-1 and the residual before D5, or D5 remains conditional.**

**Approval record — remains blank.** (Blank fields per the D5 record §5, plus: independent reviewer `(blank —
none obtained)`, expiry/review `(blank)`, status `PENDING`.)

---

## 9. Decision 5 — F-8: reset-request timing (separate)

**Exact decision required.** Choose **M2** (apply a fixed response-time floor to every outcome, e.g. 15 ms),
**M4** (accept the measured difference as residual risk with the numbers attached), or **M1 alone** (keep
measuring without deciding). All three are separate from A-1.

**Trade-off and remaining risk.** The measured signal is real but weak: issuing vs unknown medians 4.74 ms vs
2.11 ms, HTTP cross-check +4.2 ms, over a noisy network requiring many samples, and what it reveals is
"this address belongs to an active beta account". M2 removes the signal at the cost of making **every** reset
request 15 ms slower and adding a small amount of code to a security-sensitive path — a change that would
itself deserve a test and a re-measurement. Accepting leaves an enumeration side-channel in a product that
tried hard to close the content and status channels.

**Recommended option: M4 for the closed invited cohort, with M1's harness retained, and M2 reconsidered
before expansion.** Rationale: for five invited users the information value of the leak is close to nil, and
adding a timing floor is a change to the reset path that should not be rushed into a frozen branch hours
before a beta. If the reviewer who examines A-1 (path A) recommends M2, take it in one small, separately
tested change.

**Evidence or safeguards required before Private Beta.** The measured table, the method and the reproduction
recipe already in the risks record Part B — so the numbers can be re-derived rather than trusted.

**Approval record — remains blank.** (Decision `(blank — M1 / M2 / M4)`; accountable party `(blank)`;
independent reviewer `(blank — none obtained)`; expiry/review `(blank)`; date `(blank)`; status `PENDING`.)

---

## 10. Release blockers that documentation cannot remove

Ordered by what actually stops real users from being invited. None of these is an approval matter.

| # | Blocker | Why documentation cannot close it | Effort to close |
|---|---|---|---|
| B-1 | **No production email provider** (O-1) | Needs a provider decision (`OQ-17`), a real adapter, domain setup and credentials. Until then a reset code cannot reach a user, and password recovery for real users does not work | Provider decision + adapter code + configuration |
| B-2 | **No deployment and no TLS** (O-2) | Needs infrastructure; secure cookies are mandatory in production | Deployment work + domain + certificates |
| B-3 | **No monitoring, alerts, or responder** (O-3) | Needs an observability stack; nothing consumes any security event today | Provider (P-6) + instrumenting the alert path |
| B-4 | **No backup/restore/rollback drill** (O-4) | Needs a running database, a backup, an isolated restore, and a rehearsal | Infrastructure + one rehearsal |
| B-5 | **No audited operator path for counter clearing** (O-6) | Needs an operator tool with logging; direct edits bypass the audit design | Small, but real, engineering work |
| B-6 | **No WAF/edge abuse control** | The checklist expects edge/DDoS controls; none is configured | Provider decision + configuration |
| B-7 | **159 unchecked release-checklist items**, including all twelve `SPEC-*` rows and an unsigned sign-off table | Each row requires a real decision, evidence, or review — not a checkbox | Decisions (yours) + reviews (not yours alone) |
| B-8 | **No independent security review at all** (S-8) | You cannot self-review | Commissioning it (time/money) |

**What is genuinely in good shape.** The financial core is verified with passing tests; authentication and
abuse controls are implemented and covered by real-PostgreSQL integration tests (771 passing tests, 38 files);
the F-3 mitigation is regression-proven; the governance record is unusually complete for a solo project, and
every gap above is *recorded* rather than hidden.

---

## 11. Những quyết định cần anh/chị đưa ra

*(Phần này viết bằng tiếng Việt, chỉ gồm các quyết định ở mức kinh doanh — những chi tiết kỹ thuật đã được
xử lý bằng khuyến nghị kỹ thuật ở trên, anh/chị không cần quyết.)*

**Việc anh/chị có thể tự quyết (không cần ai duyệt):**

1. **Quy mô và thành phần nhóm beta:** giữ đúng 5 người được mời trực tiếp như kế hoạch, hay thay đổi?
2. **Cách mời và xác minh người dùng:** mời qua kênh riêng mà anh/chị biết chắc (gọi điện, nhắn tin), có đúng không?
3. **Cam kết với người dùng beta:** nói rõ đây là bản thử nghiệm, email chưa xác minh, không cam kết uptime — anh/chị đồng ý nội dung này chứ?
4. **Tính năng tạm gác:** các phần chưa làm (xoá dữ liệu, nợ, lịch định kỳ, nhắc nhở, mua sắm dự kiến, PWA) tiếp tục để sau?
5. **Ngân sách và nhà cung cấp** (máy chủ, email, giám sát): anh/chị muốn chọn nhà cung cấp nào và mức chi bao nhiêu? Đây là việc chặn nhiều thứ nhất — **chưa có nhà cung cấp email thì người dùng quên mật khẩu sẽ không thể tự khôi phục.**
6. **Chấp nhận rủi ro cho nhóm beta kín:** anh/chị có đồng ý tự chịu trách nhiệm (không có người thứ hai kiểm tra độc lập) cho các rủi ro bảo mật, với điều kiện thuê kiểm tra độc lập trước khi mở rộng?

**Ba quyết định bảo mật (cần anh/chị quyết, và nên có người kiểm tra độc lập trước khi mở rộng nhóm):**

7. **A-1 (sửa lỗi khoá tài khoản khôi phục mật khẩu):** đồng ý — hay từ chối? *Khuyến nghị: đồng ý*, vì hiện tại người lạ có thể khoá việc khôi phục mật khẩu của người dùng. Cái giá phải nói rõ: số lần thử sai tối đa mỗi giờ mỗi tài khoản tăng từ 10 lên 15 (vẫn rất nhỏ so với 1.000.000 mã).
8. **Rủi ro còn lại của F-3:** chấp nhận (kèm hạn xem lại) hay yêu cầu làm thêm biện pháp? *Khuyến nghị: chấp nhận trong nhóm kín*, vì kẻ tấn công phải ở cùng mạng với nạn nhân.
9. **Quy trình xử lý khi có sự kiện bất thường:** áp dụng ngay phần theo dõi và ghi nhận; **hoãn** phần tự tay xoá bộ đếm cho đến khi có công cụ có ghi log. *Khuyến nghị: làm như vậy* — với 5 người dùng, chờ 15 phút là chấp nhận được.

**Hai việc cần tách riêng, đừng gộp vào A-1:**

10. **Chính sách email chưa xác minh (D5):** chấp nhận có điều kiện cho nhóm mời trực tiếp — và **trước hết phải quyết mục 7 và 8**, vì việc chấp nhận D5 phụ thuộc vào kết quả của F-3.
11. **Chênh lệch thời gian phản hồi (F-8):** *khuyến nghị:* chấp nhận cho nhóm kín (đã có số đo cụ thể), xem lại trước khi mở rộng. Nếu chuyên gia được thuê khuyên sửa, thì sửa thành một thay đổi nhỏ riêng biệt.

**Điều cần nhớ:** dù anh/chị quyết thế nào, **KFin vẫn CHƯA SẴN SÀNG PHÁT HÀNH** cho tới khi có nhà cung cấp
email thật (B-1), máy chủ có HTTPS (B-2), giám sát và cảnh báo (B-3), và một buổi diễn tập sao lưu/phục hồi
(B-4). Bốn việc đó không thể giải quyết bằng giấy tờ.

---

## 12. Non-claims and limits of this brief

- **No approval, acceptance, review, signature, appointment, or decision** is made or implied here; every
  field above is blank and every status `PENDING`.
- **No independent security review has been performed.** Where this brief recommends "path B" it recommends a
  *labelled single-party acceptance*, which is not the same thing and is not presented as satisfying the
  register's separation rule.
- **F-3 remains `MITIGATED` (remote vector, in code) and `OPEN`**; **F-8 unresolved**; **D5 unsigned**;
  **`SPEC-AUTH-01` unratified**. **KFin is NOT READY FOR RELEASE.**
- **Nothing was merged, deployed, committed, or run against production or Supabase**, and no new specification
  or remediation cycle was started.
- **Not verified in this session:** whether the deployed environment can resolve client addresses (no
  deployment exists); real-world ISP/CGNAT co-tenancy rates; the effort and cost of an external security
  review; and whether any provider decision under `OQ-17` has been taken outside the repository — the
  repository records it as deferred, and this brief reports only what the repository says.
