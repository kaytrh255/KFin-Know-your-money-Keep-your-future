#!/usr/bin/env node
/**
 * Provision the two least-privilege database roles used by SPEC-SEC-01 phase 1.
 *
 *   kfin_migrator  owns the schema objects and runs `db:migrate`
 *   kfin_app       the application: LOGIN, no ownership, no DDL, DML only
 *   kfin_operator  the invitation CLI: LOGIN, no ownership, no table DML until
 *                  migration 0009 grants INSERT on beta_invitations only
 *
 * This is an operator-only step. It needs an owner/admin connection that can
 * create roles and manage the schema; that credential must never be given to
 * the API or to the migration job after this one-time setup.
 *
 * Passwords are optional here and are read from the environment. They are never
 * written to the repository, printed, or included in an error message:
 *
 *   ROLE_ADMIN_DATABASE_URL   required, admin/owner connection
 *   KFIN_APP_PASSWORD         optional, applied with ALTER ROLE
 *   KFIN_MIGRATOR_PASSWORD    optional, applied with ALTER ROLE
 *   KFIN_OPERATOR_PASSWORD    optional, applied with ALTER ROLE
 *   KFIN_DATABASE_SCHEMA      optional, default `public`
 *
 * The migration that follows (0008) refuses to run unless these roles exist and
 * the schema grants below are present.
 *
 * Role membership is removed from all three roles. `NOINHERIT` does NOT stop
 * `SET ROLE`; only the absence of a membership does. A role that is a member of
 * a privileged role can switch to it, so provisioning strips every grant held
 * by these roles and fails if any remain.
 */
import pg from 'pg';

const { Client } = pg;

const ROLE_APP = 'kfin_app';
const ROLE_MIGRATOR = 'kfin_migrator';
const ROLE_OPERATOR = 'kfin_operator';
const ROLE_NAMES = [ROLE_MIGRATOR, ROLE_APP, ROLE_OPERATOR];

const adminUrl = process.env.ROLE_ADMIN_DATABASE_URL?.trim();
if (!adminUrl) {
  console.error('ROLE_ADMIN_DATABASE_URL is required: an owner/admin connection used only for provisioning.');
  process.exit(1);
}

const schema = (process.env.KFIN_DATABASE_SCHEMA ?? 'public').trim();
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
  console.error('KFIN_DATABASE_SCHEMA must be a single unquoted identifier.');
  process.exit(1);
}

const passwords = new Map([
  [ROLE_MIGRATOR, process.env.KFIN_MIGRATOR_PASSWORD ?? ''],
  [ROLE_APP, process.env.KFIN_APP_PASSWORD ?? ''],
  [ROLE_OPERATOR, process.env.KFIN_OPERATOR_PASSWORD ?? ''],
]);

const client = new Client({ connectionString: adminUrl });

function attributeSummary(row) {
  return [
    row.rolcanlogin ? 'LOGIN' : 'NOLOGIN',
    row.rolsuper ? 'SUPERUSER' : 'NOSUPERUSER',
    row.rolcreatedb ? 'CREATEDB' : 'NOCREATEDB',
    row.rolcreaterole ? 'CREATEROLE' : 'NOCREATEROLE',
    row.rolbypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS',
    row.rolinherit ? 'INHERIT' : 'NOINHERIT',
  ].join(' ');
}

