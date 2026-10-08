# Milestone 03 — one-off schedule occurrences and explicit confirmation

**Implementation date:** 2026-10-08<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Scope:** One-off scheduled income/essential expense, one occurrence, and explicit owner action<br>
**Production readiness:** Not claimed

This milestone implements the first bounded Schedule vertical supported by already-accepted SDD semantics. It does not resolve or implement the recurrence-generation and series-edit questions in `SPEC-SCH-01`. It does not revise FIN-01/FIN-02, auto-post money, invent another obligation model, or implement reminders, debt, planned purchases, savings, or recurrence workers.

## Delivered behavior

- An authenticated owner can create a non-recurring scheduled income or essential expense with exactly one persisted occurrence.
- One-off creation is fixed to `frequency = one_off`, interval `1`, and `confirmation_policy = explicit`; recurrence fields are not accepted by the API.
- Occurrence persistence accepts exactly `scheduled | confirmed | skipped | cancelled`. `paid`, `received`, `due_today`, and `overdue` are rejected as stored/API state values.
- Owner-scoped reads derive `upcoming | due_today | overdue` for unresolved outgoing occurrences from `due_on` and the stored user timezone. Scheduled income remains `projected`. No date passage mutates state, versions, or transactions.
- Explicit confirmation runs inside `account_financial_serialization.v1`: account lock first, same-key replay, latest-snapshot review, occurrence lock/version review, compatible category/classification validation, posted transaction insertion, and occurrence link/state transition in one commit.
- Outgoing `confirmed` is presented as `paid`; incoming `confirmed` is presented as `received`. The persisted state remains `confirmed` in both cases.
- Explicit skip and cancel are serialized owner actions. They never create a transaction and their terminal states cannot later be silently confirmed.
- The database binds item, occurrence, account, user, currency, direction, category, and confirmed transaction with composite constraints and trigger checks. Occurrence financial authority fields are immutable, terminal states are guarded, and one transaction can be the active confirmation pointer for at most one occurrence.
- A schedule-linked correction remains on the existing generic correction path only when transaction authority is preserved. It atomically transfers the occurrence’s active transaction pointer to the posted replacement, increments the occurrence version, keeps state `confirmed`, and retains old/new pointer evidence in the correction audit event.
- A generic standalone void of a schedule-linked transaction returns `FIN_CORRECTION_LINKED_DOMAIN_REQUIRED` and cannot orphan the confirmed occurrence.
- All mutation results are bounded idempotency receipts; expected/actual amounts, notes, and reasons are not copied into receipt JSON.

## HTTP surface

| Method | Path | Contract |
|---|---|---|
| `POST` | `/api/v1/schedule/one-off` | Idempotent one-off item + scheduled occurrence creation |
| `GET` | `/api/v1/schedule/occurrences` | Owner-scoped bounded list; optional accepted state/kind filters |
| `GET` | `/api/v1/schedule/occurrences/{id}` | Owner-scoped occurrence plus derived presentation |
| `POST` | `/api/v1/schedule/occurrences/{id}/confirm` | Idempotent explicit confirmation and atomic posted-transaction link |
| `POST` | `/api/v1/schedule/occurrences/{id}/skip` | Idempotent explicit transition to `skipped` |
| `POST` | `/api/v1/schedule/occurrences/{id}/cancel` | Idempotent explicit transition to `cancelled` |

Every route derives ownership from the trusted principal, rejects owner/account/currency/state authority from request bodies, emits `Cache-Control: no-store`, and uses strict request/response schemas.

## SDD traceability

