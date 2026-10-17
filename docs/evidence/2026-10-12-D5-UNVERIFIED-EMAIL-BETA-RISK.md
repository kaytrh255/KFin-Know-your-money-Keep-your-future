# D5 — unverified-email beta risk: record and acceptance request

> ## Status: RECORDED — ACCEPTANCE NOT SIGNED
>
> This record exists so the D5 risk is not carried only in a conversation. It states the exposure, the
> compensating controls that are actually implemented, the residual risks, and who is accountable.
> **It does not accept the risk.** The acceptance block at the end is empty: no approver name, no date,
> no signature. Nothing in this repository may be read as an accepted D5 risk until an owner fills that
> block in their own commit.

**Date:** 2026-10-12
**Prepared by:** implementation review session (Arena agent), acting for — not as — the owners
**Related:** [`docs/evidence/2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md`](2026-10-12-AUTH-POLICY-RATIFICATION-REQUEST.md) (decisions D-1 … D-5),
[`docs/evidence/2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md`](2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md) (findings F-3, F-8),
[`docs/reviews/2026-10-12-PRE-MERGE-REVIEW-PR-10.md`](../reviews/2026-10-12-PRE-MERGE-REVIEW-PR-10.md) (findings F-1, F-3, F-8)
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2` (untouched)
**Implementation under review:** branch `arena/bfaf5019-kfin-know-your-money-keep-your` (PR #10, unmerged)

## 1. The decision this record is about (D5)

The OQ-20 revision ([`2026-10-12-AUTH-POLICY-SPECIFICATION-REVISION.md`](2026-10-12-AUTH-POLICY-SPECIFICATION-REVISION.md) §2,
`docs/architecture/DATABASE.md` §4.1 — *"email verification gates nothing"*) means:

- an MVP account is created `active` with `email_verification_state = 'unverified'`;
- **no flow in the product ever verifies an email address**: not registration, not sign-in, not reset,
  not password change, not operator support — no writer sets `email_verified_at`;
- therefore **every** beta account is unverified, permanently, by design.

D5 asks the owners to accept that posture and the risks that follow from it, with the operator process —
not code — carrying the consequences. The decision is not implemented in code, because there is nothing
to implement: it is a statement about what is acceptable.

## 2. What the risk actually is

Framing matters, because D5 is easy to misread as "accounts are unproven". They are not:

| Question | Answer in this design |
|---|---|
| Does anything authorize on email possession? | **No.** Access is `status = 'active'` plus a valid session; financial writes require an active account and a valid session. Mailbox possession is never an authorization factor. |
| Was mailbox possession demonstrated at admission? | **Implicitly, by operator process.** Registration requires a single-use invitation code that is bound to an invited address (`beta_invitations.invited_email_normalized`); the code reaches the holder through the reviewed operator channel, and a code used with a different address is refused exactly as an expired or consumed one. |
| Is mailbox possession proven at recovery? | **Yes, at that instant.** Completing a password reset requires an OTP that was mailed to the address, so a successful reset demonstrates mailbox access at that moment. |

The residual exposure is therefore not "anyone can take over an account". It is:

1. **Onboarding correctness.** An invitation addressed to a mistyped or unusable address creates an
   account whose owner cannot read the recovery channel. There is no self-service email change in MVP.
2. **Recovery depends on the address staying readable.** A user who loses control of their mailbox
   cannot recover the account by self-service, and the product cannot tell the difference between them
   and an attacker — nothing about the account records that the address was ever proven.
3. **Safety email is best-effort.** Password-reset codes and any approved security notice go to an
   address the system has never confirmed, so delivery failure is silent to the account.
4. **Operator load and social engineering.** Locked or unreachable accounts become an operator
   conversation. `locked`, `disabled` and `deletion_pending` accounts are deliberately
   **not self-recoverable** (decision D-4), and the operator-only event `access_denied_unverified`
   records the refusal, so the operator path must resist "please unlock my account" requests.
5. **Enumeration and availability on the reset surface** — carried separately and **not** accepted
   here: F-3 (measured availability weakness) and F-8 (measured, confirmed timing difference), both in
   [`2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md`](2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md).

## 3. Compensating controls that are implemented

Each of these is verifiable in the tree today; none of them depends on this record being signed.

| Control | Where |
|---|---|
| Invitation-admitted registration, single-use, expiring, bound to an invited address; a valid code used with a different address answers exactly like an expired or unknown one | `packages/database/src/auth-repository.ts` `register`; `auth-access.integration.test.ts` — "binds an invitation to its invited email and never admits by email alone", "consumes one invitation exactly once, including under parallel registration" |
| No authorization path gates on `email_verified_at` — it is read only to populate the profile; the gate is `users.status = 'active'` | `identity.ts` (writes the state, never reads it as a gate), `auth-repository.ts` `login`/`authenticate` (explicit OQ-20 comment: "verification state is not a session gate"), `savings-repository.ts` (no reference at all) |
| A never-verified address can never be presented as verified | migration `0007` agreement constraint `(state = 'verified') = (email_verified_at IS NOT NULL)`; negative controls asserted in `migration-contract.test.ts` |
| No flow can issue a verification challenge at all | `0007` issuance guard trigger (`23514`) |
| Reset proves mailbox possession, is single-use, attempt-limited, and revokes every session | `packages/database/test/auth-access.integration.test.ts` — "issues a six-digit, single-use reset OTP and refuses every later use of it", "ends a reset OTP after five wrong attempts", "revokes every session on password reset and requires a fresh sign-in", "answers every reset request identically" |
| Account status is a hard gate and is never self-recoverable | `login` (`status !== 'active'`), `authenticate` (`user_status !== 'active'`), operator-only `access_denied_unverified` |
| Password, session, CSRF, and abuse protections unchanged by OQ-20 | full gate set on the head commit |
| Security history is append-only and operator-visible events never reach users | `security_events` immutability trigger; `eventVisibility()` |

## 4. Owner actions that this record asks for

1. **Confirm the accountable risk owner and the approver.** No register row exists for D5, so this
   record proposes the mapping below and marks it as unconfirmed. Naming a role here is not a signature.
2. **Decide where the acceptance lives** — a dated `docs/product/DECISION-LOG.md` entry under its §8
   change control, an `APPROVAL-AND-EVIDENCE-REGISTER.md` row, or both. If the register is edited, its
   SHA-256 pin in `evidence/spec-fin-02/src/constants.mjs` must be updated **in the same commit**, with
   the amendment recorded (the pattern used for OQ-20 in `9456067`); the harness must never be edited
   to make the check pass.
3. **State the review cadence.** A beta-stage acceptance should be revisited before any wider release:
   the natural gate is the Release Candidate, when `OQ-17` (provider selection) is also due.
4. **Link the outcome of F-3 and F-8 to this acceptance or to `SPEC-AUTH-02`** — an accepted risk and a
   fixed risk cannot live in separate places.

## 5. Accountable risk owner and acceptance block — NOT FILLED

**Proposed role mapping (requires owner confirmation, not a signature):**

| Field | Value |
|---|---|
| Risk | Unverified email addresses for the entire beta, with recovery and safety mail depending on addresses the system never confirmed |
| Accountable risk owner | **Product Owner** — *proposed by this record; to be confirmed by the owner, not assumed* |
| Co-approver | **Security Owner** — *proposed; security owns the threat-model row `SPEC-AUTH-01` and the residual-risk re-evaluation* |
| Operational owner of the consequences | **Operator process** (beta invitation delivery, recovery conversations, account-status decisions) |
| Acceptance condition | F-3 must be resolved or explicitly accepted *before or with* this acceptance; F-8 must be measured (it now is) and either mitigated or accepted with the measured numbers attached |

**Acceptance (to be completed only by the named owner, in their own commit):**

| Field | Value |
|---|---|
| Decision statement, in the owner's own words | _(not filled)_ |
| Accountable risk owner — name and role | _(not filled)_ |
| Co-approver — name and role | _(not filled)_ |
| Date | _(not filled)_ |
| Where this acceptance is recorded (decision log / register / both) | _(not filled)_ |
| Review cadence or expiry | _(not filled)_ |
| Signature / evidence reference | _(not filled)_ |
| Outcome | ☐ accept ☐ accept with conditions ☐ reject |

> **Consistency note (2026-10-13).** F-3 has since been mitigated in code for the remote vector (PR #10
> branch, commits `afc5201`/`987b28e`) but remains **OPEN**: the `SPEC-AUTH-02` amendment A-1 is requested and
> unsigned, and the shared-network residual is unaccepted. The acceptance condition in §5 is therefore *partly*
> satisfiable — the remote denial of password recovery is gone — and accepting D5 today would still mean
> accepting an open F-3. Nothing here is an acceptance; the current F-3 status is in
> [`2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md`](2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md) §A.7
> and [`2026-10-13-A1-DECISION-PACKET.md`](2026-10-13-A1-DECISION-PACKET.md).

## 6. Explicit non-claims

- D5 is **not accepted** by this record. It is recorded, with an owner proposed and a signature block
  left empty on purpose.
- No approver identity was invented, no signature was simulated, and no status field elsewhere in the
  repository was changed to "approved".
- This record does not close F-1; it changes F-1 from "unrecorded" to "recorded and awaiting signature".
- It does not weaken any control, does not touch a rate limit, does not edit a hash-pinned document, and
  does not authorize a merge.
