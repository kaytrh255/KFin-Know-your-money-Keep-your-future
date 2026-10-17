-- SPEC-SEC-01 phase 2, migration 0011: enable RLS on the authentication group.
--
-- This is the last enablement step. The five SECURITY DEFINER functions from
-- 0009 are the only pre-identity access paths; every other statement in the
-- authentication flows already runs after `kfin.user_id` is set.
--
-- `kfin_migrations` belongs to the migration role and has no application
-- privilege at all; RLS with no policy is defence in depth if that ever changes.
-- `auth_attempt_counters` is intentionally not enabled: it has no owner column,
-- stores only keyed digests and fixed-window counts, and must remain usable for
-- pre-identity brute-force accounting (documented residual).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kfin_migrations ENABLE ROW LEVEL SECURITY;
