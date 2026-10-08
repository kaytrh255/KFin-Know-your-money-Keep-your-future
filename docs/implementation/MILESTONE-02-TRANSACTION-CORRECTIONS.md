# Milestone 02 — append-only transaction corrections

**Implementation date:** 2026-10-08<br>
**Frozen SDD baseline:** `a48d2c5683550859c1b4e19e9d06750616adc0a2`<br>
**Policy implemented:** `snapshot_correction.v1` for currently unlinked financial transactions<br>
**Scope:** Next narrow financial-core vertical after Milestone 01<br>
**Production readiness:** Not claimed

This milestone implements the next bounded part of the frozen financial SDD. It does not revise FIN-01/FIN-02, invent another correction model, introduce in-place financial edits, or implement schedule, debt, purchase, savings, notification, or authentication domains.

## Delivered behavior

- An authenticated owner can request an authoritative correction or standalone-void consequence preview.
- A preview exposes source and proposed facts, immutable authority fields, latest-versus-closed segment, current-balance before/delta/after, report-period/category movement, owning-domain status, and the exact reviewed version context required at commit.
- A supported correction atomically inserts one same-owner/account/currency/kind/anchor/effect replacement, then transitions the posted terminal source to `voided` with reason/time/version evidence.
- A supported standalone void transitions one unlinked posted terminal source without creating a replacement.
- Source financial facts remain immutable. The existing unique successor constraint prevents branching.
- Latest-segment current correction applies replacement minus source exactly once. Latest historical and all closed-segment corrections/voids have zero current-balance effect.
- A date requiring another anchor/effect is rejected with `FIN_CORRECTION_CROSS_SEGMENT_UNSUPPORTED`; reviewed anchor/effect/direction tampering receives the corresponding stable safe correction code.
- Commit revalidates account version, latest snapshot, source version/status/terminal state, immutable authority fields, category/direction compatibility, date validity, and a canonical digest binding the confirmed draft/reason to its preview under the account-row serialization boundary.
- A source-state loser persists only a bounded `FIN_CORRECTION_STALE_STATE` idempotency receipt, with no domain/audit/version mutation. Compatible same-key retries replay before stale comparison.
- Correction results retain only source/replacement references and committed financial-state version; idempotency JSON does not duplicate amount, note, reason, or the full transaction.
- Owner-scoped transaction detail now exposes void/supersession markers, and correction history returns the complete linear chain from any owned member.
- Owner-scoped monthly actuals aggregate only posted terminal facts, exclude voided rows, and expose an `amended` indicator for replacement-backed groups.

## HTTP surface

| Method | Path | Contract |
|---|---|---|
| `POST` | `/api/v1/transactions/{id}/correction-preview` | Authoritative correction preview; no mutation |
| `POST` | `/api/v1/transactions/{id}/void-preview` | Authoritative standalone-void preview; no mutation |
| `POST` | `/api/v1/transactions/{id}/corrections` | Idempotent append-only void + replacement |
| `POST` | `/api/v1/transactions/{id}/void` | Idempotent standalone void |
| `GET` | `/api/v1/transactions/{id}/correction-history` | Owner-scoped complete linear chain |
| `GET` | `/api/v1/reports/monthly-actuals?month=YYYY-MM` | Posted monthly actuals and amended category groups |

Every route derives ownership from the trusted principal, uses `Cache-Control: no-store`, and rejects client-supplied owner/account authority. Correction commit accepts reviewed authority context only as a precondition and independently resolves every authoritative value on the server.

## SDD traceability

