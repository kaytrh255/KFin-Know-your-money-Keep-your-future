# ADR-006 — Mobile Strategy

**Status:** Proposed<br>
**Date:** 2026-10-07<br>
**Decision owners:** Unassigned<br>
**Related:** [ADR-005](ADR-005-pwa-strategy.md), [UX specification](../../ux/UX-SPEC.md)

## Context

KFin must work exceptionally well on small screens and has a target path from Web to PWA to possible Android/iOS packaging with Capacitor. Maintaining independent web, Android, and iOS products would multiply feature, security, accessibility, and test effort. Native-store release requirements, business value, notification needs, and secure mobile session transport have not yet been specified.

## Decision

Adopt a **web-first, one-client-codebase strategy**:

1. Build and validate responsive Web/PWA as the MVP product.
2. Keep domain rules on the server and client business state/API contracts platform-neutral.
3. Use capability adapters for storage, network status, deep links, notifications, and lifecycle instead of scattering browser globals through features.
4. Do not ship native Android/iOS binaries in MVP unless a new approved specification promotes them.
5. If promoted, use Capacitor to package the same compiled web application and UI wherever practical, adding only minimal platform adapters/plugins.
6. Native authentication must use reviewed platform secure storage and transport; browser cookies/tokens must not be copied into ordinary JavaScript storage.
7. Native permissions and plugins follow least privilege. No contacts, location, files, biometrics, or push permission without a specified user feature.
8. Platform-specific UX changes are allowed when required by accessibility, keyboard, safe-area, back navigation, or store policy, but feature semantics stay shared.

## Alternatives considered

### Three independent applications

**Benefits:** maximum platform-native control.<br>
**Rejected now:** unacceptable duplication for 50 users, inconsistent financial behavior/security risk, and slower delivery.

### React Native/Flutter shared native app plus separate web

**Benefits:** stronger native component model and offline/device capability.<br>
**Not selected:** creates a second frontend architecture and test surface before native value is proven. Reconsider only with evidence that web-view packaging cannot meet required experience.

### Capacitor in MVP immediately

**Benefits:** early app-store presence and native plugin access.<br>
**Rejected for current scope:** store operations, signing, privacy declarations, review timelines, plugin security, session transport, and release channels are substantial unapproved work; PWA covers initial mobile access.

### Remote hosted web page inside a thin shell

**Benefits:** immediate updates without store binary releases.<br>
**Not chosen as the default:** store policy, blank/offline startup, integrity, and version-control concerns require review. A future Capacitor decision must select bundled assets versus remote content explicitly.

## Reasoning

- Matches the stated reuse target and mobile-first UX requirement.
- Keeps financial logic and authorization server-authoritative.
- Proves product value before incurring store/platform operations.
- Capability adapters leave a controlled future seam.

## Consequences

### Positive

- One feature/design-system implementation.
- Web/PWA fixes benefit mobile immediately.
- Lower staffing, testing, and release complexity.
- No premature native dependencies or permissions.

### Negative / risks

- Some native behaviors may feel less platform-specific.
- Capacitor WebView differences may reveal keyboard, viewport, cookie, and accessibility issues.
- Future secure token/deep-link/push design still requires substantial work.
- Native store policy may reject a low-value wrapper.

### Required controls

- Real-device responsive/PWA matrix during MVP.
- Keep platform capability calls behind interfaces.
- No assumption that browser cookie behavior equals WebView behavior.
- Future threat model for deep links, secure storage, screenshots/backups, certificate/network policy, plugin supply chain, and rooted/jailbroken devices.
- Separate native release/signing/rollback runbook if promoted.

## Validation before acceptance

For the MVP decision, validate compact web/PWA usability and supported-browser behavior. Before any native phase:

- write a product specification and store-distribution rationale;
- prototype authentication/session lifecycle in representative Android/iOS versions;
- test keyboard, safe area, accessibility, back/deep-link, update, and offline launch;
- audit every Capacitor plugin and permission;
- define app signing, secret handling, privacy labels, and support lifecycle.

## Revisit when

- beta evidence shows material demand for store distribution, push, biometric gate, or native integration;
- PWA limitations block critical use;
- store policy or platform architecture changes;
- a separate native client has a justified product/team budget.
