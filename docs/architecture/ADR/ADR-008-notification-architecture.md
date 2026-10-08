# ADR-008 — Notification Architecture

**Status:** Blocked<br>
**Date:** 2026-10-07<br>
**Decision owners:** Product Owner; Architecture Owner; Operations Owner; QA Owner<br>
**Exact blocker:** Round 3 makes `SPEC-REM-01` decision-ready but does not select catch-up emission, one-stage precedence, recovery window, first-overdue treatment, suppression record, timezone/late-creation result, or state-race behavior. Atomic intent/crash-reclaim, race, timezone, Vietnamese-content, accessibility, and channel-separation evidence also does not exist.<br>
**Related:** [PRD reminders](../../product/PRD.md#78-schedule-reminders-and-warnings), OQ-06, OQ-12, OQ-19

## Context

KFin needs required email for verification/recovery/security and in-app outgoing-obligation reminders without falsely changing financial state or creating notification spam. Product review selected in-app-only payment reminders, evaluated at 09:00 user-local time, with at most one notification for each 7-day, 3-day, due-today, and first-overdue stage. Push, payment-reminder email, SMS, and chat channels are future scope. At most 50 users do not justify Redis, Kafka, or a separate notification service.

## Decision

Use a **PostgreSQL transactional outbox/job mechanism plus a small worker**, while separating schedule state, in-app notification creation, and required security-email delivery.

### Product channels

- In-app notification center is the only MVP outgoing-obligation reminder channel; scheduled income remains visible/projected but has no fixed-stage notification requirement.
- Required verification, recovery, and approved security email is a separate authentication/security communication path.
- Payment-reminder email, push, SMS, and chat are not implemented.
- There is no reminder-channel/quiet-hours preference screen in MVP.

### Scheduling and state

- Schedule occurrences persist only `scheduled | confirmed | skipped | cancelled`. Due/overdue is derived from `scheduled`; Paid/Received is direction-specific presentation of `confirmed`.
- Only eligible outgoing occurrences receive these fixed reminder stages.
- Worker evaluates stages at 09:00 in the occurrence/user IANA timezone.
- Stages are `seven_days`, `three_days`, `due_today`, and `first_overdue`.
- Unique occurrence + stage key permits one in-app notification per stage.
- `first_overdue` is created once and does not repeat daily or weekly while the item remains overdue.
- Due-date passage creates due/overdue presentation and notification eligibility only; it never creates a transaction or transitions persisted state to `confirmed`.
- Confirmation, skipping, or cancellation prevents unresolved future stage creation.
- Cash-flow warnings use a versioned month-end calculation fingerprint; unchanged warnings are deduplicated.

### Reminder invariants

- **REM-INV-01 — Eligible facts:** only an unresolved outgoing occurrence can receive fixed payment stages; scheduled income never receives them.
- **REM-INV-02 — Local target:** stage targets are 7 days before, 3 days before, due today, and first overdue at 09:00 in the persisted user/occurrence IANA timezone.
- **REM-INV-03 — Durable uniqueness:** occurrence + stage is unique across normal evaluation, retries, process crashes, worker downtime, and timezone recalculation; first-overdue never repeats while unresolved.
- **REM-INV-04 — State recheck:** immediately before insertion, the worker rechecks ownership, current due date/timezone, occurrence version/state, and uniqueness. Confirmed, skipped, or cancelled state suppresses new stages.
- **REM-INV-05 — No financial authority:** evaluation, creation, read, dismiss, worker retry, and app open/close never mark an occurrence paid/received and never create a transaction.
- **REM-INV-06 — Closed-app independence:** server evaluation does not depend on Web/PWA lifecycle. A closed app does not stop eligible server evaluation, and opening/returning to the app does not itself evaluate or synthesize elapsed stages.
- **REM-INV-07 — Delayed return:** return displays persisted unread/read state once. It does not replay worker history, duplicate delivered stages, or emit one notification per elapsed stage.
- **REM-INV-08 — No catch-up burst:** when downtime, late occurrence creation, or timezone change makes multiple stages elapsed, one recovery evaluation creates at most one catch-up notification for that occurrence.
- **REM-INV-09 — Catch-up selection blocker:** which single eligible stage, if any, wins; how non-selected elapsed stages are recorded; and the recovery-window boundary remain **BLOCKER `SPEC-REM-01`**, accountable to the Product Owner with Architecture, Operations, and QA co-approval. No implementer may infer `latest`, `earliest`, `most severe`, or `all`.
- **REM-INV-10 — Channel boundary:** catch-up remains in-app only; it never falls back to payment-reminder email, push, SMS, or chat.

### Round 3 `SPEC-REM-01` decision packet

Product, Architecture, Operations, and QA owners must approve one complete tuple; no tuple component may be inferred independently:

1. emit zero or one catch-up after exactly one missed stage;
2. emit zero or one catch-up after multiple missed stages;
3. if one is emitted, deterministic precedence (`latest`, `earliest`, `first-overdue`, another reviewed rule, or condition-specific mapping);
4. maximum recovery age/window and boundary inclusivity;
5. first-overdue treatment relative to pre-due/due-today stages;
6. persisted status/reason for every elapsed non-selected stage;
7. outcome after forward/backward timezone changes and late occurrence creation;
8. outcome when occurrence state/version changes during claim/insert.

**Required evidence:** exact RCT-04–RCT-07 and `REM-REC` outcomes, fixed-clock/timezone tests, worker outage/late-creation simulations, state-race and deduplication proof, and reviewed Vietnamese compact/expanded accessible content.

**Acceptance condition:** all eight tuple items have one approved value; each affected test has one result; source documents agree; named approvers/date/source version/evidence are recorded. `REM-INV-08` and `REM-INV-10` cannot be relaxed. Until then ADR-008 remains **Blocked** and `SPEC-REM-01` remains **OPEN — decision ready**.

### Delivery and job behavior

- Domain transaction inserts any required non-secret job/notification intent atomically.
- Worker claims rows with a lease, rechecks current occurrence state, creates the in-app notification idempotently, and records completion.
- Bounded exponential backoff/jitter handles transient database/runtime errors; permanent failure/dead-letter remains operator-visible.
- Worker downtime, late occurrence creation, and timezone-change catch-up obey `REM-INV-08`; exact selection/suppression remains blocked by `REM-INV-09`. Closed-app or delayed-app-return behavior obeys `REM-INV-06` and `REM-INV-07`.
- Notification read/dismiss state has no authority over payment/receipt state.
- Email verification OTP and password-reset secrets are not placed in the ordinary outbox. Under ADR-002, they are submitted immediately from ephemeral request-process memory after digest-only challenge commit. A future encrypted asynchronous envelope requires a separate key-management decision.
- Non-secret security email may use the outbox/provider adapter with minimum template data.

## Alternatives considered

### In-app plus opt-in payment-reminder email

**Benefits:** reaches users who do not open KFin.<br>
**Rejected for MVP by OQ-06:** increases privacy, deliverability, preference/unsubscribe, duplicate-channel, provider, and testing scope. It remains a future candidate requiring a new specification.

### Client-only reminder computation

**Benefits:** no worker/job table.<br>
**Rejected:** browser lifecycle and multi-device behavior are unreliable; notification history/deduplication would not be authoritative.

### Redis-backed queue

**Benefits:** mature queue libraries and efficient delayed work.<br>
**Rejected now:** another stateful service, security/backup/monitoring surface, and transactional coordination are unjustified at beta scale.

### Managed message queue/event bus

**Benefits:** durable decoupling and scale.<br>
**Rejected now:** additional infrastructure/IAM/cost and eventual-consistency complexity without measured volume. It can be introduced behind the outbox later.

### Push-first notifications

**Benefits:** timely mobile engagement.<br>
**Rejected for MVP:** permission UX, PWA/platform variation, native/APNs/FCM credentials, privacy, and token lifecycle are unapproved future scope.

## Reasoning

- In-app-only meets the selected MVP boundary and reduces inbox/lock-screen privacy exposure.
- PostgreSQL durable intent closes the application commit/job gap without another infrastructure service.
- Separating occurrence from notification prevents reminders from becoming financial truth.
- One first-overdue notification avoids notification spam while Schedule continuously communicates overdue state.
- A channel adapter preserves a future path without implementing external reminder channels now.

## Consequences

### Positive

- Durable, retryable, auditable, and deduplicated in-app reminder intent.
- No Redis, broker, push service, or reminder-email preference/deliverability work.
- Notification failure does not corrupt financial actions.
- Exact timezone/stage behavior is testable.

### Negative / risks

- Users see reminders only when they open KFin.
- Polling creates bounded notification delay.
- Job tables require pruning/index care.
- Timezone change, worker downtime, and 09:00 catch-up logic remain subtle.
- A once-only overdue notification may be overlooked; Schedule is the persistent fallback.

### Required controls

- Queue depth/oldest age/retry/dead-letter metrics and alerts.
- Bounded claims, concurrency, attempts, payload, and retention.
- Unique occurrence + stage constraints and state recheck at execution.
- Timezone, leap/day-boundary, timezone-change, downtime catch-up, and deduplication tests.
- No amount/note in generic logs or product analytics.
- Required security-email SPF/DKIM/DMARC, provider webhook verification where used, and payload redaction remain under authentication/security controls.

## Validation before acceptance

- Prototype atomic notification intent and crash/reclaim behavior.
- Approve and test the multi-stage suppression/catch-up policy for timezone changes, late occurrence creation, and worker outages at the 09:00 boundary.
- Test schedule edit/payment confirmation racing with reminder evaluation.
- Prove one notification per stage and one first-overdue notification over long unresolved periods.
- Review Vietnamese notification content, accessibility, and no-external-channel UX.
- Confirm authentication/security email remains operationally separate.
- Retain versioned RCT/`REM-REC` results, content/accessibility review, named approvers, date, source versions and review trigger in the governance register; a policy table without evidence is not acceptance.

## Revisit when

- payment-reminder email, push, SMS, or native packaging is promoted;
- queue volume/latency harms PostgreSQL;
- multiple application regions require a different scheduler topology;
- beta evidence shows once-only overdue behavior is insufficient and a new anti-spam policy is specified.
