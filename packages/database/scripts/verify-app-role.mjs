#!/usr/bin/env node
/**
 * Smoke-check the application role after `db:provision-roles` + `db:migrate`.
 *
 * This is the operator-facing check; the full table-by-table allowlist is
 * pinned by `packages/database/test/least-privilege.integration.test.ts`.
 * It connects with `DATABASE_URL` (the application role), never with the admin
 * or migration role, and prints no connection string or secret.
 *
 * It also checks role membership: `NOINHERIT` does not prevent `SET ROLE`, so a
 * membership in a privileged role is an escalation even when inheritance is off.
 *
 * Required:
 *   DATABASE_URL           application connection (kfin_app)
 * Optional:
 *   KFIN_DATABASE_SCHEMA   default `public`
 */
import pg from 'pg';

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error('DATABASE_URL is required: an application-role connection.');
  process.exit(1);
}

const schema = (process.env.KFIN_DATABASE_SCHEMA ?? 'public').trim();
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
  console.error('KFIN_DATABASE_SCHEMA must be a single unquoted identifier.');
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });
const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

async function expectInsufficientPrivilege(sql, label) {
  checks += 1;
  try {
    await client.query(sql);
    failures.push(`${label}: unexpectedly succeeded`);
  } catch (error) {
    if (error && error.code !== '42501') {
      failures.push(`${label}: expected SQLSTATE 42501, got ${error?.code ?? 'unknown'}`);
    }
  } finally {
    // A SET ROLE that unexpectedly succeeded must not turn later checks into
    // migrator-privileged statements.
    await client.query('RESET ROLE').catch(() => undefined);
  }
}

