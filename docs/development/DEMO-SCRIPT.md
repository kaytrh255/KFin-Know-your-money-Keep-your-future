# KFin demo script (verified 2026-10-12)

A scripted walkthrough of everything KFin currently does, in the order a beta user experiences it, with
the exact commands and the exact outcomes observed on 2026-10-12. Every value in the "expected" columns
below came from a real run against a live API and a real PostgreSQL database; the transcript is recorded
in [`docs/evidence/2026-10-12-JOURNEY-AND-DEMO-VERIFICATION.md`](../evidence/2026-10-12-JOURNEY-AND-DEMO-VERIFICATION.md).

**What this demo is.** The implemented product: invitation-gated registration, sign-in, one aggregate
money account, manual balance snapshots, expenses and income, append-only corrections and voiding,
one-off scheduled occurrences with explicit confirmation, savings goals, and monthly actuals.

**What it is not.** A blueprint of the finished MVP. Safe-to-spend, debt, in-app reminders, recurring
patterns, planned purchases and account deletion are **not implemented**; the traceability matrix lists
each one and why ([`docs/implementation/REQUIREMENTS-TRACEABILITY-MATRIX.md`](../implementation/REQUIREMENTS-TRACEABILITY-MATRIX.md)).
No release is authorized: several owner approvals are still unsigned.

## 1. Prerequisites

| Requirement | Version used for the verified run |
|---|---|
| Node.js | 22.22.3 (the workflow pins 22.22.0) |
| pnpm | 10.34.6, through Corepack (from `packageManager`) |
| PostgreSQL | 17.6, disposable and local |
| `jq`, `curl` | any recent version |

Integrity rule for this demo: **never point it at a database that holds data you care about.** It
creates an account, writes rows, and the reset step revokes sessions. Step 2 creates a throwaway
database for exactly that reason.

## 2. Disposable database and migrations

```bash
# create a throwaway database (any local PostgreSQL will do)
psql "postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable" \
  -c 'DROP DATABASE IF EXISTS kfin_demo WITH (FORCE)' -c 'CREATE DATABASE kfin_demo'

cd /path/to/KFin-Know-your-money-Keep-your-future
corepack pnpm install --frozen-lockfile

export MIGRATION_DATABASE_URL="postgres://postgres@127.0.0.1:5432/kfin_demo?sslmode=disable"
export DATABASE_SSL_MODE=disable
corepack pnpm run db:migrate          # applies 0001 … 0007 in order
```

Expected: the migration command exits 0 and `kfin_migrations` holds seven rows. Migrations are
forward-only; the run creates them from scratch rather than mutating an existing schema.

## 3. Environment and the API

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5432/kfin_demo?sslmode=disable"
export AUTH_SECRET="$(openssl rand -hex 32)"                    # 64 hex chars
export FINANCIAL_PREVIEW_SIGNING_KEY="$(openssl rand -hex 32)"  # 64 hex chars, checked at boot
export IDEMPOTENCY_RETENTION_HOURS=24
export NODE_ENV=development HOST=127.0.0.1 PORT=3114
export AUTH_COOKIE_SECURE=false EMAIL_DELIVERY_ADAPTER=memory

# free the port first: a stale listener running with a DIFFERENT AUTH_SECRET would
# answer every call with plausible-looking errors (learned the hard way on 2026-10-12)
pkill -f 'apps/api/src/server.ts' || true

