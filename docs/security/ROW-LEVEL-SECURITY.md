# Row Level Security under the application role

**Status:** implemented in migrations 0009–0011 and `packages/database/src/context.ts`. This
note describes the mechanism and its limits; it is not a release decision and does not close
SPEC-SEC-01.

## 1. What this protects against — and what it does not

RLS here is a **second line of defence against application bugs**. Every tenant statement
runs under `kfin_app`, a dedicated LOGIN role that owns nothing, has no `BYPASSRLS`, holds
no role membership, and holds only the reviewed DML allowlist. A repository query that forgets
`WHERE user_id = $1` still returns only the caller's rows; an insert that names another
owner is rejected by the `WITH CHECK` clause.

It does **not** protect against an attacker who can already execute arbitrary SQL as
`kfin_app`. `kfin.user_id` is an ordinary custom setting: any session using the application
role can set it to another user's id and the policies will follow it. RLS must never be
described as preventing SQL injection, and it does not replace parameterized SQL, input
validation, or the SQL guard. The SQL-injection defence remains the parameterized query
discipline already enforced in CI.

Two further boundaries are deliberate:

- the table owner (`kfin_migrator`, or the platform owner in an existing database) bypasses
  RLS because FORCE ROW LEVEL SECURITY is intentionally **off**. The owner role is never
  used by the API, and `assertApplicationDatabaseRole` refuses to start on it. FORCE would
  also disable the owner-bypass that the five `SECURITY DEFINER` functions rely on.
- `kfin_migrations` and backups are not covered by these policies.

### 1.1 Role membership and `SET ROLE`

`NOINHERIT` does **not** prevent `SET ROLE`. It only stops automatic privilege
inheritance; a role that is a member of another role can still switch to it in a single
statement. Membership, not the `INHERIT` attribute, is the control that matters.

Three independent controls keep the application role from becoming a privileged one:

1. `db:provision-roles` revokes every role granted to `kfin_app`, `kfin_operator` and
   `kfin_migrator`, then fails provisioning if any membership remains.
2. `assertApplicationDatabaseRole` / `assertOperatorDatabaseRole` refuse to start when the
   connected role has any membership, or when `session_user` differs from `current_user`
   (a privileged session that entered the app role with `SET ROLE` could leave it again).
3. `db:verify-app-role` and the integration suites assert the same catalog state against
   the real roles and that `SET ROLE kfin_migrator` / `SET ROLE kfin_operator` are denied
   with SQLSTATE 42501.

## 2. How identity reaches a policy

Every repository unit of work runs inside `withUserContext` (or an equivalent explicit
transaction) which:

1. checks out one connection and opens `BEGIN`;
2. runs `SELECT set_config('kfin.user_id', $1, true)` — transaction-local, so it is cleared
   by `COMMIT`/`ROLLBACK` and cannot leak to the next request on a pooled connection;
3. executes the operation on that same client;
4. commits or rolls back and releases the connection.

`kfin_current_user_id()` reads `current_setting('kfin.user_id', true)` and returns `NULL`
unless the value is a canonical UUID. A missing, empty, or malformed setting matches no row
and fails every `WITH CHECK`; it never widens access.

## 3. Policy matrix

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `users` | own | own id | own | — |
| `password_credentials` | own | own | own | — |
| `sessions` | own | own | own | — |
| `session_tokens` | own session | own session | own session | — |
| `auth_challenges` | own | own | own | — |
| `security_events` | own + user-visible | `user_id IS NULL OR own` | — | — |
| `beta_invitations` | — (function only) | — (operator role only) | — (function only) | — |
| `categories` | global or own | — | — | — |
| `financial_accounts` | own | own | own | — |
| `balance_snapshots` | own | own | own | — |
| `transactions` | own | own | own | — |
| `idempotency_results` | own | own | — | — |
| `scheduled_items` | own | own | — | — |
| `scheduled_occurrences` | own | own | own | — |
| `savings_goals` | own | own | own | — |
| `savings_amount_changes` | own | own | — | — |
| `audit_events` | — | own | — | — |
| `auth_attempt_counters` | **RLS off** | | | |
| `kfin_migrations` | no application privilege; RLS on with no policy | | | |

`financial_current_balances` is a view with `security_invoker = true`, so the caller's
policies apply to the underlying tables and the view can never widen visibility.

### Why `auth_attempt_counters` stays outside RLS

The table has no owner column by design: it holds keyed digests of an email, IP address, or
network and fixed-window counters, and it must be usable before authentication, including
for addresses with no account. A policy keyed on `kfin.user_id` cannot express that, and
inventing one would either break brute-force accounting or create a spoofable bypass.
Residual risk: `kfin_app` can read and delete aggregate counters (digests plus integers) for
all callers. It cannot reverse a digest without the server secret.

