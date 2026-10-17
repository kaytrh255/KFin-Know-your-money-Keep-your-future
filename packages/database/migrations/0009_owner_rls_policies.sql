-- SPEC-SEC-01 phase 2, migration 0009: owner-scoped policies and the narrow
-- pre-identity lookup functions.
--
-- RLS is deliberately NOT enabled here. 0010 enables the financial group and
-- 0011 the authentication group, in that order, after the application code that
-- sets the transaction-local `kfin.user_id` context has been deployed.
--
-- SECURITY NOTE: `kfin.user_id` is set by the application role itself. RLS here
-- is a guardrail against application bugs that omit an owner predicate. It is
-- NOT a defence against an attacker who can already execute arbitrary SQL as
-- `kfin_app`: that attacker can set the same setting and the policies will
-- follow it. Do not describe this design as preventing SQL injection.
--
-- Every definer function below is limited to one exact key, returns the minimum
-- columns the runtime needs, uses a pinned search_path, has no dynamic SQL, and
-- has EXECUTE revoked from PUBLIC and granted only to kfin_app. They exist
-- because the application role has no table privileges on beta_invitations and
-- because a pre-identity token/credential lookup cannot be expressed as an RLS
-- policy without a user context.
--
-- The migration is written against the schema the runner selected (normally
-- `public`; integration tests use a throwaway schema). Function bodies use
-- unqualified names with a pinned `search_path = pg_catalog, <schema>`, so the
-- same file is safe in both deployments.

DO $migration$
DECLARE
  target_schema text := current_schema();