try {
  await client.connect();
  const identity = (await client.query(`
    SELECT current_user AS role, current_database() AS database,
           session_user::text AS session_role,
           r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolinherit, r.rolcanlogin
      FROM pg_roles r WHERE r.rolname = current_user
  `)).rows[0];
  // SET ROLE is allowed for direct *and* chained membership, so count every
  // role reachable through the membership graph, not just direct grants.
  const reachable = (await client.query(`
    SELECT count(*)::int AS count
      FROM pg_roles target
     WHERE target.oid <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND pg_has_role(current_user, target.oid, 'MEMBER')
  `)).rows[0];
  check(reachable.count === 0, `kfin_app can SET ROLE into ${reachable.count} role(s) directly or via a chain`);

  check(identity.role === 'kfin_app', `connected as ${identity.role}, expected kfin_app`);
  check(identity.session_role === 'kfin_app', `session user is ${identity.session_role}; kfin_app was entered with SET ROLE`);
  check(identity.rolsuper === false, 'role must not be SUPERUSER');
  check(identity.rolcreatedb === false, 'role must not have CREATEDB');
  check(identity.rolcreaterole === false, 'role must not have CREATEROLE');
  check(identity.rolbypassrls === false, 'role must not have BYPASSRLS');
  check(identity.rolinherit === false, 'role must be NOINHERIT');
  check(identity.rolcanlogin === true, 'role must be LOGIN');

  const schemaId = client.escapeIdentifier(schema);
  const schemaPrivileges = (await client.query(`
    SELECT has_schema_privilege(current_user, $1::text, 'USAGE') AS usage,
           has_schema_privilege(current_user, $1::text, 'CREATE') AS create
  `, [schema])).rows[0];
  check(schemaPrivileges.usage === true, `role lacks USAGE on schema ${schema}`);
  check(schemaPrivileges.create === false, `role has CREATE on schema ${schema}`);

  const databaseConnect = (await client.query(
    `SELECT has_database_privilege(current_user, current_database(), 'CONNECT') AS connect`,
  )).rows[0].connect;
  check(databaseConnect === true, 'role cannot CONNECT to the database');

  const relations = (await client.query(`
    SELECT c.relname, c.relkind, c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned,
           has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate,
           has_table_privilege(current_user, c.oid, 'REFERENCES') AS can_reference,
           has_table_privilege(current_user, c.oid, 'TRIGGER') AS can_trigger
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1::text AND c.relkind IN ('r', 'p', 'v')
     ORDER BY c.relname
  `, [schema])).rows;

  check(relations.length >= 19, `schema ${schema} has ${relations.length} relations; migrations may be missing`);
  for (const relation of relations) {
    check(relation.owned === false, `${relation.relname}: owned by the application role`);
    check(relation.can_truncate === false, `${relation.relname}: TRUNCATE granted`);
    check(relation.can_reference === false, `${relation.relname}: REFERENCES granted`);
    check(relation.can_trigger === false, `${relation.relname}: TRIGGER granted`);
  }

  const migrationsTable = relations.find((relation) => relation.relname === 'kfin_migrations');
  check(Boolean(migrationsTable), 'kfin_migrations is missing; run db:migrate');
  const migrationsPrivileges = (await client.query(`
    SELECT has_table_privilege(current_user, format('%I.%I', $1::text, 'kfin_migrations')::regclass, 'SELECT') AS sel,
           has_table_privilege(current_user, format('%I.%I', $1::text, 'kfin_migrations')::regclass, 'INSERT') AS ins,
           has_table_privilege(current_user, format('%I.%I', $1::text, 'kfin_migrations')::regclass, 'UPDATE') AS upd,
           has_table_privilege(current_user, format('%I.%I', $1::text, 'kfin_migrations')::regclass, 'DELETE') AS del
  `, [schema])).rows[0];
  for (const [operation, granted] of Object.entries(migrationsPrivileges)) {
    check(granted === false, `kfin_migrations: ${operation.toUpperCase()} granted to the application role`);
  }

  const exposedFunctions = (await client.query(`
    SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1::text
       AND p.proname LIKE 'kfin\\_%'
       AND (
         p.proacl IS NULL
         OR EXISTS (
           SELECT 1 FROM aclexplode(p.proacl) a
            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
         )
       )
  `, [schema])).rows;
  check(exposedFunctions.length === 0, `PUBLIC EXECUTE on KFin functions: ${exposedFunctions.map((row) => row.proname).join(', ')}`);

  const notExecutableFunctions = (await client.query(`
    SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1::text
       AND p.proname LIKE 'kfin\\_%'
       AND NOT has_function_privilege(current_user, p.oid, 'EXECUTE')
  `, [schema])).rows;
  check(notExecutableFunctions.length === 0, `application role cannot EXECUTE: ${notExecutableFunctions.map((row) => row.proname).join(', ')}`);

  // SPEC-SEC-01 phase 2: RLS must be on for every tenant table and the view must
  // stay security_invoker. `auth_attempt_counters` is deliberately global.
  const rlsTables = (await client.query(`
    SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1::text
       AND c.relkind = 'r'
       AND c.relname <> 'kfin_migrations'
  `, [schema])).rows;
  const rlsOn = new Set(rlsTables.filter((row) => row.relrowsecurity).map((row) => row.relname));
  const expectedRls = [
    'users', 'password_credentials', 'sessions', 'session_tokens', 'auth_challenges',
    'security_events', 'beta_invitations', 'categories', 'financial_accounts',
    'balance_snapshots', 'transactions', 'idempotency_results', 'scheduled_items',
    'scheduled_occurrences', 'savings_goals', 'savings_amount_changes', 'audit_events',
  ];
  for (const table of expectedRls) check(rlsOn.has(table), `RLS is not enabled on ${table}`);
  check(!rlsOn.has('auth_attempt_counters'), 'RLS must stay off on auth_attempt_counters');

  const policyCoverage = (await client.query(`
    SELECT c.relname, count(p.polname)::int AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
     WHERE n.nspname = $1::text
       AND c.relkind = 'r'
       AND c.relname = ANY($2::text[])
     GROUP BY c.relname
  `, [schema, expectedRls])).rows;
  for (const row of policyCoverage) check(row.policies > 0, `${row.relname}: RLS enabled with no policy`);

  const viewOptions = (await client.query(`
    SELECT c.reloptions
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1::text AND c.relname = 'financial_current_balances'
  `, [schema])).rows[0]?.reloptions ?? [];
  check(viewOptions.includes('security_invoker=true'), 'financial_current_balances is not security_invoker');

  const definerFunctions = (await client.query(`
    SELECT p.proname, p.prosecdef, p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1::text
       AND p.proname = ANY($2::text[])
  `, [schema, [
    'kfin_account_lookup', 'kfin_token_lookup', 'kfin_reset_challenge_lookup',
    'kfin_invitation_lookup', 'kfin_consume_invitation',
  ]])).rows;
  check(definerFunctions.length === 5, `expected 5 SECURITY DEFINER functions, found ${definerFunctions.length}`);
  for (const row of definerFunctions) {
    check(row.prosecdef === true, `${row.proname}: not SECURITY DEFINER`);
    const pinned = (row.proconfig ?? []).some((entry) => entry.startsWith('search_path=pg_catalog, '));
    check(pinned, `${row.proname}: search_path is not pinned to pg_catalog + schema`);
  }

  for (const table of ['users', 'transactions', 'financial_accounts', 'financial_current_balances']) {
    const result = await client.query(`SELECT count(*)::int AS rows FROM ${schemaId}.${client.escapeIdentifier(table)}`);
    check(Number.isInteger(result.rows[0].rows), `${table}: SELECT failed`);
  }

  await expectInsufficientPrivilege(`SELECT count(*) FROM ${schemaId}.kfin_migrations`, 'read kfin_migrations');
  await expectInsufficientPrivilege('SET ROLE kfin_migrator', 'SET ROLE kfin_migrator');
  await expectInsufficientPrivilege('SET ROLE kfin_operator', 'SET ROLE kfin_operator');
  await expectInsufficientPrivilege(`SELECT count(*) FROM ${schemaId}.beta_invitations`, 'read beta_invitations');
  await expectInsufficientPrivilege(`INSERT INTO ${schemaId}.beta_invitations (id) VALUES (gen_random_uuid())`, 'insert beta_invitations');
  await expectInsufficientPrivilege(`CREATE TABLE ${schemaId}.kfin_privilege_probe (id integer)`, 'CREATE TABLE');
  await expectInsufficientPrivilege(`TRUNCATE ${schemaId}.transactions`, 'TRUNCATE transactions');
  await expectInsufficientPrivilege(`ALTER TABLE ${schemaId}.transactions ADD COLUMN kfin_privilege_probe integer`, 'ALTER TABLE transactions');

  if (failures.length > 0) {
    console.error(`Least-privilege check FAILED (${failures.length}/${checks}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`Least-privilege check PASSED (${checks} checks) for role ${identity.role} on schema ${schema}.`);
  }
} catch (error) {
  console.error(`Least-privilege check failed to run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
