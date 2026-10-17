-- 0007 — OTP is reserved for password reset (OQ-20, 2026-10-12).
--
-- Implements the required migration recorded in docs/architecture/DATABASE.md §16.1
-- for the authentication-policy revision:
--
--   1. registration is admitted by the invitation code alone; the account is created
--      usable and its email is represented as explicitly unverified (SEC-AUTH-18/19);
--   2. the emailed OTP is reserved for password reset (SEC-AUTH-05/20);
--   3. an account whose email was never verified is never marked verified.
--
-- Nothing here may invent a verification: no row becomes 'verified' unless a
-- verification challenge was genuinely consumed, and no outstanding verification
-- challenge is reinterpreted as a password-reset challenge.
--
-- Safety: this file runs inside the migration runner's transaction with
-- lock_timeout 5s / statement_timeout 30s, so a blocked lock aborts and rolls back
-- instead of hanging the deployment. Every statement is a bounded metadata change or
-- a bounded UPDATE on tables whose beta-scale row count is small; no table rewrite
-- and no long lock is expected. Rehearse on a restorable copy before production.

-- ---------------------------------------------------------------------------
-- 1. Explicit verification state on users.
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN email_verification_state TEXT;

-- Backfill is derived only from evidence that already exists: a set
-- `email_verified_at` is the only proof that a verification challenge was
-- consumed. Everything else — including every `pending_verification` account —
-- is explicitly unverified rather than assumed verified.
UPDATE users
   SET email_verification_state = CASE
     WHEN email_verified_at IS NULL THEN 'unverified'
     ELSE 'verified'
   END
 WHERE email_verification_state IS NULL;

ALTER TABLE users ALTER COLUMN email_verification_state SET NOT NULL;

-- The two representations may never disagree: 'verified' if and only if a
-- verification instant exists (SEC-AUTH-19). This makes "silently mark verified"
-- a database error rather than a code-review question.
ALTER TABLE users ADD CONSTRAINT users_email_verification_state_ck CHECK (
  email_verification_state IN ('unverified', 'verified')
  AND (email_verification_state = 'verified') = (email_verified_at IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 2. Retire pending_verification.
-- ---------------------------------------------------------------------------

-- A `pending_verification` account was admitted by a consumed invitation code and
-- already holds the credentials its owner chose, so it becomes usable. The
-- invitation row is the admission evidence and is deliberately not rewritten.
UPDATE users SET status = 'active' WHERE status = 'pending_verification';

ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (
  status IN ('active', 'locked', 'disabled', 'deletion_pending')
);

-- ---------------------------------------------------------------------------
-- 3. auth_challenges: only password_reset may be issued.
-- ---------------------------------------------------------------------------

-- Outstanding verification challenges are superseded, never reinterpreted: a
-- verification code must not become a password-reset code (DATABASE §4.4).
UPDATE auth_challenges
   SET superseded_at = clock_timestamp()
 WHERE purpose <> 'password_reset'
   AND consumed_at IS NULL
   AND superseded_at IS NULL;

-- Issuance guard. `email_verification` stays in the purpose CHECK deliberately:
-- consumed rows are append-only history and rewriting their purpose would both
-- violate kfin_auth_challenges_guard() and falsify the audit trail. A CHECK cannot
-- distinguish existing rows from new ones, so issuance — not history — is what this
-- guard refuses, which keeps the same guarantee the specification asks for.
CREATE FUNCTION kfin_auth_challenges_issuance_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.purpose <> 'password_reset' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'OTP challenges are reserved for password reset (OQ-20)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_challenges_issuance_guard_trg
  BEFORE INSERT ON auth_challenges
  FOR EACH ROW EXECUTE FUNCTION kfin_auth_challenges_issuance_guard();

COMMENT ON COLUMN users.email_verification_state IS
  'OQ-20 (2026-10-12): explicit verification truth. Registration never verifies; a NULL email_verified_at means unverified and MUST NOT be presented as verified.';
COMMENT ON FUNCTION kfin_auth_challenges_issuance_guard() IS
  'OQ-20 (2026-10-12): refuses issuance of any challenge purpose other than password_reset; historical rows are preserved.';