npx tsx apps/api/src/server.ts &        # or: corepack pnpm run api:dev
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3114/health/ready   # → 200
```

If the log contains `EADDRINUSE`, the run is invalid — stop and clear the port. Two API processes
sharing a port but not a secret produce `AUTH_INVITATION_INVALID` for perfectly good codes.

## 4. Invitation (the operator channel)

There is deliberately **no HTTP route that mints invitations** (DATABASE §4.2, SEC-AUTH-14). The
operator path is a script that calls the same repository method production uses:

```bash
corepack pnpm run invite:provision -- --email demo.user@example.invalid
```

Expected: the code is printed **once** (`XXXX-XXXX-XXXX-XXXX`), and the database stores only a keyed
digest. Capture it for step 5; it cannot be read back.

## 5. The journey

The client is browser-based; these `curl` calls reproduce the same requests it makes. Writes require
three things, and each is a deliberate control rather than a formality:

- the session cookie,
- the `x-kfin-csrf` header echoed from the sign-in response (double-submit CSRF),
- an `idempotency-key` **request header** on every state-changing write.

```bash
BASE=http://127.0.0.1:3114
ORIGIN=$BASE                      # isBrowserSafeRequest requires Origin to match Host
JAR=/tmp/kfin-demo-cookies.txt
CODE='<the code from step 4>'
```

| # | Action | Expected outcome (verified) |
|---|---|---|
| 1 | `POST /api/v1/auth/register` with the invitation code, `locale=vi`, `timezone=Asia/Ho_Chi_Minh`, `baseCurrency=VND` | `202 {"accepted":true}`. No email is sent, no OTP is issued, no session is created; the account is `active` and `unverified`. |
| 2 | `POST /api/v1/auth/login` (cookie jar) | `200` with `userId`, `session.id`, `csrfToken`; two cookies (`kfin_session`, `kfin_csrf`). |
| 3 | `POST /api/v1/financial-account` header `idempotency-key`, body `{"openingBalanceMinor":"5000000","effectiveAt":"2026-10-01T00:00:00.000Z"}` | `201` with `accountId`, `snapshotId`, `financialStateVersion:"1"`. |
| 4 | `GET /api/v1/financial-account` | balance `5000000`, snapshot id matching step 3. |
| 5 | `POST /api/v1/transactions` (`expense`, `250000`, `food`, `essential_variable`, with the **current** `expectedFinancialStateVersion` + `reviewedLatestSnapshotId`) | `201`; then the balance is `4750000` and `postedCurrentExpenseMinor` is `250000`. |
| 6 | Repeat step 5 with the *same* `idempotency-key` | Same result, **one** row: an idempotent replay is not a second expense. |
| 7 | Repeat step 5 with a **stale** `expectedFinancialStateVersion` | `409` — the write is refused rather than applied twice. |
| 8 | `POST /transactions/{id}/correction-preview` (replacement `310000`) | `200` with `currentBalance.beforeMinor=4750000` → `afterMinor=4690000`, plus a `context` object. |
| 9 | `POST /transactions/{id}/corrections` echoing that `context` verbatim | `201`; balance `4690000`. The source row keeps `250000` and becomes `voided`; the replacement names it through `supersedes_transaction_id`. |
| 10 | Create a second expense (`42000`, `transportation`), then `void-preview` → `void` | `200`; balance returns to `4690000`, and the reports consequence lists the removed `transportation` group. |
| 11 | `POST /schedule/one-off` (electricity, `480000`, due `2026-10-20`) | `201`; `GET /schedule/occurrences?state=scheduled` shows it as `scheduled`/`upcoming`, and **the balance has not moved**. |
| 12 | `POST /schedule/occurrences/{id}/confirm` (`487500`, `occurredOn` = today) | `201`; balance `4690000 → 4202500`; the occurrence is `confirmed` with `confirmed_transaction_id` set. |
| 13 | `POST /savings-goals`, then `POST /savings-goals/{id}/current-amount` | `201` then `200`; `version` `1 → 2` with two amount-change rows, and the account balance **and** financial state version are unchanged. |
| 14 | `GET /reports/monthly-actuals?month=2026-10` | `expenseMinor=797500` = `310000` (corrected food) + `487500` (confirmed electricity); `transportation` reports `0` because it was voided. |
| 15 | `GET /api/v1/auth/security-events` | `login_succeeded`, `registration_requested` — operator-only events are absent by design. |

Two boundaries worth demonstrating on purpose, because they are the point of the design:

- **Cross-owner isolation.** Register a second invited person, then read the first person's
  transaction/goal/account with the second person's cookie: `404` (never `200`), and the second person's
  transaction list is empty.
- **Password reset.** `POST /auth/password/reset-request` (always `200 {"accepted":true}`), read the
  code from the delivery adapter, `POST /auth/password/reset`: every session is revoked, the old cookie
  answers `401`, and the code cannot be replayed.

## 6. What to do with a failure

1. Check the API log for `EADDRINUSE` or a boot-time config error first — a mis-started process produces
   convincing-looking domain errors.
2. `REQUEST_VALIDATION_FAILED` names the offending field; the response never contains the submitted
   value.
3. `409` on a write means your reviewed version is stale: re-read the balance and retry with fresh
   values. That is the concurrency contract, not a bug.

## 7. Known limitations of this demo

| Limitation | Why |
|---|---|
| No browser was driven | The client is verified by `web:build` and DOM-level unit tests; a browser E2E runtime is not available in this environment. Treat UI claims as build-verified, not interaction-verified. |
| Email delivery is an adapter | `EMAIL_DELIVERY_ADAPTER=memory` records the OTP in-process. No SMTP/provider integration exists, and none is authorized yet (OQ-17 open). |
| Rate limits are real | Reset-request is capped at 10 per 15-minute window per network prefix. A repeated demo can hit `429`; that is the shipped policy, not a defect — and F-3 is the open finding about it. |
| Not a release | Sign-in works, but the specification it implements is unratified, and several owner decisions are unsigned. See the traceability matrix §9. |
