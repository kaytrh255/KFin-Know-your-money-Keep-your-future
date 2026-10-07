# ADR-005 — PWA Strategy

**Status:** Proposed<br>
**Date:** 2026-10-07<br>
**Decision owners:** Web/PWA Owner; Security Owner; UX/Accessibility Owner<br>
**Exact blocker:** `SPEC-UX-01` and `SPEC-GOV-01` — no approved compact/expanded visual, usability, accessibility, browser matrix, install/update/offline/logout, private-cache inspection, form-interruption, or service-worker security evidence exists. Round 3 defines the evidence manifest and approval record but supplies no evidence. The approved MVP scope fixes the installable-PWA direction but does not constitute validation.<br>
**Related:** [UX specification](../../ux/UX-SPEC.md), [ADR-006](ADR-006-mobile-strategy.md)

## Context

KFin’s primary product is the Web application, but mobile users should be able to install it and return with an app-like experience. Financial data and session tokens are highly sensitive. MVP does not require offline transaction entry/synchronization, and accidental private-data caching would create more risk than value.

## Decision

Make the responsive web client an **installable PWA with a deliberately restricted service worker**.

- Provide a validated web manifest, icons, standalone display metadata, theme/background colors, and stable start URL.
- Cache only hashed/versioned public static build assets and a minimal non-sensitive offline shell.
- Use network-only/no-store behavior for authenticated API calls, private HTML/data, auth endpoints, and security-sensitive resources.
- Do not persist financial responses, tokens, OTP/reset information, or rendered private payloads in Cache Storage/IndexedDB for offline use.
- Do not queue financial mutations in Background Sync in MVP.
- When offline, show explicit status and disable/retain a pending form locally in memory where safe; never claim it is saved or secretly queue it.
- Coordinate service-worker update activation so an in-progress form is not discarded. Prompt/reload only at a safe point.
- Show install guidance after user engagement or explicit action, not an immediate intrusive prompt.
- Apply authenticated response `Cache-Control: no-store` and test browser/back-forward/service-worker behavior.

PWA is a delivery enhancement, not a separate product or backend.

## Alternatives considered

### Responsive web with no service worker/manifest

**Benefits:** smallest attack and caching surface.<br>
**Not selected:** misses the requested PWA target and home-screen/standalone experience. It remains the fail-safe fallback if secure caching cannot be demonstrated before beta.

### Offline-first application with local financial database and sync

**Benefits:** full use without connectivity.<br>
**Rejected for MVP:** conflict resolution, encryption/key management, multi-device consistency, revocation, data leakage, and duplicate financial writes are a major unspecified product/security scope.

### Cache authenticated reads for offline review

**Benefits:** useful on poor networks.<br>
**Rejected initially:** persistence after logout/device sharing and service-worker cache mistakes carry significant privacy risk. A future specification may define encrypted local data, retention, and remote wipe limitations.

### Native app first

Rejected because it would duplicate or delay the primary web product and contradict the intended reuse path.

## Reasoning

- Delivers installability and app-like launch while keeping financial truth server-authoritative.
- Reduces private-data persistence on user devices.
- Avoids an offline consistency model that the MVP does not need.
- Preserves the same UI and API for browsers and future packaging.

## Consequences

### Positive

- One deployable client and one interaction system.
- Fast repeat load for versioned static assets.
- Clear security boundary: offline shell is not a private financial cache.
- No synchronization conflicts or hidden writes.

### Negative / risks

- Users cannot add or review server-only financial data offline.
- Service-worker bugs can cause stale client/API incompatibility.
- PWA install/support varies by browser/OS.
- Even static caching requires careful route exclusion and update tests.

### Required controls

- Automated assertion that authenticated/API routes are absent from cache.
- Manual installed-mode tests on supported iOS/Android/desktop browsers.
- CSP, manifest, service-worker scope, update, logout, and back-button tests.
- Version compatibility window between deployed client and API.
- Kill switch or unregister/recovery procedure for a bad service worker.

## Validation before acceptance

- Define supported browser matrix.
- Demonstrate install/update/offline/logout flows.
- Inspect Cache Storage/IndexedDB after use and logout for private payload.
- Confirm form behavior during update and network loss.
- Perform security review of caching headers and service-worker code.

## Revisit when

- Users demonstrate a strong need for offline review or entry;
- browser capabilities/security controls materially change;
- Capacitor packaging is promoted and alters local asset strategy.