| SDD requirement / invariant | Implementation | Automated verification |
|---|---|---|
| PRD-FIN-04; FIN-SNAP-INV-08 | `PostgresTransactionCorrectionService.correct` inserts a replacement and voids the terminal source atomically; `void` creates no replacement | Domain, serializer, API, and guarded PostgreSQL `FIN-COR-01/02/03/07/09/10` tests |
| PRD-FIN-11; FIN-SNAP-INV-10 | `validateCorrectionOccurrenceDate`; reviewed source anchor/effect/inclusion/kind/currency checks | Unit transition matrix and guarded PostgreSQL `FIN-COR-04/05/06` tests |
| PRD-FIN-12/13; FIN-SNAP-INV-09 | Existing account-first serializer extended with `FIN_CORRECTION_STALE_STATE` and work-discovered stable terminal receipts | Serializer protocol test; PostgreSQL competing-correction and snapshot/correction tests |
| SPEC-FIN-01 §§3–4 | Existing immutable transaction trigger, unique successor, source reason/time/version, safe audit metadata, and owner-scoped chain CTE | Migration contract plus correction-history integration assertions |
| SPEC-FIN-01 §5 | `correctionCurrentBalanceDelta`, latest-segment balance view, posted-only monthly aggregate | Pure bigint tests and PostgreSQL current-balance/month movement assertions |
| SPEC-FIN-01 §6 | Server preserves source authority fields and rejects cross-segment/effect transitions | Contract strictness, domain tests, `FIN-COR-05/06` integration assertions |
| SPEC-FIN-01 §8 | Preview response carries source/replacement, anchor/effect/segment, balance and report consequences, owning-domain status, and reviewed context | Contract and Fastify injection tests plus integration preview assertions |
| SPEC-FIN-01 §9 | Same-key lookup before stale state, one version winner, stable stale receipt, same-key unknown-commit recovery inherited from serializer | Serializer tests and concurrent PostgreSQL `FIN-COR-09/10` tests |
| PRD-FIN-02/08 and reporting rule | Monthly actuals count only posted rows by local occurrence month and mark replacement-backed groups amended | Guarded PostgreSQL latest/historical/closed/report-move tests |
| SEC-APP-15 / ownership | All source, history, mutation, and report reads are owner-scoped; foreign records remain unavailable | API owner derivation and two-user PostgreSQL tests |

## FIN-COR status

| Case | Status in this milestone | Evidence boundary |
|---|---|---|
| `FIN-COR-01` | Implemented; PostgreSQL CI PASS | Latest current expense correction, exact balance, chain, active report effect |
| `FIN-COR-02` | Implemented; PostgreSQL CI PASS | Closed-segment correction leaves latest balance unchanged |
| `FIN-COR-03` | Implemented; PostgreSQL CI PASS | Historical correction changes report only |
| `FIN-COR-04` | Implemented; PostgreSQL CI PASS | Valid month move removes source-month effect and adds replacement-month effect |
| `FIN-COR-05` | Implemented; PostgreSQL CI PASS | Cross-anchor date rejected with no mutation |
| `FIN-COR-06` | Implemented; PostgreSQL CI PASS | Reviewed authority/effect/preview tampering rejected with no mutation |
| `FIN-COR-07` | Implemented; PostgreSQL CI PASS | Standalone void reverses once and same-key replay is stable |
| `FIN-COR-08` | **NOT RUN — implementation prerequisite** | Schedule/debt/planned-purchase link schemas and owning services remain outside this milestone |
| `FIN-COR-09` | Implemented; PostgreSQL CI PASS | Parallel compatible same-key calls produce one chain/result; changed digest rejected |
| `FIN-COR-10` | Partial PostgreSQL CI PASS | Competing correction and snapshot/correction races passed; link-state race remains **NOT RUN — implementation prerequisite** |

GitHub Actions run [`37758123849`](https://github.com/kaytrh255/KFin-Know-your-money-Keep-your-future/actions/runs/37758123849) executed the foundation test and all eight correction integration tests successfully against ephemeral synthetic PostgreSQL 17.6. Local no-credential runs still skip those tests rather than fabricating database evidence. The successful suite is not full FIN-RACE or Supabase evidence.

## Known limitations and retained OPEN items

1. Schedule occurrences, debt payments, and planned-purchase completions do not yet exist in the implementation schema. Therefore every current transaction is unlinked, previews truthfully return owning-domain type `none`, and `FIN-COR-08` plus the link-state branch of `FIN-COR-10` remain **NOT RUN — implementation prerequisite**.
2. This milestone does not claim `FIN-LINK-01..06`, `FIN-OCC-01..04`, or full `FIN-RACE-01..08` closure. The dedicated forced-order/repetition/fault suite and intended Supabase pool environment remain OPEN.
3. Monthly actuals provide the correction-sensitive posted totals and amended grouping required for this backend vertical; dashboard charts, drill-down UI, selected-month UX, and usability/accessibility evidence remain outside this milestone.
4. The standalone API still fails protected routes closed because authentication/session delivery is not implemented. Tests inject only a trusted principal; no user-ID header bypass exists.
5. No correction UI is implemented. The API distinguishes preview, correction, and void, but visual/content/usability/accessibility approval remains OPEN.
6. Owner/co-approver approvals, ADR acceptance, RLS decision/evidence, runtime-role grants, deployment, operations, security/legal/governance review, and release gates remain OPEN.
7. Candidate timeout/retry/idempotency-retention values remain unapproved for production. No default idempotency retention or background pruning job was introduced.

No genuine contradiction in the frozen correction/concurrency semantics was encountered. The SDD files remain unchanged.
