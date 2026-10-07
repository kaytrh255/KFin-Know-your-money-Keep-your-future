# ADR-008 — Notification Architecture

**Status:** Proposed<br>
**Date:** 2026-10-07<br>
**Decision owners:** Unassigned<br>
**Related:** [PRD reminders](../../product/PRD.md#78-schedule-reminders-and-warnings), OQ-06, OQ-12

## Context

KFin needs email for verification/recovery and needs payment/income reminders without falsely changing financial state or generating spam. Initial reminders include seven days, three days, due today, and overdue. Push/SMS are future candidates. Delivery is external and can fail after a financial/database transaction commits. At most 50 users do not justify Redis, Kafka, or a separate notification service.

## Decision

Use a **PostgreSQL transactional outbox plus a small worker** and separate domain notification intent from channel delivery.

### Product channels

- In-app notification center is the authoritative product notification history for approved events.
- Opt-in email reminders are recommended for MVP, pending OQ-06; required authentication/security email follows its own necessary-delivery policy.
- Push, SMS, and chat channels are not implemented in MVP.

### Scheduling and state

- Schedule occurrences remain the source of due/paid/received state.
- A periodic worker evaluates occurrence date/state in the user/schedule timezone and creates an idempotent reminder intent for occurrence + stage + channel.
- Due-date passage creates due/overdue presentation/reminder eligibility only; it never creates a transaction or marks paid.
- Confirmation/skipping/cancellation prevents unresolved future reminders for that occurrence.
- Cash-flow warnings use a versioned calculation fingerprint; unchanged warnings are deduplicated/suppressed.

### Delivery

- The ordinary outbox carries only non-secret notification intent. Email verification OTP and password-reset secrets are a deliberate exception: under ADR-002 they are submitted immediately from ephemeral request-process memory after the digest-only challenge is committed. They are never queued as plaintext. A future encrypted asynchronous envelope requires a separate key-management decision.
- Domain transaction inserts an outbox row atomically with any required non-secret notification intent.
- Worker claims rows with a lease, sends through an email adapter or creates in-app notification, records result, and retries transient failures with bounded exponential backoff/jitter.
- Every logical delivery has a unique deduplication key.
- Permanent failure/dead-letter is visible to operators and does not alter financial truth.
- Provider webhooks, if used, are authenticated, replay-protected, idempotent, and map only delivery state—not payment state.
- Templates receive minimum required data and do not put detailed balances/notes in subject lines or telemetry. Exact amount inclusion in reminder email requires privacy review.

## Alternatives considered

### Synchronous email from API request

**Benefits:** simple code path and immediate provider response.<br>
**Rejected:** provider latency/outage would block user operations; database commit and send cannot be atomic; retries risk duplicates.

### Redis-backed queue

**Benefits:** mature queue libraries and efficient delayed jobs.<br>
**Rejected now:** another stateful service, backup/monitoring/security surface, and transactional coordination with PostgreSQL are unjustified at beta scale.

### Managed message queue/event bus

**Benefits:** durable decoupling and scale.<br>
**Rejected now:** additional infrastructure/IAM/cost and eventual-consistency complexity without volume evidence. Could be introduced behind the outbox later.

### Client-only local reminders

**Benefits:** no server worker/email cost.<br>
**Rejected:** browser lifecycle/unreliability, multi-device duplication, timezone/state staleness, and no authoritative delivery history.

### Push-first notifications

**Benefits:** timely mobile engagement.<br>
**Rejected for MVP:** permission UX, PWA/platform variation, native/APNs/FCM credentials, privacy, and token lifecycle are unapproved future scope.

## Reasoning

- Transactional outbox closes the commit/send gap without distributed transactions.
- PostgreSQL is already operated and easily handles beta volume.
- Separating occurrence from delivery prevents notifications from becoming financial truth.
- Channel adapter leaves a future path without implementing channels now.

## Consequences

### Positive

- Durable, retryable, and auditable reminder intent.
- No Redis/broker/microservice.
- Delivery outages do not corrupt financial actions.
- Strong deduplication model.

### Negative / risks

- Polling creates bounded delivery delay.
- Job tables require pruning/index care to avoid database bloat.
- “Exactly once” email is impossible across external failures; idempotency reduces but cannot eliminate provider-edge duplicates.
- Timezone/recurrence/quiet-hour logic is subtle.
- Email can disclose sensitive context on shared lock screens/inboxes.

### Required controls

- Queue depth/oldest age/retry/dead-letter metrics and alerts.
- Bounded claims, concurrency, attempts, payload, retention, and provider timeouts.
- Template approval, unsubscribe/preference policy for nonessential mail, and delivery-domain security (SPF/DKIM/DMARC).
- Timezone/DST/date-boundary and deduplication tests.
- Email provider webhook authentication and payload redaction.
- No amount/note in notification analytics or generic logs.

## Validation before acceptance

- Resolve channels, quiet hours, exact send times, overdue repeat policy, and amount privacy under OQ-06/OQ-12.
- Prototype atomic outbox and crash/reclaim behavior.
- Simulate provider timeout after accepted send and verify bounded duplicate handling.
- Test schedule changes and payment confirmation racing with reminder evaluation.
- Review email content/accessibility/localization and deliverability setup.

## Revisit when

- push/SMS/native packaging is promoted;
- queue volume/latency harms PostgreSQL;
- multiple application regions require a different scheduler topology;
- provider capabilities justify a managed queue behind the same outbox contract.
