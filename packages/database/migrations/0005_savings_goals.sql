-- KFin savings goals, migration 0005.
-- Trace: PRD-SAV-01..07; MVP-SCOPE §2.6; UF-SAV-01; DATABASE §§9.1-9.2; OQ-08.
-- A goal stores a manually maintained absolute reserve estimate, not a cash
-- ledger. It never touches financial_accounts, balance_snapshots, transactions,
-- or financial_current_balances. Planned-purchase use is represented in the
-- amount-change source enum per DATABASE §9.2, but the planned_purchases table
-- (and its foreign key) belongs to a later milestone.

CREATE TABLE savings_goals (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  target_amount_minor BIGINT NOT NULL CHECK (target_amount_minor > 0),
  current_amount_minor BIGINT NOT NULL CHECK (current_amount_minor >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  current_amount_as_of DATE NOT NULL,
  target_date DATE,
  planned_contribution_minor BIGINT CHECK (
    planned_contribution_minor IS NULL OR planned_contribution_minor > 0
  ),
  contribution_frequency TEXT CHECK (
    contribution_frequency IS NULL OR contribution_frequency IN ('weekly', 'monthly', 'yearly')
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT savings_goals_cadence_requires_contribution_ck CHECK (
    contribution_frequency IS NULL OR planned_contribution_minor IS NOT NULL
  ),
  CONSTRAINT savings_goals_archived_at_ck CHECK (
    (status = 'archived') = (archived_at IS NOT NULL)
  ),
  CONSTRAINT savings_goals_owner_id_uq UNIQUE (user_id, id),
  CONSTRAINT savings_goals_user_currency_fk
    FOREIGN KEY (user_id, currency) REFERENCES users(id, base_currency) ON DELETE RESTRICT
);

CREATE INDEX savings_goals_owner_status_idx
  ON savings_goals (user_id, status, created_at, id);

CREATE TABLE savings_amount_changes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  savings_goal_id UUID NOT NULL,
  goal_version BIGINT NOT NULL CHECK (goal_version >= 1),
  previous_amount_minor BIGINT CHECK (previous_amount_minor IS NULL OR previous_amount_minor >= 0),
  new_amount_minor BIGINT NOT NULL CHECK (new_amount_minor >= 0),
  as_of DATE NOT NULL,
  source TEXT NOT NULL CHECK (
    source IN ('initial', 'manual_update', 'planned_purchase_use', 'recovery_correction')
  ),
  planned_purchase_id UUID UNIQUE,
  reason TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  actor_operator_id UUID,
  correlation_id TEXT NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  CONSTRAINT savings_amount_changes_actor_ck CHECK (
    (actor_user_id IS NOT NULL)::integer + (actor_operator_id IS NOT NULL)::integer = 1
  ),
  CONSTRAINT savings_amount_changes_initial_ck CHECK (
    (source = 'initial') = (previous_amount_minor IS NULL)
  ),
  CONSTRAINT savings_amount_changes_planned_purchase_ck CHECK (
    (source = 'planned_purchase_use') = (planned_purchase_id IS NOT NULL)
  ),
  CONSTRAINT savings_amount_changes_purchase_decrease_ck CHECK (
    source <> 'planned_purchase_use' OR new_amount_minor <= previous_amount_minor
  ),
  CONSTRAINT savings_amount_changes_goal_version_uq UNIQUE (savings_goal_id, goal_version),
  CONSTRAINT savings_amount_changes_goal_owner_fk
    FOREIGN KEY (user_id, savings_goal_id)
    REFERENCES savings_goals(user_id, id) ON DELETE RESTRICT
);

CREATE INDEX savings_amount_changes_owner_goal_idx
  ON savings_amount_changes (user_id, savings_goal_id, created_at DESC, id DESC);

-- Amount-change rows are immutable correction/audit evidence (DATABASE §9.2).
CREATE TRIGGER savings_amount_changes_immutable_trg
  BEFORE UPDATE OR DELETE ON savings_amount_changes
  FOR EACH ROW EXECUTE FUNCTION kfin_reject_immutable_history();

-- Goal row authority: identity/owner/currency/creation are fixed, every update
-- advances the optimistic version by exactly one, and archive is terminal so an
-- archived goal keeps its latest value (PRD-SAV-07).
CREATE FUNCTION kfin_guard_savings_goal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'savings goal identity, owner, currency, and creation time are immutable';
  END IF;
  IF OLD.status = 'archived' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'archived savings goals are terminal';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'savings goal updates must advance the version by exactly one';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER savings_goals_guard_trg
  BEFORE UPDATE ON savings_goals
  FOR EACH ROW EXECUTE FUNCTION kfin_guard_savings_goal();

CREATE TRIGGER savings_goals_no_delete_trg
  BEFORE DELETE ON savings_goals
  FOR EACH ROW EXECUTE FUNCTION kfin_reject_immutable_history();

-- A change row must describe the goal's current state at the moment it is
-- written: same owner, the goal's current version, amount, and as-of date.
CREATE FUNCTION kfin_guard_savings_amount_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  goal savings_goals%ROWTYPE;
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER savings_amount_changes_guard_trg
  BEFORE INSERT ON savings_amount_changes
  FOR EACH ROW EXECUTE FUNCTION kfin_guard_savings_amount_change();

-- Every goal creation and every change of current amount/as-of date must commit
-- together with exactly one matching old/new change row (DATABASE §9.1). The
-- check is deferred to commit so the scalar update and its audit row are
-- verified as one atomic unit.
CREATE FUNCTION kfin_require_savings_amount_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.current_amount_minor IS NOT DISTINCT FROM OLD.current_amount_minor
     AND NEW.current_amount_as_of IS NOT DISTINCT FROM OLD.current_amount_as_of THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM savings_amount_changes AS change
    WHERE change.savings_goal_id = NEW.id
      AND change.user_id = NEW.user_id
      AND change.goal_version = NEW.version
      AND change.new_amount_minor = NEW.current_amount_minor
      AND change.as_of = NEW.current_amount_as_of
      AND (
        (TG_OP = 'INSERT' AND change.source = 'initial')
        OR (TG_OP = 'UPDATE' AND change.source <> 'initial'
            AND change.previous_amount_minor = OLD.current_amount_minor)
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'savings goal amount changes require one matching old/new audit row';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER savings_goals_amount_audit_trg
  AFTER INSERT OR UPDATE ON savings_goals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kfin_require_savings_amount_change();
