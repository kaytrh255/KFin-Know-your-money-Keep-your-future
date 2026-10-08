-- KFin Trusted Private Beta access, migration 0004.
-- Trace: DATABASE §§4.2-4.7, 12; PRD-AUTH-01..09; SEC-AUTH-01..17;
-- SEC-SES-01..10; SEC-ABUSE-01..09; ADR-002, ADR-004, ADR-008.
-- Forward-only reviewed SQL. The migration runner supplies the transaction.
--
-- Every secret-bearing column below stores a keyed digest only. No plaintext
-- invitation code, OTP, reset secret, session token, or CSRF token is persisted.
-- Additive: no earlier table, column, or constraint is modified.

CREATE TABLE beta_invitations (
  id UUID PRIMARY KEY,
  code_digest BYTEA NOT NULL,
  invited_email_normalized TEXT CHECK (
    invited_email_normalized IS NULL
    OR char_length(invited_email_normalized) BETWEEN 3 AND 320
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_operator_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT beta_invitations_code_digest_uq UNIQUE (code_digest),
  CONSTRAINT beta_invitations_consumed_ck CHECK (
    (status = 'consumed') = (consumed_at IS NOT NULL)
  ),
  CONSTRAINT beta_invitations_revoked_ck CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  ),
  CONSTRAINT beta_invitations_active_not_terminal_ck CHECK (
    status <> 'active' OR (consumed_at IS NULL AND revoked_at IS NULL)
  )
);

CREATE INDEX beta_invitations_active_idx
  ON beta_invitations (status, expires_at)
  WHERE status = 'active';

-- A consumed or revoked invitation is terminal: it can never return to `active`
-- and can never be re-consumed by a second registration.
CREATE FUNCTION kfin_beta_invitations_terminal_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('consumed', 'revoked') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a consumed or revoked invitation is terminal';
  END IF;
  IF OLD.status = 'consumed' AND NEW.consumed_by_user_id IS DISTINCT FROM OLD.consumed_by_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a consumed invitation cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER beta_invitations_terminal_guard_trg
  BEFORE UPDATE ON beta_invitations
  FOR EACH ROW EXECUTE FUNCTION kfin_beta_invitations_terminal_guard();

CREATE TABLE password_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL CHECK (char_length(password_hash) BETWEEN 40 AND 255),
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  hash_policy_version SMALLINT NOT NULL DEFAULT 1 CHECK (hash_policy_version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT password_credentials_hash_ck CHECK (password_hash LIKE '$argon2id$%')
);

CREATE TABLE auth_challenges (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  target_digest BYTEA NOT NULL,
  secret_digest BYTEA NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  request_context_digest BYTEA,
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'delivered', 'failed')),
  last_delivery_attempt_at TIMESTAMPTZ,
  last_delivery_status TEXT CHECK (
    last_delivery_status IS NULL OR char_length(last_delivery_status) BETWEEN 1 AND 120
  ),
  correlation_id TEXT NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT auth_challenges_expiry_ck CHECK (expires_at > issued_at),
  CONSTRAINT auth_challenges_secret_digest_uq UNIQUE (secret_digest),
  CONSTRAINT auth_challenges_consumed_ck CHECK (
    (consumed_at IS NULL) OR (superseded_at IS NULL OR superseded_at <= consumed_at)
  )
);

-- Exactly one active challenge per user and purpose: resend supersession is
-- unambiguous and no two codes can race for the same account.
CREATE UNIQUE INDEX auth_challenges_one_active_uq
  ON auth_challenges (user_id, purpose)
  WHERE consumed_at IS NULL AND superseded_at IS NULL AND user_id IS NOT NULL;

CREATE INDEX auth_challenges_target_idx
  ON auth_challenges (purpose, target_digest, issued_at DESC);

CREATE INDEX auth_challenges_user_idx
  ON auth_challenges (user_id, purpose, issued_at DESC);