## 4. Pre-identity functions

Five functions exist because a read that happens before an owner is known cannot be
expressed as an owner policy, and because the application role must not hold table
privileges on `beta_invitations`:

| Function | Purpose | Returned data |
|---|---|---|
| `kfin_account_lookup(email)` | login and password-reset request | user id, status, verification time — never a hash |
| `kfin_token_lookup(token_digest)` | session authentication | one session/token/user row for the digest |
| `kfin_reset_challenge_lookup(target_digest)` | reset OTP verification | the active reset challenge only |
| `kfin_invitation_lookup(code_digest)` | registration validation | the invitation row for the digest |
| `kfin_consume_invitation(id, user, email, now)` | single-use consumption | boolean; conditional `UPDATE` is the only transition |

All five are `SECURITY DEFINER`, owned by `kfin_migrator`, pinned to
`SET search_path = pg_catalog, <schema>`, contain no dynamic SQL, validate their inputs
(digest length, lowercase email, UUID types), return at most one row, and have
`EXECUTE` revoked from `PUBLIC` and granted only to `kfin_app`. The password hash is read
after the owner context is set, so the login lookup never returns a secret.

Consumption is atomic: the function updates only an `active`, unconsumed, unexpired
invitation whose bound email matches, and returns `NULL`/`false` otherwise. A concurrent or
replayed registration loses the race, rolls back its user row, and receives the generic
invalid-invitation error.

## 5. Operator path

`kfin_operator` is a separate LOGIN role with `USAGE` on the schema, `INSERT` on
`beta_invitations`, and an INSERT policy. It has no SELECT, UPDATE, or DELETE on the table,
so it can mint a code but cannot list, alter, or replay one. The API role has **zero**
`beta_invitations` privileges; registration reaches the table only through the definer
functions. The invitation CLI (`apps/api/tools/provision-invitation.ts`) refuses to run
unless `current_user` is `kfin_operator` and reads `OPERATOR_DATABASE_URL`, never the API
connection.

## 6. Verification

- `packages/database/test/rls-owner-isolation.integration.test.ts` drives the shipped
  migrations under `kfin_app` and `kfin_operator`: catalog shape, policy/privilege
  coverage, missing/malformed context, cross-owner reads and writes by direct SQL and by
  repository, connection reuse A → B, view scoping, `security_events` visibility and insert
  scoping, role membership and `SET ROLE` denial, all pre-login flows, invitation replay and
  concurrent replay, the operator CLI, brute-force counters, and the migration role's owner
  bypass.
- `packages/database/test/least-privilege.integration.test.ts` pins the DML allowlist for
  both deployment paths (fresh database, migrations as `kfin_migrator`; existing database,
  migrations as the object owner).
- `packages/database/test/context.test.ts` covers the wrapper and the startup guards.
- `apps/api/test/journey.integration.test.ts` runs the HTTP journey with the API wired to
  `kfin_app`, so the end-to-end suite exercises RLS rather than the owner connection.
- Mutation checks (drop a policy predicate, skip RLS enablement, make consumption
  non-atomic, over-grant the invitation table, unpin a function's `search_path`, remove
  `security_invoker`) each turn the relevant suite red; all six were killed before this
  note was written.

## 7. Known residuals

1. The setting is role-settable: arbitrary SQL as `kfin_app` can impersonate any owner.
   Accepted for this phase; true isolation against that attacker needs per-user database
   roles or an external policy proxy, neither of which is in scope.
2. The owner/migration role bypasses RLS (no FORCE). Enforced by the startup guard, CI
   verification, and code review rather than by the database.
3. `auth_attempt_counters` is global (see §3).
4. `security_events` has two distinct properties that must not be conflated:

   - the INSERT policy is `user_id IS NULL OR user_id = kfin_current_user_id()`. The app
     cannot name a different owner in a normal statement, and a NULL owner is accepted for
     pre-identity failures. The SELECT policy returns only rows whose `user_id` is the
     current context and whose `visibility` is `user` or `both`; operator-only rows stay
     invisible. There is no UPDATE or DELETE privilege, so app-recorded events are
     append-only.
   - an attacker who can already execute arbitrary SQL as `kfin_app` can set `kfin.user_id`
     to another user and then insert as that user. That is residual 1 (the setting is
     role-settable), not a weakness in the INSERT policy. The two cases are not equivalent:
     the policy stops an application bug, it does not stop arbitrary SQL under the role.
5. RLS does not cover backups, replicas, or any other role the operator configures outside
   this repository.
6. Membership is re-checked at startup and in CI, but a superuser can silently add a
   membership to `kfin_app` between deploys. The verifier and the startup guard catch it at
   the next run; prevention depends on keeping the admin credential out of normal operation.
