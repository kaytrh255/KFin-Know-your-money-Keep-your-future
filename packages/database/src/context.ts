import type { Pool, PoolClient } from 'pg';

/**
 * Transaction-local owner context (SPEC-SEC-01 phase 2).
 *
 * Row Level Security policies read `current_setting('kfin.user_id', true)`.
 * `set_config(..., true)` is transaction-local, so the value disappears on the
 * next `COMMIT`/`ROLLBACK` and a pooled connection can never leak one request's
 * owner into the next. Policies treat a missing or empty setting as `NULL`,
 * which matches no row and fails every `WITH CHECK`.
 *
 * SECURITY NOTE: the value is set by the application role itself. It is a
 * guardrail against application bugs that forget an owner predicate, NOT a
 * defence against an attacker who can already execute arbitrary SQL as
 * `kfin_app`: such an attacker can set the same setting. RLS here must never be
 * described as preventing SQL injection.
 */
export const USER_CONTEXT_SETTING = 'kfin.user_id';

/** The only role the API may run as. Provisioned by `db:provision-roles`. */
export const APPLICATION_DATABASE_ROLE = 'kfin_app';
/** The invitation CLI role: INSERT on beta_invitations only, never the API. */
export const OPERATOR_DATABASE_ROLE = 'kfin_operator';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DatabaseRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseRoleError';
  }
}

export type Connectable = Pick<Pool, 'connect'>;
export type Queryable = Pick<Pool, 'query'>;

export function assertUserId(value: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DatabaseRoleError('The owner context requires a canonical UUID user id.');
  }
  return value;
}

/**
 * Applies the transaction-local owner context to an already-open transaction.
 * Callers that opened `BEGIN` themselves (they need bespoke deadline or retry
 * handling) use this instead of the wrappers below.
 */
export async function applyUserContext(
  client: Pick<PoolClient, 'query'>,
  userId: string,
): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', [USER_CONTEXT_SETTING, assertUserId(userId)]);
}

/**
 * Runs one unit of work in a transaction whose owner context is set before any
 * statement the operation executes. Always releases the connection, always
 * rolls back on failure, and never leaves the setting behind.
 */
