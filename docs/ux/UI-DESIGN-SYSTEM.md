# KFin UI Design System

**Status:** Draft visual proposal — review and contrast validation required<br>
**Version:** 0.1<br>
**Purpose:** Create one accessible, reusable visual and interaction language before feature screens proliferate.

## 1. Brand qualities

KFin should communicate:

- **Trustworthy:** stable layout, restrained color, explicit status, no speculative imagery.
- **Calm:** warm neutral canvas, generous spacing, limited elevation and motion.
- **Clear:** strong type hierarchy, tabular numerals, concise actions.
- **Human:** plain language and supportive empty states without being playful about debt or hardship.
- **Modern:** polished responsive surfaces, not a default framework dashboard.

## 2. Token policy

Components must consume semantic tokens, not scattered raw values. Token changes must be tested for contrast, focus visibility, dark/high-contrast behavior if later supported, screenshots, and regressions. This proposal starts with one light theme; dark mode is not an MVP requirement.

### 2.1 Color palette

#### Brand — deep jade

| Token | Value | Intended use |
|---|---:|---|
| `brand-50` | `#EFFCF8` | Soft selected background |
| `brand-100` | `#D7F5EC` | Informational brand tint |
| `brand-200` | `#AFEAD9` | Decorative border only where contrast allows |
| `brand-300` | `#78D6BE` | Data visualization support |
| `brand-400` | `#3DBA9D` | Accent; not default small text |
| `brand-500` | `#15947B` | Emphasis on dark backgrounds |
| `brand-600` | `#0B7664` | Primary control background candidate |
| `brand-700` | `#095E52` | Primary hover/pressed candidate |
| `brand-800` | `#084B42` | Strong brand text |
| `brand-900` | `#073E37` | Dark surface |
| `brand-950` | `#03251F` | Deepest surface |

#### Neutral — blue slate

| Token | Value |
|---|---:|
| `neutral-0` | `#FFFFFF` |
| `neutral-25` | `#FAFCFB` |
| `neutral-50` | `#F5F8F7` |
| `neutral-100` | `#E9EFED` |
| `neutral-200` | `#D5DFDC` |
| `neutral-300` | `#B5C5C1` |
| `neutral-400` | `#81948F` |
| `neutral-500` | `#60736E` |
| `neutral-600` | `#455854` |
| `neutral-700` | `#32433F` |
| `neutral-800` | `#21312E` |
| `neutral-900` | `#14231F` |
| `neutral-950` | `#0B1512` |

#### Semantic roles

| Semantic token | Proposed value | Requirement |
|---|---:|---|
| `canvas` | `neutral-25` | App background |
| `surface` | `neutral-0` | Primary card/form background |
| `surface-subtle` | `neutral-50` | Grouping, not disabled state |
| `text-primary` | `neutral-900` | Main text |
| `text-secondary` | `neutral-600` | Supporting text; verify at actual size |
| `border` | `neutral-200` | Default boundary |
| `focus` | `#175CD3` | High-visibility focus ring |
| `positive` | `#137A4B` | Confirmed positive status; always paired with text/icon |
| `positive-bg` | `#ECFDF3` | Positive tint |
| `warning` | `#8A4B00` | Due/attention status |
| `warning-bg` | `#FFF7E6` | Warning tint |
| `danger` | `#B42318` | Destructive/overdue/error status |
| `danger-bg` | `#FEF3F2` | Danger tint |
| `info` | `#175CD3` | Informational status |
| `info-bg` | `#EFF8FF` | Informational tint |

Financial meaning must not use color alone. Income uses `+`/`Income`; outflow uses `−`/`Expense`; overdue uses an icon and word. Brand green must not make all financial data appear “positive.”

All foreground/background combinations require automated and manual contrast validation before acceptance; hex values are not a claim of compliance in every combination.

### 2.2 Typography

**Proposed family:** self-hosted Inter Variable with the native system stack as fallback: `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`. If self-hosting/licensing/weight cost is not accepted, use the system stack only.

| Token | Size / line-height | Weight | Use |
|---|---|---:|---|
| `display` | 36 / 44 px | 650 | Rare desktop hero/empty state |
| `heading-1` | 30 / 38 px | 650 | Page title |
| `heading-2` | 24 / 32 px | 650 | Major section |
| `heading-3` | 20 / 28 px | 600 | Card/section title |
| `body-lg` | 18 / 28 px | 400 | Important explanatory copy |
| `body` | 16 / 24 px | 400 | Default text and mobile inputs |
| `body-sm` | 14 / 20 px | 400 | Supporting text |
| `label` | 14 / 20 px | 600 | Form/control labels |
| `caption` | 12 / 16 px | 500 | Metadata; never essential without accessible equivalent |
| `amount-hero` | clamp(32, 8vw, 48) / 1.1 | 650 | Primary balance |
| `amount` | 20 / 28 px | 650 | Card amount |

Rules:

- Use tabular numerals for money, dates in columns, and changing counters.
- Never reduce mobile input text below 16 px, avoiding unwanted browser zoom.
- Do not use all caps for long labels.
- Line length for prose should stay near 45–75 characters.
- Font weight and size must not be the only heading semantics; use proper elements.

### 2.3 Spacing

Base unit: 4 px.

`space-0: 0`, `1: 4`, `2: 8`, `3: 12`, `4: 16`, `5: 20`, `6: 24`, `8: 32`, `10: 40`, `12: 48`, `16: 64`, `20: 80`.

- Compact card padding: 16 px; expanded card padding: 20–24 px.
- Form field vertical gap: 16–20 px.
- Section gap: 24 px compact, 32 px expanded.
- Do not create one-off spacing without adding/reviewing a token.

### 2.4 Radius, border, elevation

| Token | Value | Use |
|---|---:|---|
| `radius-sm` | 8 px | Inputs, compact controls |
| `radius-md` | 12 px | Buttons, banners, small cards |
| `radius-lg` | 16 px | Primary cards/sheets |
| `radius-xl` | 24 px | Large modal/feature surface, sparingly |
| `radius-pill` | 999 px | Chips/status only |
| `border-width` | 1 px | Default |
| `shadow-sm` | `0 1px 2px rgb(11 21 18 / 0.06)` | Raised control |
| `shadow-md` | `0 8px 24px rgb(11 21 18 / 0.10)` | Sheet/dialog |

Prefer borders and spacing to elevation. Never stack multiple heavy shadows.

### 2.5 Motion

- `fast`: 120 ms; `standard`: 180 ms; `slow`: 240 ms.
- Use decelerating motion for entry and accelerating motion for exit.
- Animate opacity/transform, not layout-heavy dimensions, when practical.
- No confetti, looping financial animation, or parallax.
- Under `prefers-reduced-motion`, remove nonessential transition and smooth scrolling.

### 2.6 Layout

- Content max width: 1200 px for dashboard; 720 px for long forms/content; 560 px for authentication.
- Grid gap: 16 px compact, 24 px expanded.
- Page horizontal padding: 16 px compact, 24 px medium, 32 px expanded.
- Mobile bottom navigation and sticky form actions reserve safe-area/keyboard space.

## 3. Iconography and imagery

- Proposed icon set: one tree-shakeable, outline set such as Lucide; default 20 or 24 px with consistent stroke.
- Icons that perform an action have an accessible name; adjacent duplicate text may hide decorative icons.
- Do not mix filled, outline, emoji, and unrelated icon families.
- Status icons never replace labels.
- MVP does not require stock photography or decorative finance illustrations. Purpose-built empty-state illustration may be considered only after core UI review.

## 4. Core components

Each component requires keyboard, pointer, touch, disabled, loading, error, focus-visible, high zoom, and screen-reader behavior before release.

### 4.1 Buttons

Variants:

- **Primary:** one main action per region; brand background.
- **Secondary:** bordered or subtle surface.
- **Tertiary:** text/quiet action.
- **Danger:** reserved for destructive confirmation, never routine navigation.
- **Icon button:** minimum 44 px target and accessible label.

Rules:

- Heights: 48 px standard mobile, 44 px compact desktop; never below target requirements.
- Loading retains width, disables repeated activation, and keeps an accessible verb such as `Saving expense`.
- Disabled controls need a nearby reason when the reason is not obvious; do not rely on low opacity alone.

### 4.2 Inputs

- Persistent label, optional hint, control, and reserved validation message region.
- 48 px minimum touch height; 16 px text on mobile.
- Focus ring: at least 2 px visible outline with offset against both canvas and surface.
- Prefix/suffix for currency is visually clear but not part of the editable amount.
- Password controls support manager/autofill, reveal action, and visible policy.
- OTP may use one semantic input styled as cells; paste and autofill must work.

### 4.3 Selectors

- Use native select on mobile where it improves accessibility and speed.
- Combobox only when search is genuinely needed.
- Segmented controls are limited to small mutually exclusive choices such as Income/Expense.
- Chips are filters or compact status, not generic buttons with hidden state.

### 4.4 Cards

Card variants:

- **Snapshot:** one key value, label, as-of information, optional disclosure.
- **Action:** title, short reason, one clear action.
- **Summary:** grouped totals with drill-down.
- **Entity:** debt/goal/purchase summary.

Cards are not nested more than one level. Entire-card click behavior must not conflict with internal controls and requires visible focus.

### 4.5 Navigation

- Mobile bottom nav has persistent text labels, active indicator, safe-area padding, and no horizontal scroll.
- Desktop sidebar has one active item and collapses only if labels remain discoverable.
- Breadcrumbs are used only for deep settings/detail hierarchy, not every page.
- Back behavior respects browser history and does not discard unsaved data silently.

### 4.6 Dialogs and sheets