| SDD requirement / invariant | Implementation | Automated verification |
|---|---|---|
| PRD-INC-03, PRD-EXP-04; Database §7.1 | `PostgresScheduleRepository.createOneOff`; migration `0002` item/occurrence pair fixed to one-off + explicit confirmation | Contract strictness, migration contract, API injection, guarded PostgreSQL create/replay tests |
| OQ-04; PRD-REM-03; UF-SCH-02/03 | `confirmOccurrence` creates and links one posted transaction in the account serializer; no timer/worker path exists | Guarded PostgreSQL outgoing/incoming confirmation and competing-confirmation tests |
| FIN-SNAP-INV-03/06/07; SPEC-FIN-02 §5 | Existing account-first serializer derives snapshot anchor/effect and increments financial state once | Serializer suite plus guarded PostgreSQL balance/version/replay assertions |
| Database §7.2; FIN-OCC-01 | Database `CHECK`, trigger state machine, strict Zod state enum | Contract/migration tamper tests and PostgreSQL stored-state assertion |
| FIN-OCC-02/03 | `deriveOccurrencePresentation` maps outgoing/incoming `confirmed` to `paid`/`received` only at read time | Pure domain tests and PostgreSQL outgoing/incoming read assertions |
| FIN-OCC-04 | Local-date presentation derives from occurrence due date and item timezone, without a write | Fixed-clock domain and PostgreSQL upcoming/due-today/overdue assertions; versions remain unchanged |
| SPEC-FIN-01 §7; FIN-LINK-01 | Correction preview includes schedule claim/version; commit locks claim and transfers pointer; generic linked void fails closed | Guarded PostgreSQL correction-transfer and linked-void assertions |
| FIN-DOMAIN-LINK-INV-01 | New confirmation creates a fresh transaction under the account lock; per-table unique/composite constraints protect the implemented schedule claim family | Migration constraints and concurrent PostgreSQL confirmation test |
| SEC-APP-15 / ownership | Every occurrence query and mutation uses principal-derived `user_id`; absent and unowned IDs are equivalent | Fastify BOLA/mass-assignment tests and two-user PostgreSQL tests |
| PRD-FIN-13 / idempotency | Existing digest-only replay-before-stale serializer is reused for every schedule mutation | Same-key create/confirm replay and competing-key stale integration assertions |

## Explicitly excluded semantics

- Weekly, monthly, or yearly generation; leap-day/month-end policy execution; bounded generation windows; and series edits are not implemented. Those paths remain gated by `SPEC-SCH-01` and are rejected rather than guessed.
- Reminder stage generation/delivery, catch-up, deduplication, and notification persistence remain outside this slice and retain their existing `SPEC-REM-01` gate.
- Debt-payment and planned-purchase ownership families do not yet exist. This milestone implements only no-domain and one non-debt schedule claim shapes; it does not claim the debt composite or planned-purchase branches of the full P1 matrix.
- Safe-to-spend/reporting, Schedule UI, Vietnamese copy review, accessibility/usability evidence, and authentication/session delivery are not included.

## Evidence boundary and retained OPEN items

The credential-free suites verify contracts, pure presentation derivation, API owner scope, migration text, and serialization protocol. The guarded integration suite creates an isolated schema, applies the real migrations, and exercises the repository against synthetic PostgreSQL when explicitly configured. Local absence of PostgreSQL causes a reported skip rather than a fabricated PASS.

GitHub Actions run [`37765521826`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37765521826) completed the harness, typecheck, `74` credential-free tests, the prior foundation/correction integration suites, and all `5` schedule integration tests against ephemeral synthetic PostgreSQL 17.6. The preceding run `37765370060` failed three confirmation fixtures because its fixed clock made their transaction dates future-dated; domain validation rejected them correctly, the fixture was aligned, and no PASS was claimed for that failed run.

This milestone does not close owner/co-approver acceptance of FIN-01/FIN-02, `SPEC-SCH-01`, `SPEC-REM-01`, FIN-RACE/Supabase evidence, RLS/runtime-role decisions, deployment, operations, security/legal/governance review, or release gates. A passing synthetic PostgreSQL implementation suite is not production or Supabase evidence.

No genuine contradiction in the frozen semantics was encountered. The recurrence/reminder questions were avoided by the deliberately one-off, explicit-confirmation scope; no SDD file was rewritten.
