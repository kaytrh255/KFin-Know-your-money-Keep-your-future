-- KFin one-off schedule occurrence vertical slice, migration 0002.
-- Trace: PRD-INC-03, PRD-EXP-04, PRD-REM-03; DATABASE §§7.1-7.2;
-- FIN-DOMAIN-LINK-INV-01; FIN-OCC-01..04; FIN-LINK-01.
-- Recurrence generation/editing is deliberately excluded while SPEC-SCH-01 remains OPEN.

CREATE TABLE scheduled_items (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  account_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'essential_expense')),
  transaction_kind TEXT NOT NULL CHECK (transaction_kind IN ('income', 'expense')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  expected_amount_minor BIGINT NOT NULL CHECK (expected_amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  category_id UUID NOT NULL,
  expense_class TEXT CHECK (
    expense_class IS NULL OR expense_class IN ('essential_fixed', 'essential_variable')
  ),
  frequency TEXT NOT NULL DEFAULT 'one_off' CHECK (frequency = 'one_off'),
  recurrence_interval INTEGER NOT NULL DEFAULT 1 CHECK (recurrence_interval = 1),
  start_on DATE NOT NULL,
  end_on DATE,
  timezone TEXT NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 100),
  confirmation_policy TEXT NOT NULL DEFAULT 'explicit' CHECK (confirmation_policy = 'explicit'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT scheduled_items_kind_direction_ck CHECK (
    (kind = 'income' AND transaction_kind = 'income' AND expense_class IS NULL)
    OR (kind = 'essential_expense' AND transaction_kind = 'expense' AND expense_class IS NOT NULL)
  ),
  CONSTRAINT scheduled_items_one_off_dates_ck CHECK (end_on IS NULL OR end_on = start_on),
  CONSTRAINT scheduled_items_owner_account_id_uq UNIQUE (user_id, account_id, id),
  CONSTRAINT scheduled_items_owner_account_id_currency_kind_uq
    UNIQUE (user_id, account_id, id, currency, transaction_kind),
  CONSTRAINT scheduled_items_account_currency_fk
    FOREIGN KEY (user_id, account_id, currency)
    REFERENCES financial_accounts(user_id, id, currency) ON DELETE RESTRICT,
  CONSTRAINT scheduled_items_category_kind_fk
    FOREIGN KEY (category_id, transaction_kind)
    REFERENCES categories(id, transaction_kind) ON DELETE RESTRICT
);

CREATE INDEX scheduled_items_owner_active_idx
  ON scheduled_items (user_id, active, start_on, id);

CREATE TABLE scheduled_occurrences (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  account_id UUID NOT NULL,
  scheduled_item_id UUID NOT NULL,
  transaction_kind TEXT NOT NULL CHECK (transaction_kind IN ('income', 'expense')),
  due_on DATE NOT NULL,
  expected_amount_minor BIGINT NOT NULL CHECK (expected_amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled', 'confirmed', 'skipped', 'cancelled')),
  confirmed_transaction_id UUID,
  confirmed_at TIMESTAMPTZ,
  skipped_at TIMESTAMPTZ,
  skip_reason TEXT CHECK (skip_reason IS NULL OR char_length(skip_reason) BETWEEN 1 AND 1000),
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT scheduled_occurrences_item_due_uq UNIQUE (scheduled_item_id, due_on),
  CONSTRAINT scheduled_occurrences_confirmed_transaction_uq UNIQUE (confirmed_transaction_id),
  CONSTRAINT scheduled_occurrences_owner_account_id_uq UNIQUE (user_id, account_id, id),
  CONSTRAINT scheduled_occurrences_item_fk
    FOREIGN KEY (user_id, account_id, scheduled_item_id, currency, transaction_kind)
    REFERENCES scheduled_items(user_id, account_id, id, currency, transaction_kind)
    ON DELETE RESTRICT,
  CONSTRAINT scheduled_occurrences_transaction_fk
    FOREIGN KEY (user_id, account_id, confirmed_transaction_id)
    REFERENCES transactions(user_id, account_id, id) ON DELETE RESTRICT,
  CONSTRAINT scheduled_occurrences_state_ck CHECK (
    (state = 'scheduled'
      AND confirmed_transaction_id IS NULL AND confirmed_at IS NULL
      AND skipped_at IS NULL AND skip_reason IS NULL AND cancelled_at IS NULL)
    OR (state = 'confirmed'
      AND confirmed_transaction_id IS NOT NULL AND confirmed_at IS NOT NULL
      AND skipped_at IS NULL AND skip_reason IS NULL AND cancelled_at IS NULL)
    OR (state = 'skipped'
      AND confirmed_transaction_id IS NULL AND confirmed_at IS NULL
      AND skipped_at IS NOT NULL AND skip_reason IS NOT NULL AND cancelled_at IS NULL)
    OR (state = 'cancelled'
      AND confirmed_transaction_id IS NULL AND confirmed_at IS NULL
      AND skipped_at IS NULL AND skip_reason IS NULL AND cancelled_at IS NOT NULL)
  )
);

CREATE INDEX scheduled_occurrences_owner_due_idx
  ON scheduled_occurrences (user_id, state, due_on, id);

CREATE FUNCTION kfin_guard_scheduled_occurrence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  linked_item scheduled_items%ROWTYPE;
  linked_transaction transactions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'scheduled occurrence records cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'scheduled' OR NEW.version <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'new scheduled occurrences must start scheduled at version 1';
    END IF;
    SELECT * INTO linked_item
    FROM scheduled_items
    WHERE id = NEW.scheduled_item_id
      AND user_id = NEW.user_id
      AND account_id = NEW.account_id;
    IF NOT FOUND
       OR linked_item.start_on IS DISTINCT FROM NEW.due_on
       OR linked_item.expected_amount_minor IS DISTINCT FROM NEW.expected_amount_minor
       OR linked_item.currency IS DISTINCT FROM NEW.currency
       OR linked_item.transaction_kind IS DISTINCT FROM NEW.transaction_kind THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'one-off occurrence must snapshot its scheduled item authority';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.scheduled_item_id IS DISTINCT FROM OLD.scheduled_item_id
     OR NEW.transaction_kind IS DISTINCT FROM OLD.transaction_kind
     OR NEW.due_on IS DISTINCT FROM OLD.due_on
     OR NEW.expected_amount_minor IS DISTINCT FROM OLD.expected_amount_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'scheduled occurrence authority fields are immutable';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'scheduled occurrence version must increment exactly once';
  END IF;

  IF OLD.state = 'scheduled' THEN
    IF NEW.state NOT IN ('confirmed', 'skipped', 'cancelled') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'scheduled occurrence transition is invalid';
    END IF;
  ELSIF OLD.state = 'confirmed' THEN
    IF NEW.state <> 'confirmed'
       OR NEW.confirmed_transaction_id IS NOT DISTINCT FROM OLD.confirmed_transaction_id THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'confirmed occurrence permits only an audited transaction pointer transfer';
    END IF;
    IF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'confirmed occurrence time is immutable during pointer transfer';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'terminal scheduled occurrence state is immutable';
  END IF;

  IF NEW.state = 'confirmed' THEN
    SELECT * INTO linked_transaction
    FROM transactions
    WHERE id = NEW.confirmed_transaction_id
      AND user_id = NEW.user_id
      AND account_id = NEW.account_id;
    IF NOT FOUND
       OR linked_transaction.status <> 'posted'
       OR linked_transaction.currency IS DISTINCT FROM NEW.currency
       OR linked_transaction.kind IS DISTINCT FROM NEW.transaction_kind THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'confirmed occurrence requires one compatible posted transaction';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER scheduled_occurrences_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON scheduled_occurrences
  FOR EACH ROW EXECUTE FUNCTION kfin_guard_scheduled_occurrence();

CREATE FUNCTION kfin_guard_confirmed_transaction_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' AND NEW.status = 'voided' AND EXISTS (
    SELECT 1
    FROM scheduled_occurrences
    WHERE user_id = OLD.user_id
      AND account_id = OLD.account_id
      AND confirmed_transaction_id = OLD.id
      AND state = 'confirmed'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'a schedule-linked transaction pointer must be transferred before void';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_schedule_link_guard_trg
  BEFORE UPDATE OF status ON transactions
  FOR EACH ROW EXECUTE FUNCTION kfin_guard_confirmed_transaction_status();
