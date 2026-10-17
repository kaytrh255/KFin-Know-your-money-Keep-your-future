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

interface RoleRow {
  role: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  owned_relations: string;
  owned_schemas: string;
}

/**
 * Startup guard: refuses to serve traffic unless the pool is the dedicated,
 * non-owner, non-BYPASSRLS application role.
 *
 * This is deliberately an explicit query at startup rather than a check on a
 * URL string: the role is whatever PostgreSQL reports for `current_user`, and
 * a pooled/via-proxy connection may rewrite the URL without changing the role.
 */
export async function assertApplicationDatabaseRole(pool: Queryable): Promise<void> {
  const result = await pool.query<RoleRow>(`
    SELECT r.rolname AS role,
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
           ) AS owned_schemas
      FROM pg_roles r
     WHERE r.rolname = current_user
  `);
  const row = result.rows[0];
  if (!row) {
    throw new DatabaseRoleError('The application role could not be resolved.');
  }
  const problems: string[] = [];
  if (row.role !== APPLICATION_DATABASE_ROLE) {
    problems.push(`connected as ${row.role}, expected ${APPLICATION_DATABASE_ROLE}`);
  }
  if (row.rolsuper) problems.push('role is SUPERUSER');
  if (row.rolbypassrls) problems.push('role has BYPASSRLS');
  if (row.rolcreatedb) problems.push('role has CREATEDB');
  if (row.rolcreaterole) problems.push('role has CREATEROLE');
  if (Number(row.owned_relations) > 0) problems.push(`role owns ${row.owned_relations} relation(s)`);
  if (Number(row.owned_schemas) > 0) problems.push(`role owns ${row.owned_schemas} schema(s)`);
  if (problems.length > 0) {
    throw new DatabaseRoleError(`Refusing to start: ${problems.join('; ')}.`);
  }
}
