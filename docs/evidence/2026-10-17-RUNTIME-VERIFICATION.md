# Runtime verification — 2026-10-17

Re-verification of the production runtime that already exists at `c138933`
(built by `a48862b` … `c138933`). No implementation changed in this pass; this
file records what was executed, so a reader does not have to trust the earlier
report.

Environment: Node v22.22.3, local PostgreSQL 18.6 in a disposable cluster, a
fresh `pnpm install --frozen-lockfile`, artifact rebuilt from `c138933`.

## Commands and results

| Command | Result |
|---|---|
| `pnpm run build` | artifact complete at `apps/api/dist` (commit `c138933ca`): `server.bundle.mjs`, `migrate.bundle.mjs`, `provision-invitation.bundle.mjs`, `migrations/` (11), `web/`, `runtime-package.json`, `BUILD-INFO.json`; **0 occurrences of `tsx`** in the server bundle |
| `pnpm run typecheck` | pass |
| `pnpm run test:unit` | **750 passed**, 0 failed |
| `pnpm run test:integration` | **150 passed** across 13 files |
| `pnpm run smoke:production` | **18/18** — `/health/live`, DB-backed `/health/ready`, HTML entry point, compiled module as `text/javascript`, stylesheet, missing asset `404 text/plain`, SPA fallback, JSON 404 for unknown API route, `401 + no-store`, HSTS, document/API CSP, hardening headers, and both boot refusals |
| `pnpm run verify:production-install` | **pass** — clean directory, `npm install --omit=dev` (6 dependencies, 5.8 s), `tsx` absent and unresolvable, then 18/18 checks against that install |
| `pnpm run smoke:https` | **16/16** through a real TLS-terminating proxy: document + headers, compiled module, same-origin write processed (401, not 403), cross-origin write refused (403), invitation → register (202) → login (200), `__Host-kfin_session` with `HttpOnly; Secure; Path=/` and no `Domain`, authenticated `/auth/me` 200 |

## What this proves and what it does not

Proved: the artifact builds from a clean install, starts with `NODE_ENV=production`
without `tsx` or `tools/dev-server.mjs`, serves the client and the API on one
origin, and behaves correctly behind a TLS proxy.

Not proved here: a container run (the image is built and exercised only in CI —
Docker is unavailable in this sandbox), any managed PostgreSQL or TLS certificate
from a real host, and any deployed environment. No merge, deploy or Supabase
access happened in this pass.
