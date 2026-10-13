# KFin requirements traceability matrix

**Date:** 2026-10-12 · **Revision under trace:** `822736e` (branch
`arena/bfaf5019-kfin-know-your-money-keep-your`, PR #10, unmerged) plus the journey trace added in this
changeset.
**Specification source of truth:** [`docs/README.md`](../README.md) and the documents it indexes; scope
from [`docs/product/MVP-SCOPE.md`](../product/MVP-SCOPE.md); values from
[`docs/testing/TEST-STRATEGY.md`](../testing/TEST-STRATEGY.md) and
[`docs/security/SECURITY-REQUIREMENTS.md`](../security/SECURITY-REQUIREMENTS.md).

## How to read this matrix

Every row maps an in-scope capability to **what exists in the tree**, **what actually verifies it**, and
**what is still missing**. The status vocabulary is deliberately narrow:

| Status | Meaning |
|---|---|
| **VERIFIED** | Implemented, and an automated test that exercises the real PostgreSQL database proves it at the boundary the requirement names. |
| **PARTIAL** | Implemented for part of what the requirement names; the missing part is stated in the row. |
| **IMPLEMENTED / UNDER-VERIFIED** | Implemented, but the only evidence is weaker than the requirement (mocked test, harness-only, or manual). |
| **NOT IMPLEMENTED** | No implementation exists in the tree. |
| **BLOCKED** | Cannot be completed without an owner decision, approval, or infrastructure this session may not supply. |

`SPEC-*`, `DCT-*`, `RCT-*`, `STS-*`, `DEL-LIFE-*`, `REM-INV-*` and similar identifiers are the SDD's own
requirement IDs; they are used here so a reader can join this matrix to the specification directly. A
row marked **VERIFIED** is a statement about the checks listed in that row, not about the identifier's
entire family.

## 1. Account and security (MVP-SCOPE §2.1)

| Requirement | Status | Implementation | Verification |
|---|---|---|---|
| Registration admitted by a single-use, expiring, address-bound invitation; address presence never grants admission | **VERIFIED** | `packages/database/src/auth-repository.ts` `register`; `apps/api/tools/provision-invitation.ts` (operator channel) | `journey.integration.test.ts` 1; `auth-access.integration.test.ts` "consumes one invitation exactly once", "binds an invitation to its invited email" |
| Registration creates a usable account with **no** OTP, **no** email, **no** session | **VERIFIED** | `4866d13` (OQ-20) | `journey.integration.test.ts` 1 asserts zero sessions, zero challenges, zero messages; `MILESTONE-11` §7 |
| Email OTP exists for password reset only; requests do not reveal whether an address exists | **VERIFIED (with the F-3 caveat)** | `auth-repository.ts` `requestPasswordReset`/`resetPassword` | `journey.integration.test.ts` 12; `auth-access.integration.test.ts` "answers every reset request identically: unknown, non-active, cooled down, capped". **F-3**: 10 anonymous requests could exhaust an address's hourly budget (availability, not disclosure) — **mitigated for the remote vector in `afc5201`** (counters now scoped per caller network; **eight** `F-3` cases in `auth-access.integration.test.ts`, `987b28e`), **still OPEN** pending the `SPEC-AUTH-02` amendment A-1 and the shared-network residual — see `docs/evidence/2026-10-12-RESET-AVAILABILITY-AND-TIMING-RISKS.md` §A.7 and `docs/evidence/2026-10-13-A1-DECISION-PACKET.md` |
| Email/password sign-in; session resolvable only from the opaque cookie | **VERIFIED** | `login`, `authenticate` | `journey.integration.test.ts` 2 (401 without a cookie) |
| Revocable session; idle and absolute expiry; replay containment | **VERIFIED** | sessions/tokens schema + `authenticate` | `auth-access.integration.test.ts` "enforces idle expiry, rotation grace, replay containment, and logout" |
| Current-session logout and all-session logout | **VERIFIED** | `logout`, `logoutAll` | `auth-access.integration.test.ts` "revokes the requesting session on logout-all so its token cannot be replayed" |
| Password change revokes other sessions; old password stops working | **VERIFIED** | `changePassword` | `journey.integration.test.ts` 11 |
| Password reset via mailed OTP: single-use, attempt-limited, revokes **every** session | **VERIFIED** | `resetPassword` | `journey.integration.test.ts` 12; `auth-access.integration.test.ts` (five-attempt, single-use, revocation cases) |
| Profile: display name, locale, timezone, base currency | **VERIFIED** | `registerBodySchema`, `GET /auth/me` | `journey.integration.test.ts` 2 |
| Active-session list and individual revocation | **IMPLEMENTED / UNDER-VERIFIED** | `GET /auth/sessions`, `DELETE /auth/sessions/{id}` | covered only by mocked `apps/api/test/auth-routes.test.ts`; no real-PostgreSQL case in `journey.integration.test.ts` yet |
| Concise security history; operator-only events never reach the user | **VERIFIED** | `security_events` + `EVENT_VISIBILITY` | `journey.integration.test.ts` 13 |
| Abuse controls (login/reset/registration windows) | **VERIFIED** | `registerAbuseAttempt`, `auth_attempt_counters` | `auth-access.integration.test.ts` ("answers unknown and known login failures identically and limits abuse"), `auth-abuse-counters.test.ts` |
| Identity-verified deletion request, 7-day grace, approved purge map (`SPEC-DEL-01`, `DEL-LIFE-01`–`10`) | **NOT IMPLEMENTED** | only the `users.deletion_requested_at` column exists (migration `0001`), and no reader or writer | — the channel itself is **BLOCKED** on legal/privacy approval (MVP-SCOPE §2.1) |
| User-data isolation across every object API | **VERIFIED** | ownership predicates in every repository | `journey.integration.test.ts` 10 (cross-owner read of transaction, goal, account; empty foreign list) |

## 2. Manual money position (MVP-SCOPE §2.2)

| Requirement | Status | Implementation | Verification |
|---|---|---|---|
| One aggregate liquid-money account per owner, no account picker | **VERIFIED** | `financial_accounts` uniqueness + bootstrap service | `journey.integration.test.ts` 3 (one account after an idempotent replay) |
| One base currency per user, VND default | **VERIFIED** | `registerBodySchema` + account currency | `journey.integration.test.ts` 2 |
| Authoritative balance snapshots with visible as-of time | **VERIFIED** | `balance_snapshots`, `createSnapshot` | `journey.integration.test.ts` 3 (snapshot row equals the reported balance) |
| Current balance = latest snapshot + current-impact posted transactions in that segment | **VERIFIED** | `AccountFinancialSerializer`, `currentBalance` | `journey.integration.test.ts` 3, 4, 6, 7, 8 (every money move re-checked against the reported balance and the rows) |
| Historical backfill stays visible in reports but never moves current balance | **VERIFIED** | `alreadyIncludedInSnapshot`, `balanceEffect` | `financial-foundation.integration.test.ts`, `MILESTONE-01` trace |
| Deliberate manual snapshot update with old/new anchor disclosure | **VERIFIED** | `POST /financial-account/snapshots` | `financial-foundation.integration.test.ts`; mocked contract coverage in `apps/api/test/financial-snapshots.test.ts` |
| Integer minor units; no floating-point money | **VERIFIED** | `*_minor BIGINT` columns; `signedMinorSchema` | `migration-contract.test.ts`; every journey assertion compares minor-unit strings |

## 3. Income and expenses (MVP-SCOPE §2.3, §2.4)

| Requirement | Status | Implementation | Verification |
|---|---|---|---|
| One-time/flexible income and expense entry | **VERIFIED** | `POST /transactions` | `journey.integration.test.ts` 4; `financial-accounts.integration.test.ts` |
| Amount-first Global Add form available from primary navigation | **IMPLEMENTED / UNDER-VERIFIED** | `apps/web/src/views/money.ts` | `apps/web/test/*` are DOM-less unit tests; a browser-level check is **NOT RUN** (no browser runtime in this environment) |
| Fixed essential / variable essential / daily classes plus the orthogonal unexpected flag | **VERIFIED** | `expense_class`, `is_unexpected` | `journey.integration.test.ts` 4, 5 |
| Default categories only (no customization) | **VERIFIED** | `categories` seed in migration `0001` | `journey.integration.test.ts` 4 uses seeded codes only |
| Recurring fixed **expense** schedules | **PARTIAL → see §5** | `scheduled_items`/`scheduled_occurrences` support one-off patterns | recurring patterns (every-N-week/month/year) are **NOT IMPLEMENTED** |
| Create, inspect, correct, void own records with recalculation | **VERIFIED** | `transactions`, `transaction-corrections.ts` | `journey.integration.test.ts` 4, 5, 6 (including the append-only pair) |

## 4. Corrections, voiding, and concurrency (MVP-SCOPE §3, SPEC-FIN-01/02)

| Requirement | Status | Implementation | Verification |
|---|---|---|---|
| Correction preserves append-only source/replacement evidence | **VERIFIED** | source row is voided (never rewritten); replacement names it via `supersedes_transaction_id` | `journey.integration.test.ts` 5 asserts the original amount survives, the source is voided with a reason, and the replacement is the only posted row |
| Correction preview → commit with a reviewed context; a stale context is refused | **VERIFIED** | `correction-preview`, `corrections` | `journey.integration.test.ts` 5; `journey.integration.test.ts` 4 asserts the stale-version refusal (`409`) |
| Void semantics remove the effect from the authoritative balance | **VERIFIED** | `void` | `journey.integration.test.ts` 6 |
| Frozen-correction / void history readable to the owner | **VERIFIED** | `correction-history` | `journey.integration.test.ts` 5 |
| Account-scoped serialization, stale loser, bounded retry, uncertain-commit recovery (`FIN-RACE-*`) | **VERIFIED (harness)** | `AccountFinancialSerializer` + `docs/architecture/SPEC-FIN-02-SNAPSHOT-CONCURRENCY.md` | `evidence/spec-fin-02` harness (17/17) and `financial-*-integration` race cases. **Caveat carried from the review**: a passing harness is not proof that every race passed in production-like concurrency; the harness is the strongest evidence available and is labelled as such |
| Idempotent write replay (same key + payload = same result, one row) | **VERIFIED** | idempotency store + `idempotency-key` header | `journey.integration.test.ts` 3 (account), 4 (transaction) |

## 5. Schedule, occurrences, and reminders (MVP-SCOPE §2.3, §2.8)

| Requirement | Status | Implementation | Verification |
|---|---|---|---|
| One-off expected inflow/outflow with a due date | **VERIFIED** | `POST /schedule/one-off` | `journey.integration.test.ts` 7 |
| Occurrences stay projected until explicitly confirmed | **VERIFIED** | `scheduled_occurrences.state` | `journey.integration.test.ts` 7 (balance and version unchanged while `scheduled`) |
| Confirmation posts exactly one transaction and moves the balance once | **VERIFIED** | `confirm` | `journey.integration.test.ts` 7 (row state, confirmed transaction id, balance delta) |
| Storage accepts only `scheduled`, `confirmed`, `skipped`, `cancelled`; Paid/Received are presentation labels | **VERIFIED** | CHECK constraint + `presentation` derivation | `migration-contract.test.ts`; `schedule-occurrences.integration.test.ts` |
| Due/overdue derive from date passage without mutation | **VERIFIED** | `presentation` computation | `schedule-occurrences.integration.test.ts` |
| Skip and cancel lifecycle | **IMPLEMENTED / UNDER-VERIFIED** | `skip`, `cancel` routes | mocked API tests only; no journey case yet |
| Recurring patterns (every-N-week / every-N-month / every-N-year, missing dates use month-end) | **NOT IMPLEMENTED** | — | only one-off items exist (`0002` migration scope; MILESTONE-03) |
| In-app notification center and 7/3/due-today/first-overdue stages at 09:00 user-local (`RCT-01`–`10`, `SPEC-REM-01`) | **NOT IMPLEMENTED** and **BLOCKED** | — | the exact stage policy is still an open decision (`SPEC-REM-01`); no notification table, worker, or UI exists |

## 6. Savings and debt (MVP-SCOPE §2.5, §2.6, §2.7)

| Requirement | Status | Implementation | Verification |
|---|---|---|---|
| Multiple goals with target, manual current amount + as-of, planned contribution, target date, progress | **VERIFIED** | `0005`/`0006` migrations, `savings-repository.ts` | `journey.integration.test.ts` 8; `savings-goals.integration.test.ts` |
| Absolute "update current amount" with old/new audit metadata; no contribution ledger | **VERIFIED** | `current-amount` route + amount-change rows | `journey.integration.test.ts` 8 (≥2 history rows) |
| Goal amounts never change aggregate cash or monthly income/outflow | **VERIFIED** | separation asserted in the repository | `journey.integration.test.ts` 8 (balance and financial state version unchanged); `savings-goals.integration.test.ts` "never changes the account balance, financial state version, transactions, or monthly actuals" |
| Versioning, archive, immutability of history | **VERIFIED** | `0006` chain + archive route | `savings-goals.integration.test.ts` ("archives without changing the value…", "replaces the current amount absolutely…") |
| Debt profile, payment confirmation, outstanding history (`SPEC-DEBT-01`, `DCT-01`–`09`) | **NOT IMPLEMENTED** and **BLOCKED** | — | the policy identifier is still an unapproved decision; no schema, route, or UI exists |
| Planned purchases with goal-linked atomic deduction (`PRD-DEBT-05`) | **NOT IMPLEMENTED** | only a `planned_purchase_use` savings-source enum value exists | — |

## 7. Dashboard, reporting, and estimates (MVP-SCOPE §2.8, §3)

| Requirement | Status | Implementation | Verification |
|---|---|---|---|
| Current balance on the dashboard | **VERIFIED** | `GET /financial-account` + `apps/web/src/views/money.ts` | `journey.integration.test.ts` 3 |
| Selected-month confirmed income and grouped outflow | **VERIFIED** | `GET /reports/monthly-actuals` | `journey.integration.test.ts` 9 (totals equal the posted terminal rows; group sum equals the total) |
| Confirmed vs projected totals shown separately | **PARTIAL** | confirmed totals exist; "projected" totals are not returned by any route | — |
| Safe-to-spend (`STS-01`–`15`: balance − unpaid outgoings through month-end − active goals, income excluded, negatives visible) | **NOT IMPLEMENTED** | — | no route, domain function, or test |
| Urgent upcoming obligations surfaced | **PARTIAL** | occurrence list with derived due/overdue presentation | no ranked "urgent" view; no test |
| Savings-goal progress from manual amounts | **VERIFIED** | `GET /savings-goals` | `journey.integration.test.ts` 8 |

## 8. Product quality and operations (MVP-SCOPE §2.9)

| Requirement | Status | Implementation | Verification |
|---|---|---|---|
| Responsive web application | **IMPLEMENTED / UNDER-VERIFIED** | `apps/web` (views + design tokens in `styles.css`) | `web:build` passes; the dev-server test covers routing plumbing only. Small-screen and visual review: **NOT RUN** |
| Installable PWA | **NOT IMPLEMENTED** | — | ADR-005 is Proposed, not accepted |
| Vietnamese-first content with English-ready messages | **IMPLEMENTED / UNDER-VERIFIED** | `message_key` values in the category seed; UI copy in Vietnamese | no automated locale assertion |
| Honest loading, empty, validation, success and error states | **PARTIAL** | views implement each state; E-6 and the validation-detail milestone added named fields for rejected requests | mocked API tests + `validation-contract-detail.test.ts`; no browser-level verification |
| Accessibility (WCAG 2.2 AA core flows) | **BLOCKED** | semantic markup and labels exist in the views | requires a browser + assistive-technology review; MVP-SCOPE §6 condition 5 lists it as an MVP-completion gate |
| Production telemetry without financial payloads | **PARTIAL** | structured logs with correlation ids; no redaction test suite | no telemetry destination exists (ADR-008 proposed) |
| Staging/production separation, health checks, backups, restore drill, rollback, incident runbooks | **BLOCKED** | `/health/live` and `/health/ready` exist | everything else needs infrastructure and owner sign-off; MVP-SCOPE §6 conditions 7–8 |

## 9. Definition of MVP complete (MVP-SCOPE §6) — release gates

None of these eleven conditions is satisfied by implementation alone, and this matrix is not evidence
that any of them is closed.

| # | Condition | State |
|---|---|---|
| 1 | Every pre-implementation `SPEC-*` blocker has an authorized outcome and versioned evidence | **OPEN** — 12 blockers tracked in `docs/reviews/SPECIFICATION-REMEDIATION-ROUND-3.md` |
| 2 | Specifications and required ADRs approved with named approvers | **OPEN** — ADR-002/004/005/008 Proposed; `SPEC-AUTH-01`/`02` unratified (D-2/D-3 request open) |
| 3 | In-scope acceptance outcomes pass automated and manual tests | **PARTIAL** — automated financial/auth outcomes pass (82 integration cases, 681 unit); manual outcomes and the unimplemented capabilities above are not covered |
| 4 | Threat-model mitigations implemented and reviewed | **PARTIAL** — E-4/E-5/E-6 closed with tests; F-3 mitigated in code for the remote vector (`afc5201`), not closed (amendment A-1 unsigned) |
| 5 | WCAG 2.2 AA core-flow and small-screen review pass | **NOT RUN** |
| 6 | Cross-user authorization tests pass for every financial resource | **PARTIAL** — `journey.integration.test.ts` 10 covers transaction, goal, and account; every remaining object needs its own case |
| 7 | Migration, backup restoration, and rollback drills pass | **PARTIAL** — migration upgrade rehearsal is in `MILESTONE-11` §3; backup/restore/rollback needs infrastructure |
| 8 | Monitoring, alert routing, support ownership, incident runbooks active | **NOT RUN** |
| 9 | Privacy/legal documents, retention policy, beta consent approved | **OPEN** |
| 10 | No unresolved critical/high security vulnerability; accepted lower risks have owners and expiry | **OPEN** — F-3 (availability) technically mitigated for the remote vector but unresolved: amendment A-1 unsigned and the shared-network residual unaccepted; F-8 (low, timing) measured and awaiting a decision |
| 11 | Release checklist signed for the initial five-user cohort | **OPEN** — `docs/testing/RELEASE-CHECKLIST.md` unsigned |

## 10. What this matrix deliberately does not claim

- No identifier here is marked VERIFIED on the strength of a mocked test, a harness alone, or a
  demonstration. Rows that rely on mocks say so.
- Unimplemented capabilities are reported as **NOT IMPLEMENTED** even where the reason is a pending
  decision; "blocked by a decision" and "not built" are both true and both stated.
- The implementation follows the accepted OQ-20 revision (`4866d13`), not the older verification-branch
  specification; `ARCHITECTURE.md` and `SCREEN-INVENTORY.md` were re-checked on 2026-10-12 and already
  reflect it.
- Nothing in this document authorizes a release. Section 9 is the release gate list, and it is open.
