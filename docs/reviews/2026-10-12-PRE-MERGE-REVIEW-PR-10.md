# Pre-merge review — PR #10 at `4866d13`

**Date:** 2026-10-12
**Reviewer:** implementation review (Arena agent session), acting for the Product/Security owners
**Reviewed revision:** `4866d13d35cbacf22d37322f2eff2fbb60b24c87` (branch `arena/bfaf5019-kfin-know-your-money-keep-your`)
**Base:** `main` @ `28ee85f2c0137a97d52133bff471526d8b661926`
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2` (unchanged, not touched)
**Scope of this task:** review and planning only. **No merge, no deployment, no write to any shared or production database, no owner approval claimed.**

## 0. Verdict

> **NOT READY FOR MERGE.**
>
> Every technical gate is green and no code defect was found that blocks merging. What is missing is
> completeness of the record and of two owner decisions: a false statement inside the commit that
> would be merged (F-2/F-5), a PR description that describes a different change than the branch
> contains (F-4), an unrecorded beta risk acceptance (F-1), and an undocumented availability
> weakness in the approved reset budget (F-3). None of these needs a redesign; none of them is a
> code defect. The exact conditions are in §9.

## 1. Pull request, CI, working tree, diff

| Check | Result |
|---|---|
| Local `HEAD` vs PR head | `4866d13` = `4866d13` (equal); `mergeable: MERGEABLE`, `mergeStateStatus: CLEAN`, `base: main` |
| Working tree | clean (`git status --porcelain` empty) — **before** this review file was written; see §10 |
| GitHub access | `git ls-remote origin` OK; `gh auth status` → user `kaytrh255`, HTTPS token present |
| CI on `4866d13` | `verify` → **success** (all 10 steps: evidence harness, typecheck, unit/API, real-PostgreSQL integration) |
| Commits vs base | 8 commits: `de91113`, `33357ea`, `8d6cc6e`, `66494d2`, `27582e3` (Milestones 8–10), `9456067`, `ac715dc` (spec revision), `4866d13` (this work) |
| Diff vs base | **87 files, +7 874 / −957** |
| Suspicious paths in the diff (`.env`, secrets, keys, `node_modules`, `dist/`, logs) | **none** |
| `apps/web/dist` | untracked and git-ignored (`.gitignore:12`), rebuilt, consistent with source (§4) |

**F-4 (MEDIUM, governance).** The PR title and body describe *"Milestone 10 — close E-5 … (5 files)"*.
The branch now carries 87 files across four milestones. Merging the PR as described would apply a
substantially larger change than its description states. `gh pr view 10` — title and body both stale.
The description must be rewritten (or the PR re-scoped) before merge; that is an owner action, and it
was not taken unilaterally in this review.

## 2. Migration `0007_otp_only_for_password_reset.sql`

### 2.1 What it does and why it is safe

| Step | Statement | Lock profile |
|---|---|---|
| 1 | `ADD COLUMN email_verification_state TEXT` (nullable) | `ACCESS EXCLUSIVE`, metadata only, no rewrite (nullable add, no default) |
| 2 | Bounded backfill `UPDATE` (only rows `IS NULL`) | same transaction, reuses the lock |
| 3 | `SET NOT NULL` + agreement `CHECK` (not `NOT VALID`) | full scan under the already-held lock |
| 4 | `UPDATE users SET status='active' WHERE status='pending_verification'` | bounded |
| 5 | Drop/re-add `users_status_check` without `pending_verification` | bounded |
| 6 | Supersede outstanding non-reset challenges (`superseded_at`, never `DELETE`, never purpose rewrite) | bounded |
| 7 | `kfin_auth_challenges_issuance_guard()` + `BEFORE INSERT` trigger refusing any purpose but `password_reset` | metadata only |

The runner executes the whole file in one transaction with `lock_timeout = '5000ms'` and
`statement_timeout = '30000ms'` (`packages/database/src/migrations.ts:71-80`), so a blocked lock
aborts and rolls back instead of hanging a deploy. The first `ALTER TABLE` takes `ACCESS EXCLUSIVE`
on `users` and holds it for the transaction, so no concurrent write can slip between the backfill and
the constraint swap. Beta-scale row counts make the scans trivial. **Reviewed: safe.**

### 2.2 Upgrade from legacy data — rehearsed, not assumed

Rehearsed on the disposable local cluster (PostgreSQL 17.6) in a scratch database, using **the real
migration runner** with temporary directories holding the real migration files
(`/tmp/kfin-review/rehearse-0007.mts`). Legacy rows seeded after `0001–0006`: a
`pending_verification` account, an `active` never-verified account, an `active` verified account, a
`locked` account, one outstanding `email_verification` challenge, one **consumed** `email_verification`
challenge, and one outstanding `password_reset` challenge.

| Rehearsal | Result |
|---|---|
| Fresh install: `0001…0007` in one pass | PASS — exactly 7 migrations applied |
| `0007` applied to a schema carrying legacy rows | PASS |
| Account states after upgrade | `pending→active+unverified`, `active→active+unverified`, verified stayed `active+verified`, `locked` stayed `locked+unverified` — **no account was promoted to verified** |
| Challenge history | outstanding verification challenge → `superseded`; consumed one → `consumed` (untouched); `password_reset` challenge → `active` (untouched); **nothing deleted or rewritten** |
| New `email_verification` challenge | refused, SQLSTATE `23514` |
| New `pending_verification` account | refused (`23502` on the new NOT NULL column, and `23514` on the status check when the column is supplied — F-14) |
| `verified` without a verification instant | refused, `23514` |
| `unverified` while an instant exists | refused, `23514` |
| New `password_reset` challenge | accepted |

Email-state integrity is now enforced by the database, not by review: the two representations can no
longer disagree.

### 2.3 Rollback and forward recovery

- **There is no down-migration.** The runner is forward-only and checksum-pinned
  (`migrations.ts:33-53`); an edited `.sql` file is rejected (`Migration N checksum does not match`).
  Reverting the *code* alone is impossible: pre-`0007` code writes `status='pending_verification'` and
  inserts new `email_verification` challenges, both of which the migrated schema refuses (`23514`), and
  it omits `email_verification_state`, which is `NOT NULL` (`23502`).
- **Recovery is a forward migration (`0008`).** Rehearsed in the scratch database: a 7-statement
  transaction — `DROP TRIGGER`, `DROP FUNCTION`, `DROP CONSTRAINT users_email_verification_state_ck`,
  `DROP COLUMN email_verification_state`, restore the five-value `users_status_check` — completed in
  **4 ms** and made the pre-`0007` code shape insertable again. The reversal is expressible and cheap;
  committing it as `0008` is a separate governed change and was **not** created here.
- **Deployment ordering constraint (operational, must be stated in the release procedure).** `0007`
  and `4866d13` must ship together, migration first. During the window between the migration and the
  code deploy, registration fails for pre-`4866d13` code (`23502`/`23514`) — a hard stop, not a silent
  wrong state. Recommended: apply `0007` inside a short maintenance window, then deploy, then
  smoke-test registration and a reset; rollback = forward `0008` or restore from backup.
- The migration is one-way in terms of *data*: after `0007`, `pending_verification` is not
  recoverable as a distinct state (those accounts became `active`). The invitation row remains the
  admission evidence, which is why the migration deliberately does not rewrite it.

## 3. Reset OTP, limits, replay, enumeration, sessions, cookies

### 3.1 Manual code review

| Control | Where | Assessment |
|---|---|---|
| 6-digit OTP, CSPRNG, unbiased | `packages/domain/src/auth.ts:140` (`randomInt` from `node:crypto`); `packages/config/src/index.ts` `otpDigits: 6` | correct |
| Digest-only storage, purpose-separated | `auth-repository.ts:932` (`challenge-secret:password_reset` keyed digest) | correct; the plaintext exists only in request-process memory |
| Lifetime 10 min | `otpLifetimeMs`; expiry branch supersedes the challenge and answers `AUTH_CHALLENGE_EXPIRED` | correct |
| Five attempts per challenge | `maximumAttempts: 5`; exhaustion supersedes the challenge and answers `AUTH_CHALLENGE_ATTEMPTS_EXHAUSTED` | correct |
| Cumulative budget 10/hour across superseded challenges | `resetPassword` lines ~993-1001, scope `verification_target`, window 1 h; spent **before** the account/challenge lookup | correct as designed — and see **F-3** |
| Resend cooldown 60 s | `requestPasswordReset` ~946-954; a live challenge inside cooldown is neither re-sent nor replaced | correct |
| Issuance caps 3/h and 6/24 h | `withinIssuanceCap` (`auth-repository.ts:1309-1330`), counted per user+purpose from `auth_challenges` | correct; a capped account silently degrades to `issued:false` |
| Single-use / replay | challenge selected `FOR UPDATE` with `consumed_at IS NULL AND superseded_at IS NULL`, then consumed atomically; the guard trigger makes consumption irreversible (`0004:116-142`) | correct |
| Session revocation on reset | `revokeSessionRows(..., exceptSessionId: null, reason: 'password_reset')`, no session issued | correct |
| Cookie invalidation | `clearSessionCookies` clears both `__Host-kfin_session` and `kfin_csrf` (`auth-routes.ts:230-235`, used at `:454`); asserted at `apps/api/test/auth-routes.test.ts:423` | correct |
| Enumerability of the reset *request* | four outcomes — unknown, non-active, in cooldown, capped — all return `{accepted:true}` and send nothing | correct; identical bodies measured live (§3.2) |
| Enumerability of `resetPassword` | `pre-challenge` and `wrong-code` both answer `AUTH_CHALLENGE_INVALID` with identical bodies | correct, measured live |
| Legacy statuses not selectable at login | `if (user.status !== 'active')` (`auth-repository.ts:535`); `authenticate` gates on `user_status !== 'active'` | correct; `locked`/`disabled` remain non-self-recoverable, recorded operator-only as `access_denied_unverified` (F-11) |
| Password policy preserved | `changePassword`/`register`/`resetPassword` all call `assertPassword`; bound checked **before** the challenge is consumed, so a rejected password does not burn the code | correct |

### 3.2 Live wire re-verification (disposable scratch database, real HTTP)

API booted as `tsx apps/api/src/server.ts` against a scratch database migrated to `0007`, with
`EMAIL_DELIVERY_ADAPTER=file` and cookies in insecure-local mode; every request carried a same-origin
`Origin` header. Codes, cookies, and the invitation code were held in shell variables and never printed;
the sink directory was deleted afterwards.

| Step | Result |
|---|---|
| `POST /auth/register` | `202`, body exactly `{"accepted":true}` (17 bytes) |
| email sink files right after registration | **0** |
| `Set-Cookie` on the register response | **none** |
| `POST /auth/login` (nothing was ever verified) | `200` |
| `GET /auth/me` | `200`, `status:"active"`, `emailVerifiedAt:null` |
| `POST /auth/password/reset` before any request | `400 AUTH_CHALLENGE_INVALID` |
| `POST /auth/password/reset-request` (known address) | `200 {"accepted":true}`; sink = 1 file; template `password_reset`; secret = 6 digits |
| `…/reset` with a 5-digit code | `400 REQUEST_VALIDATION_FAILED`, field `oneTimeCode` |
| `…/reset` with a wrong 6-digit code | `400 AUTH_CHALLENGE_INVALID`; `attempt_count` incremented to 1 |
| immediate second `reset-request` (cooldown) | `200`, **byte-identical** body, sink still 1 file (nothing re-sent) |
| `reset-request` for an unknown address | `200`, **byte-identical** to both cases above (`cmp` clean) |
| `…/reset` with the correct code | `200 {"userId":…,"sessionsRevoked":1}` |
| the pre-reset session cookie afterwards | `401` |
| replay of the consumed code | `400 AUTH_CHALLENGE_INVALID` |
| `POST /auth/verify-email`, `POST /auth/verification/resend` | **`404`**, both |
| login with the new password / with the old password | `200` / `401` |
| database afterwards | user `active` + `unverified` + `email_verified_at IS NULL`; single `password_reset` challenge `consumed`, `attempt_count=1`; sessions `2 total / 1 revoked` (the survivor being the post-reset login); events `registration_requested, login_succeeded, login_failed, password_reset_requested, password_reset_failed, password_reset_completed` — all pre-existing event types, so **no migration is needed and none was added** |

### 3.3 Findings from this section

**F-3 (MEDIUM, availability + record).** The cumulative budget is spent *before* the account lookup,
so it is also spent for addresses that have no account and for accounts with no active challenge.
Measured: for a brand-new address with no account, 11 verification attempts returned
`400 ×10` then **`429 AUTH_RATE_LIMITED`**, and the counters ended at `verification_target = 10`,
`reset_ip = 10`. Consequence: an unauthenticated attacker who knows a victim's address can, with ten
requests (≤ 10 per 15 minutes per IP), exhaust that address's hourly verification budget, so the
victim's own `POST /auth/password/reset` is refused with `429` for the remainder of the hour window —
while `reset-request` still mails them codes they cannot submit. Repeating at each hour boundary
sustains it indefinitely at ~10 requests/hour from one IP, or less with rotating IPs.

This is the *deliberate* trade-off of the approved anti-oracle design ("spend first, then look") and
is arguably inside D3's wording. It is reported because it is not written down anywhere as an
accepted risk, and because a reader of D3 ("ten failed verifications per account per hour") would not
predict that ten failures against an *unrelated, non-existent* address matter. Owner decision
required — either record it as an accepted residual risk, or change the spend point and accept the
enumeration side effect it was introduced to remove. **Not a code defect; the code matches its
documented intent.**

**F-8 (LOW, side channel, indicative only).** Response *bodies* are byte-identical, but latency is
not: the issuing path measured 11.8 ms against 5.0 ms (known address in cooldown) and 4.2 ms
(unknown address). The 11.8 ms sample was the first write request after boot, so part of it is almost
certainly warm-up; a clean measurement needs N ≥ 30 per case from an unthrottled source. If it holds,
a patient attacker with plenty of IPs could in principle separate "a mail was sent" from "nothing was
sent". The revision's own wording is "identical status, body shape, and **bounded** timing", so this
is inside the approved text — but it should be either quantified or explicitly accepted, not left
implied.

**F-10 (INFO).** `supersedeActiveChallenges` (`auth-repository.ts:1292`) still accepts a purpose union
that includes `'email_verification'`. Harmless: it can only *supersede*, never issue, and issuance is
blocked by the trigger.

**F-11 (INFO).** `access_denied_unverified` is now emitted for *any* non-active status
(`auth-repository.ts:538`) and is classified operator-only (`packages/domain/src/auth.ts:226`), so
users never see it and D4 holds. The event *name* is legacy; renaming needs a new event type and a
migration (the `0004` CHECK), so leaving it is the right call — worth one line in the record.

**F-12 (INFO).** The abuse windows are grid-aligned fixed windows (observed: 15-minute windows on the
`:00/:15/:30/:45` grid, the hourly budgets on the hour), so up to ~2× the nominal limit can pass
across a boundary. Pre-existing mechanism from Milestone 04, unchanged by this work.

**F-15 (INFO).** `/auth/me` exposes `emailVerifiedAt` but not `emailVerificationState`; clients infer
"unverified" from `null`. Sound because the database enforces the agreement (§2.2), but a future
client cannot be forced to render it honestly.

**F-13 (INFO).** The `security_notice` email template is declared (`apps/api/src/email-delivery.ts:23`)
and exercised only by tests; no production path sends it. It corresponds to the "approved security
messages" category in `ARCHITECTURE.md:50`, so it is a declared capability, not dead code.

## 4. Contract, API, OpenAPI, UI and built artifacts

| Surface | Verified how | Result |
|---|---|---|
| OpenAPI document | live `GET /openapi.json` from the running API | 33 paths; the auth surface is exactly the 11 routes listed in `ARCHITECTURE.md:181`; **no** `/auth/verify-email`, **no** `/auth/verification/resend` |
| Register response schema | live document | `accepted: true`, `additionalProperties: false`; `resendAvailableAt` absent from the whole document |
| Reset request/response schemas | live document | `{accepted:true}` both; no address/OTP/challenge-id echoed |
| Reset body | live document | `{email, oneTimeCode, newPassword}` with `oneTimeCode` pattern `^[0-9]{6}$` |
| Verification schemas | grep of the whole document | `email_verification` **appears nowhere** in the OpenAPI contract |
| Contract ↔ handler | route schemas are the same Zod objects the handlers validate with; `z.strictObject` throughout | consistent |
| Email templates | `email-delivery.ts:21-25` | only `password_reset` and `security_notice`; no verification template exists, so no path can mail a verification code |
| Registration sends nothing | register handler has no delivery call (`auth-routes.ts:269-293`); the only `deliver()` call site is the reset request (:428) | confirmed live (sink empty) |
| Web client | `apps/web/src/{api,views/auth,main}.ts` | no verification method or view; reset form has the six-digit field; session screen states the unverified truth verbatim; `onUseCode` fills `input[name="oneTimeCode"]` |
| Built artifact | `apps/web/dist` (the exact JavaScript the browser runs, per `tools/dev-server.mjs:19-20`) | contains the OTP field and "Not verified"; contains **no** `verify-email` / `verification/resend`; no source file is newer than its build output — the artifact is current |
| Migration checksum consistency | file hash vs test pin vs `kfin_migrations` | all three = `fc97f697…905cc4` |

**F-7 (LOW, stale developer text).** `apps/web/src/outbox.ts` still describes the old flow in comments
and UI copy — line 10-14 ("verification and recovery secrets", "Rather than fake a verified account in
the client"), line 21 ("Fills the six-digit verification field"), line 42 ("then register or request a
reset" — registration can no longer produce an email). Behaviour is correct; only the words are
stale. This is a local-development panel, not a shipped surface.

## 5. Plan for `docs/architecture/ARCHITECTURE.md` and `docs/ux/SCREEN-INVENTORY.md`

**The premise of this work item does not hold, and that is itself the finding.**

**F-2 (MEDIUM, record accuracy).** Both documents were **already synchronized** by the revision commit
`9456067` — they are listed among the documents changed in that commit, together with the
contradictions each rewrite resolved
(`docs/evidence/2026-10-12-AUTH-POLICY-SPECIFICATION-REVISION.md` §3 and §4). Evidence:

| Document | Already-updated content |
|---|---|
| `ARCHITECTURE.md` | §4 stack rows (`:49-50`), §8 module table (`:121`), §9 MVP auth surface + anti-oracle rule (`:181-182`), §11 atomic operations (`:269`, `:277`), §13 authentication architecture (`:318-321`, including "reset revokes all and issues none"), §18 failure behaviour (`:415`), §21 blocker rows (`:453-454`) |
| `SCREEN-INVENTORY.md` | §1 map no longer lists Verify email (`:11-15`), AUTH-03 marked retired (`:57`), AUTH-05 rewritten for the OTP (`:59`), SEC-01 must not imply a verified address (`:132`), blocker rows re-pointed (`:210-211`) |

`docs/implementation/MILESTONE-11-OTP-RESET-ONLY.md` §8 (`:144-160`) claims both documents "still describe the old
flow". **That claim is false** and must be corrected (see §7, F-2, and the fix list in §9).

**Residual work found, and the governed path for it**

Everything below is deliberately **not** applied in this task: this task is review and planning.

| # | Edit | Where | Why it is governed | Owner |
|---|---|---|---|---|
| P-1 | Delete the now-misleading sentence *"Deep links must remove reset secrets from URL/history as early as safely possible."* Replace with: *"No reset secret is ever carried in a URL: the OTP is typed into the form, so no link, referrer, redirect, or history entry can hold one."* | `docs/ux/SCREEN-INVENTORY.md:62` | It is the only remaining sentence that presupposes a URL-borne reset secret, which OQ-20 removed (`ADR-002`, SEC-AUTH-06). Meaning-preserving clarification of an already-accepted decision. | Product/UX, bundled with P-4 |
| P-2 | No change required | `docs/architecture/ARCHITECTURE.md` | A full scan found no stale statement. Its "Proposed design:" framing is correct: the authentication design is still unratified, so it must not be presented as accepted. | — |
| P-3 | Add a dated supersession note to `docs/evidence/2026-10-12-MILESTONE-10-VERIFICATION.md` (`:61`, `:94-95` still assert the two retired routes exist and answer `200`) | same file | The revision record deliberately preserves dated records as history; a note is the pattern already used for `LOCAL-APPLICATION-RUN` §2.1. Keeping history intact is required — do not rewrite the measured rows. | Author of that record |
| P-4 | Ratification change-set for `SPEC-AUTH-01` (and the value approval for `SPEC-AUTH-02`), which is what gives P-1 its authority | new `docs/evidence/2026-10-12-*.md` + register rows | `docs/product/DECISION-LOG.md` §8 change control: rationale + approver, affected requirement/flow/data/threat/test updates, migration/existing-user impact, and a new dated record rather than silent replacement | Product Owner (accountable) + Security Owner (approver) |

**Harness rules for any of this work — no exceptions:**

1. `ARCHITECTURE.md`, `SCREEN-INVENTORY.md`, `DECISION-LOG.md` and the milestone/verification records
   are **not** in the SPEC-FIN-02 `AUTHORITATIVE_DOCS` list, so editing them **cannot** and **must
   not** involve any pin change.
2. `DATABASE.md`, `TEST-STRATEGY.md` and `APPROVAL-AND-EVIDENCE-REGISTER.md` **are** hash-pinned in
   `evidence/spec-fin-02/src/constants.mjs` (`AMENDED_AUTHORITATIVE_DOCS.sha256`). If P-4 requires
   editing the register (rows 68/69/109), the pin **must** be updated in the same commit with the
   amendment recorded — the pattern already used for OQ-20 in `9456067` and documented in the
   revision record §5.1. Until then `evidence:test` fails, which is the control working.
3. Never edit `FROZEN_SOURCE_COMMIT` (`a48d2c5…`), and never weaken or bypass
   `verifyFrozenAuthoritativeDocs` to make a failure disappear. The byte-comparison for the two
   candidate documents (SPEC-FIN-02 candidate, ADR-009) must stay byte-exact.
4. No production database is touched by any of this; `0007` remains applied only to the disposable
   local cluster.

## 6. Approvals: `SPEC-AUTH-01`, `SPEC-AUTH-02`, and the D5 risk acceptance

| Item | Register row | State | What is actually missing |
|---|---|---|---|
| `SPEC-AUTH-01` | `APPROVAL-AND-EVIDENCE-REGISTER.md:68` — accountable **Product Owner**, approver **Security Owner** | SUPERSEDED — **awaiting ratification** | A signed statement that the post-verification branch is retired, plus register→sign-in and reset→sign-in threat/flow/session-fixation evidence (`AUTH-REG-01…06`, `AUTH-RST-01…12`). The evidence exists in the test suites; the *signature* does not. |
| `SPEC-AUTH-02` | register `:69` — **Security Owner** with **Product Owner** co-approval | **OPEN — decision ready** | Approval of the exact values now hard-coded in `packages/config/src/index.ts` (6-digit, 10 min, 5 attempts, 60 s cooldown, 10/hour cumulative, 3/h and 6/24 h caps, reset revokes all sessions) together with threat, benchmark, usability and provider evidence. Note the register still calls the eight-digit alternative open. |
| D5 — accept the unverified-email beta risks, operator process, no code | **no row exists** | **unrecorded** | See F-1. |

**F-1 (HIGH, governance only).** The D5 acceptance exists in the task record and is mentioned twice
in `MILESTONE-11` (`:151` and `:167`), but **nowhere in the repository's governance artifacts**: no
`DECISION-LOG` entry, no `APPROVAL-AND-EVIDENCE-REGISTER` row, no `THREAT-MODEL` update, and
`EVID-AUTH-POLICY` is still "Missing / Not evaluated" (register `:109`). In a repository whose whole
control model is "decisions live in dated records", a risk that lives only in a chat instruction is
not accepted. Recording it needs a dated evidence record and, if the register changes, the same
same-commit re-pin described in §5.

### 6.1 Technical blockers vs governance blockers

| | Technical | Governance |
|---|---|---|
| Blocking merge today | **none** | F-1 (D5 unrecorded), F-4 (PR description), F-2/F-5/F-6 (false statements in a committed record) |
| Not blocking, but must be tracked | F-3 (needs an owner decision: accept and record, or redesign), F-8 | `SPEC-AUTH-01` and `SPEC-AUTH-02` signatures — owner-declared non-blocking for this implementation task, and nothing in this branch claims to close them |
| Explicitly out of scope | no new features, no merge, no deployment, no production/Supabase access | no silent spec edits, no harness re-pinning to hide a failure, no self-approval |

## 7. Findings register

| ID | Severity | Finding | Evidence | Disposition |
|---|---|---|---|---|
| F-1 | **HIGH** (governance) | D5 beta risk acceptance has no repository record | `grep` over `docs/`; register `:109` | record before merge |
| F-2 | **MEDIUM** (accuracy) | `MILESTONE-11` §8 falsely says `ARCHITECTURE.md` and `SCREEN-INVENTORY.md` still describe the old flow | `git diff 28ee85f..9456067` on both files; §5 above | fix wording |
| F-3 | **MEDIUM** (availability) | cumulative budget spent pre-lookup → 10 unauthenticated requests deny a victim's reset completion for the hour window | live: `400 ×10` then `429`, counters at 10/10 for a non-existent address | owner decision + record |
| F-4 | **MEDIUM** (governance) | PR #10 title/body describe only Milestone 10 (5 files) vs 87 files actually merged | `gh pr view 10` | rewrite before merge |
| F-5 | LOW | `MILESTONE-11` §9 lists D5 among "decisions implemented", contradicting its own §8 | file, `:151` vs `:167` | fix wording |
| F-6 | LOW | revision record: §5.2 was inserted **before** §5.1 | `docs/evidence/2026-10-12-AUTH-POLICY-SPECIFICATION-REVISION.md` — §5.2 at `:109`, §5.1 at `:131` | reorder |
| F-7 | LOW | `apps/web/src/outbox.ts` comments/copy still describe a verification flow (`:10-14`, `:21`, `:42`) | grep | fix wording |
| F-8 | LOW | reset-request latency differs between issuing and non-issuing paths (11.8 ms vs 4.2–5.0 ms, warm-up-confounded) | live timing | quantify or accept |
| F-9 | LOW | `MILESTONE-10-VERIFICATION.md` still asserts the retired routes exist, with no supersession note | `:61`, `:94-95` | add dated note (P-3) |
| F-10 | INFO | `supersedeActiveChallenges` purpose union still includes `email_verification` | `auth-repository.ts:1292` | none |
| F-11 | INFO | `access_denied_unverified` now fires for any non-active status; legacy name, correct operator-only classification | `auth-repository.ts:538`, `domain/src/auth.ts:226` | note in record |
| F-12 | INFO | grid-aligned fixed windows permit ~2× the nominal limit across a boundary | counter rows: 15-min grid, hourly 07:00 window | none (pre-existing) |
| F-13 | INFO | `security_notice` template declared but unused outside tests | `email-delivery.ts:23` | none |
| F-14 | INFO | new column is `NOT NULL` with no default → pre-`0007` code fails fast (`23502`); a future migration dropping `NOT NULL` would silently weaken the agreement CHECK | rehearsal | hardening note |
| F-15 | INFO | `/auth/me` omits `emailVerificationState`; clients infer from `emailVerifiedAt` | `contracts/src/auth.ts:192` | none |

**Verified and found correct** (no findings): migration safety and upgrade path; email-state integrity;
OTP shape, lifetime, attempts, cooldown and caps; single-use and replay; digest-only storage;
generic register/reset-request/reset error bodies; session revocation and cookie clearing; login and
session gating on account status only; password policy preserved and evaluated before consumption;
OpenAPI/UI/artifact consistency; no registration path sends an OTP; no new security-event type needed;
no authoritative document was modified by the implementation, so **no SPEC-FIN-02 digest moved**.

## 8. Gates re-run in this review

Environment: local disposable PostgreSQL 17.6 (`LD_LIBRARY_PATH` set); integration run with
`KFIN_INTEGRATION_TARGET=non-production`. No production or Supabase endpoint was contacted; only the
disposable cluster was migrated, plus three scratch databases created for this review.

| Gate | Command | Result |
|---|---|---|
| Evidence harness integrity | `pnpm run evidence:check` | PASS — 25 JavaScript modules / 29 harness files |
| Evidence harness tests | `pnpm run evidence:test` | **17/17 PASS** |
| Typecheck | `pnpm run typecheck` | exit 0, no diagnostics |
| Unit + API | `pnpm run test` (inside `check`) | **681 passed / 69 skipped** across 30 files |
| Integration (real PostgreSQL) | `pnpm run test:integration` | **69/69 PASS** across 7 files |
| Aggregate | `pnpm run check` | **exit 0** |
| CI | `gh api …/commits/4866d13/check-runs` | `verify` → **success** |
| Live wire verification | API on a scratch database | §3.2, all rows as specified |
| Migration upgrade rehearsal | real runner, scratch databases | §2.2, all rows as expected |
| Rollback rehearsal | forward DDL in a scratch database | §2.3, 4 ms |

## 9. Conditions to change the verdict to READY FOR MERGE

Nothing here is a redesign; the code and the migration are, as far as this review can establish,
ready. The list is short and precise.

**Required before merge**

1. **F-2, F-5, F-6 — correct the record** (one small commit): fix `MILESTONE-11` §8 (both documents
   were already synchronized by `9456067`, so say that and drop the false claim), fix §9 (D5 is not
   implemented; it is an unrecorded acceptance), and move §5.2 after §5.1 in the revision record.
2. **F-1 — record D5**, in a dated evidence record with a named owner, plus the register row if the
   owner wants one (with the same-commit re-pin described in §5).
3. **F-3 — choose an option and ship it.** *(Revised 2026-10-12 after the owner's directive: a risk
   note alone does not close this one.)* The pre-lookup budget spend is a real, externally reachable
   availability weakness; the owner must select from the costed options in
   [`docs/evidence/2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md`](../evidence/2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md)
   §2.3 and have it implemented and tested before merge. The recommended minimum is detection plus an
   interim operator unlock path, with per-network keying as the durable fix. See §11.1.
4. **F-4 — rewrite the PR title and body** so they describe the 87-file, four-milestone change
   actually being merged (or split the PR). Owner action.
5. **F-7, F-9 — optional but cheap**: fix the four stale lines in `outbox.ts` and add the dated
   supersession note to `MILESTONE-10-VERIFICATION.md` (P-3).

**Required before the merge is *meaningful*** (owner-declared non-blocking, still outstanding)

6. `SPEC-AUTH-01` ratification (Product Owner + Security Owner) and `SPEC-AUTH-02` value approval
   (Security Owner + Product Owner), per §6. The product currently satisfies a specification whose
   authentication branch is unratified.
7. `P-1` (`SCREEN-INVENTORY.md:62`) bundled with the ratification change-set.

**Explicitly not conditions**: no harness re-pin (none is needed — no pinned document was edited), no
migration change, no new migration, no code change, no additional specification round.

## 10. Note on this file

This review document was committed together with the corrections it asked for, in the follow-up
changeset that also carries §11. Findings closed by that changeset, and findings still requiring an
owner decision, are listed in §11 — read it before treating §9 as the current to-do list.

## 11. Closure after the follow-up changeset (2026-10-12)

The finding register in §7 is left exactly as it was written. This section records what the follow-up
changeset did about each item; nothing above is rewritten, so the original review stays auditable.

| Finding | State after the follow-up changeset | Evidence of the change |
|---|---|---|
| F-1 (D5 unrecorded) | **Prepared, still open — owner signature required** | [`docs/evidence/2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md`](../evidence/2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md) §1.1 and the empty approval block D-1; no name, date or signature entered |
| F-2 (false claim about the two documents) | **Closed** | `MILESTONE-11` §8 now states that `ARCHITECTURE.md` and `SCREEN-INVENTORY.md` were already synchronized by `9456067`, and records that the earlier claim was wrong |
| F-3 (reset availability) | **Open and blocking — no longer an unquantified worry** | Analysis and costed options R1–R5 in the request record §2; measured again as `400 ×10` then `429`, with the counter reaching 10 for an address that has no account. **No rate-limit value, key, window or spend point was changed**: that is a policy decision this changeset may not take, and a risk note does not close the finding |
| F-4 (PR description) | **Addressed outside the repository** | PR #10 title and body rewritten to describe the actual 87-file scope; see the PR for the text |
| F-5 (§9 listed D5 as implemented) | **Closed** | `MILESTONE-11` §9 now lists D2/D3/D4/D7/D8 as implemented in code and D5 as a *request*, with no signature |
| F-6 (§5.2 before §5.1) | **Closed** | Reordered in the revision record, with an editorial note recording the move and its reason |
| F-7 (stale text in `outbox.ts`) | **Closed** | Panel comment, `onUseCode` docstring and the empty-state copy now describe the reset-only flow |
| F-8 (timing) | **Open, low — measurement first** | Options M1–M4 in the request record §3; the single-sample numbers are labelled as unquantified |
| F-9 (MILESTONE-10 record asserts retired routes) | **Closed** | Dated supersession note appended to `2026-10-12-MILESTONE-10-VERIFICATION.md`; the measured rows are untouched |
| F-10 … F-15 (INFO) | Unchanged, as intended | Informational; no action proposed |

**Subject-item plan P-1 … P-4 (§5):** P-1 applied (`SCREEN-INVENTORY.md` no longer presupposes a
URL-borne reset secret); P-2 confirmed as no-change; P-3 applied (the supersession note above); P-4 is
the D-2/D-3 request, still awaiting owner signature.

**Harness:** `evidence/spec-fin-02/src/runner.mjs` and `constants.mjs` were **not** modified. No
hash-pinned document was edited in this changeset, so no pin moved; `evidence:test` passing here is a
statement about unedited pins, not about a re-pinned control.

### 11.1 Verdict after this changeset

**Still NOT READY FOR MERGE.** Four of the review's record-type findings are closed (F-2, F-5, F-6,
F-7, F-9), and F-1/F-3/F-8 now have a single, signed-ready request artifact instead of an open
question — but the conditions that remain are decisions, not edits:

1. **F-3 must be fixed, not noted.** The owner must choose an option from §2.3; the recommended
   minimum (R1 detection + R5 interim unlock runbook, with R2 as the durable fix) still has to be
   implemented and tested before a merge ships an externally reachable availability weakness.
2. **D5, `SPEC-AUTH-01` and `SPEC-AUTH-02` still need signatures.** The product is shipping a
   specification whose authentication branch is unratified and whose values are candidate values.
3. **Nothing here merges or deploys anything**, and no approval was written on the owners' behalf.