async function ensureRole(name) {
  const identifier = client.escapeIdentifier(name);
  const existing = await client.query(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolcanlogin, rolreplication
       FROM pg_roles WHERE rolname = $1`,
    [name],
  );

  if (existing.rowCount === 0) {
    await client.query(
      `CREATE ROLE ${identifier} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`,
    );
  } else {
    const row = existing.rows[0];
    if (row.rolsuper || row.rolbypassrls || row.rolreplication) {
      throw new Error(
        `Role ${name} has SUPERUSER/BYPASSRLS/REPLICATION; a superuser must fix it before provisioning can continue.`,
      );
    }
    const changes = [];
    if (!row.rolcanlogin) changes.push('LOGIN');
    if (row.rolinherit) changes.push('NOINHERIT');
    if (row.rolcreatedb) changes.push('NOCREATEDB');
    if (row.rolcreaterole) changes.push('NOCREATEROLE');
    if (changes.length > 0) {
      await client.query(`ALTER ROLE ${identifier} ${changes.join(' ')}`);
    }
  }

  const password = passwords.get(name) ?? '';
  if (password.length > 0) {
    await client.query(`ALTER ROLE ${identifier} PASSWORD ${client.escapeLiteral(password)}`);
  }
}

try {
  await client.connect();
  const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
  if (typeof database !== 'string' || database.length === 0) {
    throw new Error('Could not determine the current database.');
  }
  const databaseIdentifier = client.escapeIdentifier(database);
  const schemaIdentifier = client.escapeIdentifier(schema);
  const appIdentifier = client.escapeIdentifier(ROLE_APP);
  const migratorIdentifier = client.escapeIdentifier(ROLE_MIGRATOR);
  const operatorIdentifier = client.escapeIdentifier(ROLE_OPERATOR);

  for (const role of ROLE_NAMES) {
    await ensureRole(role);
  }

  // Membership is the only thing that enables SET ROLE, and NOINHERIT does not
  // remove it. Revoke every role granted to a KFin role (in any direction where
  // the KFin role is the member). If the admin connection cannot revoke one,
  // provisioning fails instead of leaving an escalation path in place.
  const memberships = (await client.query(
    `SELECT r.rolname AS role, m.rolname AS member
       FROM pg_auth_members am
       JOIN pg_roles r ON r.oid = am.roleid
       JOIN pg_roles m ON m.oid = am.member
      WHERE m.rolname = ANY($1::text[])
      ORDER BY 1, 2`,
    [ROLE_NAMES],
  )).rows;
  for (const row of memberships) {
    await client.query(
      `REVOKE ${client.escapeIdentifier(row.role)} FROM ${client.escapeIdentifier(row.member)}`,
    );
  }
  const remainingMemberships = (await client.query(
    `SELECT count(*)::int AS count
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
      WHERE m.rolname = ANY($1::text[])`,
    [ROLE_NAMES],
  )).rows[0].count;
  if (remainingMemberships !== 0) {
    throw new Error(`KFin roles still hold ${remainingMemberships} role membership(s); SET ROLE would be possible.`);
  }
  // SET ROLE also follows indirect chains (`app -> bridge -> privileged`), so
  // assert that no role is reachable at all, not just that direct grants are gone.
  const reachable = (await client.query(
    `SELECT r.rolname,
            (SELECT count(*)::int
               FROM pg_roles t
              WHERE t.oid <> r.oid
                AND pg_has_role(r.oid, t.oid, 'MEMBER')) AS reachable
       FROM pg_roles r
      WHERE r.rolname = ANY($1::text[])`,
    [ROLE_NAMES],
  )).rows;
  for (const row of reachable) {
    if (row.reachable !== 0) {
      throw new Error(`${row.rolname} can still SET ROLE into ${row.reachable} role(s) through a chain.`);
    }
  }

  // The application may use the schema but never create objects in it. The
  // migration role owns new objects, so it needs CREATE on the schema (not on
  // the database) and no role-creation rights.
  await client.query(`REVOKE ALL ON SCHEMA ${schemaIdentifier} FROM ${appIdentifier}`);
  await client.query(`GRANT USAGE ON SCHEMA ${schemaIdentifier} TO ${appIdentifier}`);
  await client.query(`GRANT CREATE, USAGE ON SCHEMA ${schemaIdentifier} TO ${migratorIdentifier}`);
  await client.query(`GRANT USAGE ON SCHEMA ${schemaIdentifier} TO ${operatorIdentifier}`);
  await client.query(`REVOKE CREATE ON SCHEMA ${schemaIdentifier} FROM PUBLIC`);

  // Database-level CREATE/TEMP: remove the direct CREATE grant from the app
  // role. CONNECT/TEMP remain through PUBLIC; that is a documented residual in
  // phase 1 (revoking them from PUBLIC could affect platform roles).
  await client.query(`REVOKE CREATE ON DATABASE ${databaseIdentifier} FROM ${appIdentifier}`);
  await client.query(`REVOKE CREATE ON DATABASE ${databaseIdentifier} FROM ${operatorIdentifier}`);

  const roles = await client.query(
    `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolcanlogin
       FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
    [ROLE_NAMES],
  );
  const privileges = await client.query(
    `SELECT r.rolname,
            has_schema_privilege(r.rolname, $1, 'USAGE') AS has_usage,
            has_schema_privilege(r.rolname, $1, 'CREATE') AS has_create
       FROM pg_roles r
      WHERE r.rolname = ANY($2::text[])
      ORDER BY r.rolname`,
    [schema, ROLE_NAMES],
  );

  console.log(`Provisioned roles on database ${database}, schema ${schema}:`);
  for (const row of roles.rows) {
    console.log(`  ${row.rolname}: ${attributeSummary(row)}`);
  }
  for (const row of privileges.rows) {
    console.log(
      `  ${row.rolname}: schema USAGE=${row.has_usage ? 'yes' : 'no'}, CREATE=${row.has_create ? 'yes' : 'no'}`,
    );
  }
  console.log(`  role memberships removed: ${memberships.length}; remaining: ${remainingMemberships}`);
  console.log('Passwords: not printed; set only when the corresponding environment variable was provided.');
} catch (error) {
  console.error(`Role provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