export async function withUserContext<T>(
  pool: Connectable,
  userId: string | null,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    if (userId !== null) await applyUserContext(client, userId);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The failure being reported is authoritative; rollback noise is not.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Catalog snapshot for one role. `reachable_roles` counts every role the role
 * can `SET ROLE` into, directly or through a chain: PostgreSQL role membership
 * is transitive for `SET ROLE`, so counting only direct grants would miss
 * `kfin_app -> bridge -> privileged`.
 */
export interface DatabaseRoleSnapshot {
  readonly role: string;
  readonly sessionRole: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  readonly createDb: boolean;
  readonly createRole: boolean;
  readonly ownedRelations: string;
  readonly ownedSchemas: string;
  readonly reachableRoles: string;
}

/**
 * Startup guard: refuses to serve traffic unless the pool is the dedicated,
 * non-owner, non-BYPASSRLS application role.
 *
 * This is deliberately an explicit query at startup rather than a check on a
 * URL string: the role is whatever PostgreSQL reports for `current_user`, and
 * a pooled/via-proxy connection may rewrite the URL without changing the role.
 *
 * Membership is checked explicitly. `NOINHERIT` only stops automatic privilege
 * inheritance; it does NOT stop `SET ROLE`, and PostgreSQL membership is
 * transitive for `SET ROLE`: `app -> bridge -> privileged` is enough. The guard
 * therefore counts every role reachable through the membership graph and
 * refuses if there is even one. `session_user = current_user` additionally
 * rejects a privileged session that merely entered the app role with
 * `SET ROLE` and could leave it again.
 */
async function loadDatabaseRoleSnapshot(
  pool: Queryable,
  roleName?: string,
): Promise<DatabaseRoleSnapshot | null> {
  const result = await pool.query<{
    role: string;
    session_role: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    owned_relations: string;
    owned_schemas: string;
    reachable_roles: string;
  }>(`
    SELECT r.rolname AS role,
           session_user::text AS session_role,
           r.rolsuper,
           r.rolbypassrls,
           r.rolcreatedb,
           r.rolcreaterole,
           (
             SELECT count(*)::text
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relowner = r.oid
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                AND n.nspname NOT LIKE 'pg\\_toast%'
                AND n.nspname NOT LIKE 'pg\\_temp%'
           ) AS owned_relations,
           (
             SELECT count(*)::text
               FROM pg_namespace n
              WHERE n.nspowner = r.oid
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                AND n.nspname NOT LIKE 'pg\\_toast%'
                AND n.nspname NOT LIKE 'pg\\_temp%'
           ) AS owned_schemas,
           (
             SELECT count(*)::text
               FROM pg_roles target
              WHERE target.oid <> r.oid
                AND pg_has_role(r.oid, target.oid, 'MEMBER')
           ) AS reachable_roles
      FROM pg_roles r
     WHERE r.rolname = COALESCE($1::text, current_user)
  `, [roleName ?? null]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    role: row.role,
    sessionRole: row.session_role,
    superuser: row.rolsuper,
    bypassRls: row.rolbypassrls,
    createDb: row.rolcreatedb,
    createRole: row.rolcreaterole,
    ownedRelations: row.owned_relations,
    ownedSchemas: row.owned_schemas,
    reachableRoles: row.reachable_roles,
  };
}

/**
 * Loads the catalog snapshot for the current role, or for `roleName` when an
 * operator check wants to inspect a role without connecting as it.
 */
export async function inspectDatabaseRole(
  pool: Queryable,
  roleName?: string,
): Promise<DatabaseRoleSnapshot | null> {
  return loadDatabaseRoleSnapshot(pool, roleName);
}

async function assertDatabaseRole(
  pool: Queryable,
  expectedRole: string,
  failurePrefix: string,
): Promise<void> {
  const row = await loadDatabaseRoleSnapshot(pool);
  if (!row) {
    throw new DatabaseRoleError('The application role could not be resolved.');
  }
  const problems: string[] = [];
  if (row.role !== expectedRole) {
    problems.push(`connected as ${row.role}, expected ${expectedRole}`);
  }
  if (row.sessionRole !== expectedRole) {
    problems.push(`session user is ${row.sessionRole}, so ${row.role} was entered with SET ROLE`);
  }
  if (Number(row.reachableRoles) > 0) {
    problems.push(`role can SET ROLE into ${row.reachableRoles} other role(s); membership is transitive`);
  }
  if (row.superuser) problems.push('role is SUPERUSER');
  if (row.bypassRls) problems.push('role has BYPASSRLS');
  if (row.createDb) problems.push('role has CREATEDB');
  if (row.createRole) problems.push('role has CREATEROLE');
  if (Number(row.ownedRelations) > 0) problems.push(`role owns ${row.ownedRelations} relation(s)`);
  if (Number(row.ownedSchemas) > 0) problems.push(`role owns ${row.ownedSchemas} schema(s)`);
  if (problems.length > 0) {
    throw new DatabaseRoleError(`${failurePrefix}: ${problems.join('; ')}.`);
  }
}

export async function assertApplicationDatabaseRole(pool: Queryable): Promise<void> {
  await assertDatabaseRole(pool, APPLICATION_DATABASE_ROLE, 'Refusing to start');
}

/**
 * The operator CLI must never run as the API role or an owner. It may be
 * `kfin_operator` only; the invitation INSERT is granted to that role alone.
 */
export async function assertOperatorDatabaseRole(pool: Queryable): Promise<void> {
  await assertDatabaseRole(pool, OPERATOR_DATABASE_ROLE, 'Refusing to run');
}
