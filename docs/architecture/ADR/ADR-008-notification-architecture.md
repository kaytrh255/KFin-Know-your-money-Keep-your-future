# ADR-008 — Notification Architecture

**Status:** Proposed<br>
**Date:** 2026-10-07<br>
**Decision owners:** Unassigned<br>
**Related:** [PRD reminders](../../product/PRD.md#78-schedule-reminders-and-warnings), OQ-06, OQ-12, OQ-19

## Context

KFin needs required email for verification/recovery/security and in-app outgoing-obligation reminders without falsely changing financial state or creating notification spam. Product review selected in-app-only payment reminders, evaluated at 09:00 user-local time, with one notification for each 7-day, 3-day, due-today, and first-overdue stage. Push, payment-reminder email, SMS, and chat channels are future scope. At most 50 users do not justify Redis, Kafka, or a separate notification service.

## Decision

Use a **PostgreSQL transactional outbox/job mechanism plus a small worker**, while separating schedule state, in-app notification creation, and required security-email delivery.

### Product channels

- In-app notification center is the only MVP outgoing-obligation reminder channel; scheduled income remains visible/projected but has no fixed-stage notification requirement.
- Required verification, recovery, and approved security email is a separate authentication/security communication path.
- Payment-reminder email, push, SMS, and chat are not implemented.
- There is no reminder-channel/quiet-hours preference screen in MVP.

### Scheduling and state

- Schedule occurrences remain the source of due/paid/received state.
- Only eligible outgoing occurrences receive these fixed reminder stages.
- Worker evaluates stages at 09:00 in the occurrence/user IANA timezone.
- Stages are `seven_days`, `three_days`, `due_today`, and `first_overdue`.
- Unique occurrence + stage key permits one in-app notification per stage.
- `first_overdue` is created once and does not repeat daily or weekly while the item remains overdue.
- Due-date passage creates due/overdue presentation and notification eligibility only; it never creates a transaction or marks paid.
- Confirmation, skipping, or cancellation prevents unresolved future stage creation.
- Cash-flow warnings use a versioned month-end calculation fingerprint; unchanged warnings are deduplicated.

### Delivery and job behavior

- Domain transaction inserts any required non-secret job/notification intent atomically.
- Worker claims rows with a lease, rechecks current occurrence state, creates the in-app notification idempotently, and records completion.
- Bounded exponential backoff/jitter handles transient database/runtime errors; permanent failure/dead-letter remains operator-visible.
- Worker downtime/timezone/late-occurrence catch-up never duplicates a stage. The product policy for suppressing versus emitting multiple already-missed stages must be approved before reminder implementation; it must not produce a burst of stale notifications by accident.
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

## Revisit when

- payment-reminder email, push, SMS, or native packaging is promoted;
- queue volume/latency harms PostgreSQL;
- multiple application regions require a different scheduler topology;
- beta evidence shows once-only overdue behavior is insufficient and a new anti-spam policy is specified.
