-- KFin savings goals, migration 0006.
-- Trace: QA addendum to MILESTONE-06 (findings F-2/F-3); DATABASE §9.
-- Migration 0005 is unchanged. This migration only replaces the guard
-- function that the BEFORE INSERT trigger `savings_amount_changes_guard_trg`
-- from 0005 already calls, closing two seams it left open:
--
--   F-2 — the guard required a change row to match the goal's CURRENT scalar
--         state (version, amount, as-of), but it never asked whether the
--         declared old amount continues the goal's own history chain. A plan
--         edit or an archive advances the version without writing a history
--         row, so a forged row for such a version could match every scalar
--         field while inventing any previous amount.
--
--   F-3 — the actor column carried only a foreign key to users(id); any
--         existing user was accepted, so a forged row could attribute an
--         amount change to someone who does not own the goal.

CREATE OR REPLACE FUNCTION kfin_guard_savings_amount_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  goal savings_goals%ROWTYPE;
  chain_amount BIGINT;
BEGIN
  SELECT * INTO goal FROM savings_goals
  WHERE id = NEW.savings_goal_id AND user_id = NEW.user_id;
  IF NOT FOUND
     OR goal.version <> NEW.goal_version
     OR goal.current_amount_minor <> NEW.new_amount_minor
     OR goal.current_amount_as_of <> NEW.as_of
     OR (NEW.source = 'initial' AND NEW.goal_version <> 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'savings amount change must match the goal version it records';
  END IF;
  -- F-2: the declared old amount must continue the goal's own history chain.
  -- Version 1 opens the chain (its previous amount is NULL); every later
  -- version must declare exactly the new amount of the newest earlier change
  -- row. Plan edits and archives advance the version without change rows, so
  -- the chain is defined over the rows that exist, not over version numbers.
  IF NEW.goal_version = 1 THEN
    IF NEW.previous_amount_minor IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'savings amount change must continue the goal history chain';
    END IF;
  ELSE
    SELECT change.new_amount_minor INTO chain_amount
    FROM savings_amount_changes AS change
    WHERE change.savings_goal_id = NEW.savings_goal_id
      AND change.user_id = NEW.user_id
      AND change.goal_version < NEW.goal_version
    ORDER BY change.goal_version DESC
    LIMIT 1;
    IF NOT FOUND OR chain_amount IS DISTINCT FROM NEW.previous_amount_minor THEN
      RAISE EXCEPTION USING
        ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'savings amount change must continue the goal history chain';
    END IF;
  END IF;
  -- F-3: a user actor must be the goal's owner. NULL with actor_operator_id
  -- set remains the operator recovery path defined in 0005.
  IF NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id <> NEW.user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'savings amount change user actor must be the goal owner';
  END IF;
  RETURN NEW;
END;
$$;
