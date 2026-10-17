-- 0008_least_privilege_app_role.sql
--
-- SPEC-SEC-01 phase 1 (least privilege). The application connects as
-- `kfin_app`: it owns nothing, cannot create or alter objects, cannot
-- TRUNCATE, and receives only the table/sequence/function privileges that the
-- runtime queries in packages/database/src actually use. Migrations run as a
-- different role that owns the objects: `kfin_migrator` on a fresh database, or
-- the existing platform owner on a database that already has the schema.
--
-- Roles and schema-level privileges are provisioned outside this file by
-- `pnpm db:provision-roles`; passwords never live in a migration. This
-- migration only asserts that the roles and schema grants are in place and then
-- applies the table-level allowlist.
--
-- This file intentionally does NOT enable Row Level Security. RLS is phase 2 of
-- SPEC-SEC-01 and needs the request-context plumbing first.

DO $$
DECLARE
  app_role constant text := 'kfin_app';
  migrator_role constant text := 'kfin_migrator';
  schema_name text := current_schema();
  app_oid oid;
  entry record;
BEGIN
  IF schema_name IS NULL THEN
    RAISE EXCEPTION '0008: current_schema() is null; set search_path to the KFin schema';
  END IF;

  SELECT oid INTO app_oid FROM pg_roles WHERE rolname = app_role;
  IF app_oid IS NULL THEN
    RAISE EXCEPTION '0008: role % does not exist; run `pnpm db:provision-roles` first', app_role;
  END IF;

  IF current_user = app_role THEN
    RAISE EXCEPTION '0008: migrations must never run as the application role %', app_role;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE oid = app_oid
      AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit)
  ) THEN
    RAISE EXCEPTION '0008: role % must be LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT', app_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = app_oid) THEN
    RAISE EXCEPTION '0008: role % must not be a member of any other role', app_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = schema_name AND nspowner = app_oid) THEN
    RAISE EXCEPTION '0008: role % must not own schema %', app_role, schema_name;
  END IF;

  -- On a schema this role owns (or as a superuser), make the schema-level
  -- grants deterministic. A non-owner migration role relies on
  -- `db:provision-roles` having done this already.
  IF EXISTS (
    SELECT 1 FROM pg_namespace n
    WHERE n.nspname = schema_name
      AND (
        n.nspowner = current_user::regrole
        OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user AND r.rolsuper)
      )
  ) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, app_role);
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', schema_name);
  END IF;

  IF NOT has_schema_privilege(app_role, schema_name, 'USAGE') THEN
    RAISE EXCEPTION '0008: role % lacks USAGE on schema %; grant it as the schema owner', app_role, schema_name;
  END IF;

  IF has_schema_privilege(app_role, schema_name, 'CREATE') THEN
    RAISE EXCEPTION '0008: role % must not have CREATE on schema %', app_role, schema_name;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_namespace n,
         aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
    WHERE n.nspname = schema_name
      AND a.grantee = 0
      AND a.privilege_type = 'CREATE'
  ) THEN
    RAISE EXCEPTION '0008: PUBLIC still has CREATE on schema %; revoke it as the schema owner', schema_name;
  END IF;

  -- Every relation and KFin function must already be owned by the role running
  -- this migration. That makes the GRANT/REVOKE statements legal and keeps the
  -- application role from becoming an owner by accident.
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    WHERE c.relnamespace = schema_name::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'S', 'm', 'f')
      AND c.relowner <> current_user::regrole
  ) THEN
    RAISE EXCEPTION '0008: run this migration as the owner of every relation in schema %', schema_name;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.pronamespace = schema_name::regnamespace
      AND p.proname LIKE 'kfin\_%'
      AND p.proowner <> current_user::regrole
  ) THEN
    RAISE EXCEPTION '0008: run this migration as the owner of every kfin_* function in schema %', schema_name;
  END IF;

  IF current_user = migrator_role AND EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = current_user
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION '0008: migration role % has unsafe attributes', migrator_role;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = current_user AND rolsuper
  ) THEN
    RAISE NOTICE '0008: applying least-privilege grants as superuser %; % still owns no object', current_user, app_role;
  END IF;

  -- Remove every table/sequence privilege first, then grant the allowlist.
  -- The allowlist is derived from the runtime queries in
  -- packages/database/src; the integration test pins the same matrix.
  -- UPDATE on `users` and `balance_snapshots` is required by `SELECT ...
  -- FOR UPDATE` row locks (PostgreSQL checks UPDATE for row locking), even
  -- though the runtime never mutates those two tables.
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I', schema_name, app_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I', schema_name, app_role);

  FOR entry IN
    SELECT * FROM (VALUES
      ('users',                   'SELECT, INSERT, UPDATE'),
      ('categories',              'SELECT'),
      ('financial_accounts',      'SELECT, INSERT, UPDATE'),
      ('balance_snapshots',       'SELECT, INSERT, UPDATE'),
      ('transactions',            'SELECT, INSERT, UPDATE'),
      ('idempotency_results',     'SELECT, INSERT'),
      ('audit_events',            'INSERT'),
      ('scheduled_items',         'SELECT, INSERT'),
      ('scheduled_occurrences',   'SELECT, INSERT, UPDATE'),
      ('savings_goals',           'SELECT, INSERT, UPDATE'),
      ('savings_amount_changes',  'SELECT, INSERT'),
      ('auth_attempt_counters',   'SELECT, INSERT, UPDATE, DELETE'),
      ('auth_challenges',         'SELECT, INSERT, UPDATE'),
      ('beta_invitations',        'SELECT, INSERT, UPDATE'),
      ('password_credentials',    'SELECT, INSERT, UPDATE'),
      ('security_events',         'SELECT, INSERT'),
      ('sessions',                'SELECT, INSERT, UPDATE'),
      ('session_tokens',          'SELECT, INSERT, UPDATE'),
      ('financial_current_balances', 'SELECT')
    ) AS allowlist(table_name, privileges)
  LOOP
    EXECUTE format(
      'GRANT %s ON TABLE %I.%I TO %I',
      entry.privileges,
      schema_name,
      entry.table_name,
      app_role
    );
  END LOOP;

  -- `kfin_migrations` is migration-runner state, not application data.
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.kfin_migrations FROM %I', schema_name, app_role);

  -- Trigger and guard functions execute as their caller (SECURITY INVOKER).
  -- Revoke the implicit PUBLIC EXECUTE grant and give only the app role access.
  FOR entry IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    WHERE p.pronamespace = schema_name::regnamespace
      AND p.proname LIKE 'kfin\_%'
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC', entry.signature);
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I', entry.signature, app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', entry.signature, app_role);
  END LOOP;

  -- The view must execute with the caller's privileges so base-table grants
  -- (and, in phase 2, RLS policies) apply. PostgreSQL 15+ is required.
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION '0008: PostgreSQL 15 or newer is required for security_invoker views';
  END IF;
  EXECUTE format(
    'ALTER VIEW %I.financial_current_balances SET (security_invoker = true)',
    schema_name
  );

  -- Future objects created by the migration role follow the same allowlist.
  -- DELETE is deliberately not granted by default: only the one table above
  -- needs it, and a future table must request it explicitly.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE ON TABLES TO %I',
    current_user, schema_name, app_role
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I',
    current_user, schema_name, app_role
  );
  -- PostgreSQL always grants EXECUTE on a new function to PUBLIC; ALTER DEFAULT
  -- PRIVILEGES cannot remove that built-in grant (a REVOKE there is a no-op).
  -- Existing kfin_* functions were explicitly revoked above. A future migration
  -- that creates a function must revoke PUBLIC itself; the integration test
  -- fails if any kfin_* function still exposes PUBLIC EXECUTE.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO %I',
    current_user, schema_name, app_role
  );
END
$$;