- Compact: bottom sheet or full-screen dialog based on form length/keyboard use.
- Expanded: centered dialog for focused confirmation; side panel for contextual detail only when URL/history behavior is correct.
- Destructive confirmation states object, impact, and irreversible aspects.
- Escape/back closes only when safe; pending save cannot vanish without warning.
- Focus is contained/restored and background is inert.

### 4.7 Toasts and inline feedback

- Toasts are supplementary, not the only durable success/error indication.
- Maximum visible queue is limited; duplicate messages coalesce.
- Auto-dismiss only noncritical messages, with enough reading time and pause behavior.
- Errors requiring action remain inline/banner until resolved.

### 4.8 Alerts and banners

Variants: information, success, warning, danger.

- Structure: icon, concise title, explanatory text, action, optional dismiss.
- Financial shortfall warnings include amounts, dates, calculation scope, and drill-down.
- Do not use a danger banner for ordinary negative cash flow unless action is actually urgent.

### 4.9 Progress

- Savings progress has label, current/target text, and bounded visual bar.
- `aria-valuenow/min/max` is supplied when determinate.
- Over-target state shows `Target reached` plus excess; bar does not visually break.
- Loading progress is not represented as savings progress.

### 4.10 Lists and tables

- Activity and Schedule use responsive lists by default.
- Tables are reserved for genuinely comparative desktop data; rows transform into labelled blocks on compact screens.
- Headers remain semantic; sorting state is announced.
- Infinite scrolling is not required. Use explicit pagination or bounded load-more so navigation and footer remain reachable.

### 4.11 Date and amount presentation

- Amounts show ISO currency behavior using `Intl.NumberFormat`; VND example: `4.000.000 ₫` under `vi-VN`.
- Keep sign and currency meaning explicit in accessible text.
- Exact date remains available when relative text is shown.
- User-local calendar date is primary for transaction grouping; UTC timestamp is metadata.

## 5. Reusable financial patterns

### Money value

Contains: semantic label, formatted amount, currency, sign/direction, and optional `as of`. It must handle large values without clipping. An on-screen privacy mask is future scope unless separately promoted.

### Status badge

Allowed labels come from domain state, not arbitrary component text. Badge includes readable text and appropriate semantic description.

### Calculation disclosure

A reusable expandable panel lists formula, included/excluded items, period, as-of time, and a link to source records.

### Occurrence row

Direction icon/text, title, expected amount, date, source, and explicit state; primary action is based on state.

### Goal card

Name, manually reported current/target, current-value as-of date, labelled progress, target date if present, and `Update current amount` action. No decorative chart.

### Sensitive confirmation

Review surface for payment, purchase completion, password/session action, or destructive correction. Shows exact consequence before final action.

## 6. Empty, loading, error, and success patterns

### Empty states

- First-use: title, one-sentence benefit, one primary action, optional learn-more.
- Filtered: state which filters produced no match and offer clear filters.
- Never fill empty dashboards with fake sample financial data unless clearly isolated as a non-persistent educational preview.

### Loading

- Skeletons match eventual geometry and are not animated aggressively.
- Buttons use inline progress; full-page blocking is reserved for initial auth/session resolution.

### Errors

- Form errors use summary + field associations.
- Page errors use retry and a correlation ID for support.
- Security-sensitive not-found/forbidden states share generic copy.

### Success

- Saved records appear in context.
- Security changes use a persistent confirmation screen/banner and optional safe email alert.
- Financial saves do not use gamified celebration.

## 7. Accessibility acceptance checklist per component

- Correct native semantic or documented ARIA pattern.
- Accessible name, role, state, and value.
- Keyboard activation and escape/back behavior.
- Visible focus that is not obscured by sticky content.
- Target size and spacing.
- Contrast in every state.
- 200% zoom and compact viewport.
- Screen-reader announcement for asynchronous change.
- Reduced-motion behavior.
- Automated tests plus manual assistive-technology evidence.

## 8. Component governance

- Components live in one design-system package/folder, not copied per feature.
- Feature modules compose primitives and domain patterns; they do not fork visual twins.
- New token/component requests document the unmet need and accessibility behavior.
- Visual changes require representative compact/expanded snapshots, not only Storybook isolation.
- Deprecated variants include migration guidance and are removed only after all usages migrate.
- The design system version is released with the application; no independent package publication is required for MVP.

## 9. Review work still required

Before acceptance:

1. Validate all color pairings with actual font weights/sizes and UI states.
2. Produce compact and expanded prototypes for Home, Global Add, Schedule, debt payment, and authentication.
3. Complete Vietnamese-first content, typography, date/amount, text-expansion, and line-break review; also test English-ready layout stress strings.
4. Test numeric keyboard and safe-area behavior on representative iOS and Android browsers.
5. Conduct keyboard, screen-reader, zoom, and reduced-motion reviews.
6. Confirm brand marks/logo separately; this document defines interface style, not a final logo.