BEGIN
  IF target_schema IS NULL OR target_schema IN ('pg_catalog', 'information_schema') THEN
    RAISE EXCEPTION '0009: could not determine the target schema';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kfin_app') THEN
    RAISE EXCEPTION '0009: role kfin_app is missing; run db:provision-roles first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kfin_operator') THEN
    RAISE EXCEPTION '0009: role kfin_operator is missing; run db:provision-roles first';
  END IF;

  -- The context value is set by the application in the same transaction. An
  -- absent/empty/invalid value yields NULL, so every policy fails closed.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.kfin_current_user_id()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    AS $body$
      SELECT CASE
        WHEN current_setting('kfin.user_id', true) ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN current_setting('kfin.user_id', true)::uuid
        ELSE NULL
      END
    $body$
  $ddl$, target_schema);

  -- Pre-identity account lookup for sign-in and password-reset request. It does
  -- not return the password hash: once the caller has the user id it sets the
  -- context and reads password_credentials under the owner policy.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.kfin_account_lookup(p_email text)
    RETURNS TABLE (user_id uuid, status text, email_verified_at timestamptz)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    ROWS 1
    AS $body$
      SELECT u.id, u.status, u.email_verified_at
        FROM users AS u
       WHERE p_email IS NOT NULL
         AND length(p_email) BETWEEN 3 AND 320
         AND lower(p_email) = p_email
         AND u.email_normalized = p_email
       LIMIT 1
    $body$
  $ddl$, target_schema, target_schema);

  -- Pre-identity session/token resolution. The joined session and user state is
  -- needed to decide expiry/revocation; only the caller holding the digest can
  -- address the row, and exactly one row is returned.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.kfin_token_lookup(p_token_digest bytea)
    RETURNS TABLE (
      id uuid,
      user_id uuid,
      client_type text,
      created_at timestamptz,
      last_seen_at timestamptz,
      idle_expires_at timestamptz,
      absolute_expires_at timestamptz,
      device_label text,
      revoked_at timestamptz,
      csrf_digest bytea,
      token_retired_at timestamptz,
      token_grace_expires_at timestamptz,
      generation integer,
      user_status text,
      email_verified_at timestamptz
    )
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    ROWS 1
    AS $body$
      SELECT s.id, s.user_id, s.client_type, s.created_at, s.last_seen_at,
             s.idle_expires_at, s.absolute_expires_at, s.device_label, s.revoked_at,
             s.csrf_digest, t.retired_at, t.grace_expires_at, t.generation,
             u.status, u.email_verified_at
        FROM session_tokens AS t
        JOIN sessions AS s ON s.id = t.session_id
        JOIN users AS u ON u.id = s.user_id
       WHERE octet_length(p_token_digest) = 32
         AND t.token_digest = p_token_digest
       LIMIT 1
    $body$
  $ddl$, target_schema, target_schema);

  -- Pre-identity reset-challenge lookup, keyed by the keyed digest of the address
  -- the caller already submitted. Returns no account data beyond the challenge.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.kfin_reset_challenge_lookup(p_target_digest bytea)
    RETURNS TABLE (
      id uuid,
      user_id uuid,
      purpose text,
      secret_digest bytea,
      issued_at timestamptz,
      expires_at timestamptz,
      consumed_at timestamptz,
      superseded_at timestamptz,
      attempt_count integer,
      max_attempts integer
    )
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    ROWS 1
    AS $body$
      SELECT c.id, c.user_id, c.purpose, c.secret_digest, c.issued_at,
             c.expires_at, c.consumed_at, c.superseded_at, c.attempt_count,
             c.max_attempts
        FROM auth_challenges AS c
       WHERE octet_length(p_target_digest) = 32
         AND c.purpose = 'password_reset'
         AND c.target_digest = p_target_digest
         AND c.consumed_at IS NULL
         AND c.superseded_at IS NULL
       ORDER BY c.issued_at DESC
       LIMIT 1
    $body$
  $ddl$, target_schema, target_schema);

  -- Registration invitation lookup. The application role has no direct privilege
  -- on beta_invitations (see the REVOKE below).
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.kfin_invitation_lookup(p_code_digest bytea)
    RETURNS TABLE (
      id uuid,
      status text,
      expires_at timestamptz,
      invited_email_normalized text
    )
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    ROWS 1
    AS $body$
      SELECT i.id, i.status, i.expires_at, i.invited_email_normalized
        FROM beta_invitations AS i
       WHERE octet_length(p_code_digest) = 32
         AND i.code_digest = p_code_digest
       LIMIT 1
    $body$
  $ddl$, target_schema, target_schema);

  -- Atomic single-use consumption. The conditional UPDATE is the only place an
  -- invitation becomes consumed; a concurrent or replayed request sees
  -- status = 'consumed' and receives false, and the caller rolls back its
  -- registration transaction. The bound email is re-checked here so a race can
  -- never consume an invitation for a different address.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.kfin_consume_invitation(
      p_invitation_id uuid,
      p_user_id uuid,
      p_email_normalized text,
      p_now timestamptz
    )
    RETURNS boolean
    LANGUAGE sql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    AS $body$
      UPDATE beta_invitations
         SET status = 'consumed',
             consumed_at = p_now,
             consumed_by_user_id = p_user_id
       WHERE id = p_invitation_id
         AND status = 'active'
         AND consumed_by_user_id IS NULL
         AND expires_at > p_now
         AND (
           invited_email_normalized IS NULL
           OR invited_email_normalized = p_email_normalized
         )
      RETURNING true
    $body$
  $ddl$, target_schema, target_schema);

  -- ── policies (RLS is enabled by 0010/0011) ─────────────────────────────────

  CREATE POLICY users_select_own ON users
    FOR SELECT TO kfin_app
    USING (id = kfin_current_user_id());
  CREATE POLICY users_insert_own ON users
    FOR INSERT TO kfin_app
    WITH CHECK (id = kfin_current_user_id());
  CREATE POLICY users_update_own ON users
    FOR UPDATE TO kfin_app
    USING (id = kfin_current_user_id())
    WITH CHECK (id = kfin_current_user_id());

  CREATE POLICY password_credentials_select_own ON password_credentials
    FOR SELECT TO kfin_app
    USING (user_id = kfin_current_user_id());
  CREATE POLICY password_credentials_insert_own ON password_credentials
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());
  CREATE POLICY password_credentials_update_own ON password_credentials
    FOR UPDATE TO kfin_app
    USING (user_id = kfin_current_user_id())
    WITH CHECK (user_id = kfin_current_user_id());

  CREATE POLICY sessions_select_own ON sessions
    FOR SELECT TO kfin_app
    USING (user_id = kfin_current_user_id());
  CREATE POLICY sessions_insert_own ON sessions
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());
  CREATE POLICY sessions_update_own ON sessions
    FOR UPDATE TO kfin_app
    USING (user_id = kfin_current_user_id())
    WITH CHECK (user_id = kfin_current_user_id());

  CREATE POLICY session_tokens_select_own ON session_tokens
    FOR SELECT TO kfin_app
    USING (EXISTS (
      SELECT 1 FROM sessions AS s
       WHERE s.id = session_tokens.session_id
         AND s.user_id = kfin_current_user_id()
    ));
  CREATE POLICY session_tokens_insert_own ON session_tokens
    FOR INSERT TO kfin_app
    WITH CHECK (EXISTS (
      SELECT 1 FROM sessions AS s
       WHERE s.id = session_tokens.session_id
         AND s.user_id = kfin_current_user_id()
    ));
  CREATE POLICY session_tokens_update_own ON session_tokens
    FOR UPDATE TO kfin_app
    USING (EXISTS (
      SELECT 1 FROM sessions AS s
       WHERE s.id = session_tokens.session_id
         AND s.user_id = kfin_current_user_id()
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM sessions AS s
       WHERE s.id = session_tokens.session_id
         AND s.user_id = kfin_current_user_id()
    ));

  CREATE POLICY auth_challenges_select_own ON auth_challenges
    FOR SELECT TO kfin_app
    USING (user_id = kfin_current_user_id());
  CREATE POLICY auth_challenges_insert_own ON auth_challenges
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());
  CREATE POLICY auth_challenges_update_own ON auth_challenges
    FOR UPDATE TO kfin_app
    USING (user_id = kfin_current_user_id())
    WITH CHECK (user_id = kfin_current_user_id());

  CREATE POLICY security_events_select_own ON security_events
    FOR SELECT TO kfin_app
    USING (
      user_id = kfin_current_user_id()
      AND visibility IN ('user', 'both')
    );
  CREATE POLICY security_events_insert_own ON security_events
    FOR INSERT TO kfin_app
    WITH CHECK (user_id IS NULL OR user_id = kfin_current_user_id());

  CREATE POLICY categories_select_visible ON categories
    FOR SELECT TO kfin_app
    USING (owner_user_id IS NULL OR owner_user_id = kfin_current_user_id());

  CREATE POLICY financial_accounts_select_own ON financial_accounts
    FOR SELECT TO kfin_app
    USING (user_id = kfin_current_user_id());
  CREATE POLICY financial_accounts_insert_own ON financial_accounts
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());
  CREATE POLICY financial_accounts_update_own ON financial_accounts
    FOR UPDATE TO kfin_app
    USING (user_id = kfin_current_user_id())
    WITH CHECK (user_id = kfin_current_user_id());

  CREATE POLICY balance_snapshots_select_own ON balance_snapshots
    FOR SELECT TO kfin_app
    USING (user_id = kfin_current_user_id());
  CREATE POLICY balance_snapshots_insert_own ON balance_snapshots
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());
  CREATE POLICY balance_snapshots_update_own ON balance_snapshots
    FOR UPDATE TO kfin_app
    USING (user_id = kfin_current_user_id())
    WITH CHECK (user_id = kfin_current_user_id());

  CREATE POLICY transactions_select_own ON transactions
    FOR SELECT TO kfin_app
    USING (user_id = kfin_current_user_id());
  CREATE POLICY transactions_insert_own ON transactions
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());
  CREATE POLICY transactions_update_own ON transactions
    FOR UPDATE TO kfin_app
    USING (user_id = kfin_current_user_id())
    WITH CHECK (user_id = kfin_current_user_id());

  CREATE POLICY idempotency_results_select_own ON idempotency_results
    FOR SELECT TO kfin_app
    USING (user_id = kfin_current_user_id());
  CREATE POLICY idempotency_results_insert_own ON idempotency_results
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());

  CREATE POLICY scheduled_items_select_own ON scheduled_items
    FOR SELECT TO kfin_app
    USING (user_id = kfin_current_user_id());
  CREATE POLICY scheduled_items_insert_own ON scheduled_items
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());
  CREATE POLICY scheduled_occurrences_select_own ON scheduled_occurrences
    FOR SELECT TO kfin_app
    USING (user_id = kfin_current_user_id());
  CREATE POLICY scheduled_occurrences_insert_own ON scheduled_occurrences
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());
  CREATE POLICY scheduled_occurrences_update_own ON scheduled_occurrences
    FOR UPDATE TO kfin_app
    USING (user_id = kfin_current_user_id())
    WITH CHECK (user_id = kfin_current_user_id());

  CREATE POLICY savings_goals_select_own ON savings_goals
    FOR SELECT TO kfin_app
    USING (user_id = kfin_current_user_id());
  CREATE POLICY savings_goals_insert_own ON savings_goals
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());
  CREATE POLICY savings_goals_update_own ON savings_goals
    FOR UPDATE TO kfin_app
    USING (user_id = kfin_current_user_id())
    WITH CHECK (user_id = kfin_current_user_id());

  CREATE POLICY savings_amount_changes_select_own ON savings_amount_changes
    FOR SELECT TO kfin_app
    USING (user_id = kfin_current_user_id());
  CREATE POLICY savings_amount_changes_insert_own ON savings_amount_changes
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());

  CREATE POLICY audit_events_insert_own ON audit_events
    FOR INSERT TO kfin_app
    WITH CHECK (user_id = kfin_current_user_id());

  -- The operator path is a separate LOGIN role with INSERT on invitations only.
  CREATE POLICY beta_invitations_operator_insert ON beta_invitations
    FOR INSERT TO kfin_operator
    WITH CHECK (true);

  -- auth_attempt_counters has no owner column: it holds keyed digests plus fixed
  -- window counts and is deliberately left without RLS (documented residual).
  -- kfin_migrations keeps zero application privileges; RLS is enabled in 0011
  -- with no policy as defence in depth.

  -- ── grants ─────────────────────────────────────────────────────────────────

  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.beta_invitations FROM kfin_app', target_schema);
  EXECUTE format('GRANT INSERT ON TABLE %I.beta_invitations TO kfin_operator', target_schema);

  EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %I.kfin_current_user_id() FROM PUBLIC', target_schema);
  EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %I.kfin_account_lookup(text) FROM PUBLIC', target_schema);
  EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %I.kfin_token_lookup(bytea) FROM PUBLIC', target_schema);
  EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %I.kfin_reset_challenge_lookup(bytea) FROM PUBLIC', target_schema);
  EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %I.kfin_invitation_lookup(bytea) FROM PUBLIC', target_schema);
  EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %I.kfin_consume_invitation(uuid, uuid, text, timestamptz) FROM PUBLIC', target_schema);

  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.kfin_current_user_id() TO kfin_app', target_schema);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.kfin_account_lookup(text) TO kfin_app', target_schema);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.kfin_token_lookup(bytea) TO kfin_app', target_schema);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.kfin_reset_challenge_lookup(bytea) TO kfin_app', target_schema);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.kfin_invitation_lookup(bytea) TO kfin_app', target_schema);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.kfin_consume_invitation(uuid, uuid, text, timestamptz) TO kfin_app', target_schema);
END
$migration$;