-- A challenge may never be un-consumed, may never be consumed twice, and may
-- never have its attempt counter decreased.
CREATE FUNCTION kfin_auth_challenges_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a consumed auth challenge is immutable';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'auth challenge attempt count cannot decrease';
  END IF;
  IF NEW.secret_digest <> OLD.secret_digest OR NEW.purpose <> OLD.purpose THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'auth challenge purpose and secret digest are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_challenges_guard_trg
  BEFORE UPDATE ON auth_challenges
  FOR EACH ROW EXECUTE FUNCTION kfin_auth_challenges_guard();

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id UUID NOT NULL,
  client_type TEXT NOT NULL DEFAULT 'web' CHECK (client_type IN ('web', 'pwa', 'native')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT CHECK (
    revocation_reason IS NULL
    OR revocation_reason IN (
      'user_logout',
      'user_logout_all',
      'user_revoked',
      'password_changed',
      'password_reset',
      'token_replay',
      'account_unavailable',
      'expired'
    )
  ),
  device_label TEXT CHECK (device_label IS NULL OR char_length(device_label) BETWEEN 1 AND 120),
  ip_prefix_digest BYTEA,
  csrf_digest BYTEA NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT sessions_expiry_ck CHECK (
    idle_expires_at > created_at AND absolute_expires_at >= idle_expires_at
  ),
  CONSTRAINT sessions_revocation_ck CHECK (
    (revoked_at IS NULL) = (revocation_reason IS NULL)
  )
);

CREATE INDEX sessions_user_active_idx
  ON sessions (user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX sessions_user_last_seen_idx
  ON sessions (user_id, last_seen_at DESC);

CREATE INDEX sessions_family_idx
  ON sessions (family_id);

-- Revocation is terminal and always carries a reason; a live session may never
-- keep a stale revocation reason.
CREATE FUNCTION kfin_sessions_revocation_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a revoked session cannot be restored';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_revocation_guard_trg
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION kfin_sessions_revocation_guard();

CREATE TABLE session_tokens (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_digest BYTEA NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ,
  grace_expires_at TIMESTAMPTZ,
  replayed_at TIMESTAMPTZ,
  CONSTRAINT session_tokens_digest_uq UNIQUE (token_digest),
  CONSTRAINT session_tokens_generation_uq UNIQUE (session_id, generation),
  CONSTRAINT session_tokens_expiry_ck CHECK (expires_at > issued_at),
  CONSTRAINT session_tokens_grace_ck CHECK (
    grace_expires_at IS NULL OR retired_at IS NOT NULL
  )
);

CREATE INDEX session_tokens_session_current_idx
  ON session_tokens (session_id)
  WHERE retired_at IS NULL;

CREATE TABLE security_events (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'registration_requested',
      'verification_challenge_issued',
      'verification_challenge_failed',
      'email_verified',
      'login_succeeded',
      'login_failed',
      'logout',
      'logout_all',
      'session_revoked',
      'password_changed',
      'password_reset_requested',
      'password_reset_completed',
      'password_reset_failed',
      'session_token_rotated',
      'session_token_replay_detected',
      'session_expired',
      'access_denied_unverified'
    )
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'blocked')),
  -- Candidate classification pending `SPEC-SEC-02`; the API exposes only
  -- `user`/`both` rows.
  visibility TEXT NOT NULL CHECK (visibility IN ('user', 'operator', 'both')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  correlation_id TEXT NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  target_digest BYTEA,
  ip_prefix_digest BYTEA,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT security_events_metadata_size_ck CHECK (pg_column_size(metadata) <= 2048),
  CONSTRAINT security_events_no_secret_ck CHECK (
    NOT (metadata ?| ARRAY['password', 'otp', 'code', 'token', 'secret', 'sessionToken'])
  )
);

CREATE INDEX security_events_user_idx
  ON security_events (user_id, occurred_at DESC, id DESC);

CREATE INDEX security_events_target_idx
  ON security_events (target_digest, occurred_at DESC)
  WHERE target_digest IS NOT NULL;

-- Security history is append-only: no correction or deletion of recorded events.
CREATE FUNCTION kfin_security_events_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'security events are append-only';
END;
$$;

CREATE TRIGGER security_events_immutable_trg
  BEFORE UPDATE OR DELETE ON security_events
  FOR EACH ROW EXECUTE FUNCTION kfin_security_events_immutable();

-- Fixed-window abuse counters (SEC-ABUSE-01/02/03/08). Only digests are stored,
-- and windows are pruned by the application so attacker traffic cannot grow the
-- table without bound.
CREATE TABLE auth_attempt_counters (
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN (
      'login_target',
      'login_ip',
      'verification_target',
      'verification_ip',
      'reset_target',
      'reset_ip',
      'registration_ip'
    )
  ),
  scope_digest BYTEA NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
  first_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope_kind, scope_digest, window_start)
);

CREATE INDEX auth_attempt_counters_window_idx
  ON auth_attempt_counters (window_start);
