-- KFin financial foundation, migration 0001.
-- Trace: DATABASE §§4.1, 5.1-5.3, 6.1-6.3, 12.1-12.2;
-- ARCHITECTURE FIN-SNAP-INV-01..10 and account_financial_serialization.v1.
-- Forward-only reviewed SQL. The migration runner supplies the transaction.

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  email_normalized TEXT NOT NULL CHECK (char_length(email_normalized) BETWEEN 3 AND 320),
  email_verified_at TIMESTAMPTZ,
  display_name TEXT CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 120),
  locale TEXT NOT NULL CHECK (char_length(locale) BETWEEN 2 AND 35),
  timezone TEXT NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 100),
  base_currency CHAR(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  status TEXT NOT NULL CHECK (
    status IN ('pending_verification', 'active', 'locked', 'disabled', 'deletion_pending')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  disabled_at TIMESTAMPTZ,
  deletion_requested_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT users_email_normalized_uq UNIQUE (email_normalized),
  CONSTRAINT users_id_currency_uq UNIQUE (id, base_currency)
);

CREATE TABLE categories (
  id UUID PRIMARY KEY,
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,62}$'),
  message_key TEXT NOT NULL CHECK (char_length(message_key) BETWEEN 1 AND 120),
  transaction_kind TEXT NOT NULL CHECK (transaction_kind IN ('income', 'expense')),
  default_expense_class TEXT CHECK (
    default_expense_class IS NULL
    OR default_expense_class IN ('essential_fixed', 'essential_variable', 'daily')
  ),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT categories_code_uq UNIQUE (code),
  CONSTRAINT categories_id_kind_uq UNIQUE (id, transaction_kind),
  CONSTRAINT categories_income_class_ck CHECK (
    transaction_kind = 'expense' OR default_expense_class IS NULL
  )
);

INSERT INTO categories (
  id, owner_user_id, code, message_key, transaction_kind, default_expense_class, display_order
) VALUES
  ('10000000-0000-4000-8000-000000000001', NULL, 'income_other', 'category.income_other', 'income', NULL, 10),
  ('20000000-0000-4000-8000-000000000001', NULL, 'rent', 'category.rent', 'expense', NULL, 100),
  ('20000000-0000-4000-8000-000000000002', NULL, 'electricity', 'category.electricity', 'expense', NULL, 110),
  ('20000000-0000-4000-8000-000000000003', NULL, 'water', 'category.water', 'expense', NULL, 120),
  ('20000000-0000-4000-8000-000000000004', NULL, 'internet', 'category.internet', 'expense', NULL, 130),
  ('20000000-0000-4000-8000-000000000005', NULL, 'required_subscriptions', 'category.required_subscriptions', 'expense', NULL, 140),
  ('20000000-0000-4000-8000-000000000006', NULL, 'food', 'category.food', 'expense', NULL, 150),
  ('20000000-0000-4000-8000-000000000007', NULL, 'transportation', 'category.transportation', 'expense', NULL, 160),
  ('20000000-0000-4000-8000-000000000008', NULL, 'entertainment', 'category.entertainment', 'expense', NULL, 170),
  ('20000000-0000-4000-8000-000000000009', NULL, 'shopping', 'category.shopping', 'expense', NULL, 180),
  ('20000000-0000-4000-8000-000000000010', NULL, 'repair', 'category.repair', 'expense', NULL, 190),
  ('20000000-0000-4000-8000-000000000011', NULL, 'emergency', 'category.emergency', 'expense', NULL, 200),
  ('20000000-0000-4000-8000-000000000012', NULL, 'unexpected_bills', 'category.unexpected_bills', 'expense', NULL, 210),
  ('20000000-0000-4000-8000-000000000013', NULL, 'expense_other', 'category.expense_other', 'expense', NULL, 220);

CREATE TABLE financial_accounts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  account_type TEXT NOT NULL DEFAULT 'aggregate_liquid' CHECK (account_type = 'aggregate_liquid'),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  financial_state_version BIGINT NOT NULL DEFAULT 1 CHECK (financial_state_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT financial_accounts_user_uq UNIQUE (user_id),
  CONSTRAINT financial_accounts_owner_id_uq UNIQUE (user_id, id),
  CONSTRAINT financial_accounts_owner_id_currency_uq UNIQUE (user_id, id, currency),
  CONSTRAINT financial_accounts_user_currency_fk
    FOREIGN KEY (user_id, currency) REFERENCES users(id, base_currency) ON DELETE RESTRICT
);

CREATE TABLE balance_snapshots (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  account_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_at TIMESTAMPTZ NOT NULL,
  effective_local_date DATE NOT NULL,
  timezone TEXT NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 100),
  reason TEXT NOT NULL CHECK (reason IN ('onboarding', 'manual_balance_update', 'recovery_correction')),
  note TEXT CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  created_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_by_operator_id UUID,
  correlation_id TEXT NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT balance_snapshots_actor_ck CHECK (
    (created_by_user_id IS NOT NULL)::integer + (created_by_operator_id IS NOT NULL)::integer = 1
  ),
  CONSTRAINT balance_snapshots_account_effective_uq UNIQUE (account_id, effective_at),
  CONSTRAINT balance_snapshots_owner_account_id_currency_uq
    UNIQUE (user_id, account_id, id, currency),
  CONSTRAINT balance_snapshots_account_currency_fk
    FOREIGN KEY (user_id, account_id, currency)
    REFERENCES financial_accounts(user_id, id, currency) ON DELETE RESTRICT
);

CREATE INDEX balance_snapshots_latest_idx
  ON balance_snapshots (user_id, account_id, effective_at DESC);

CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  account_id UUID NOT NULL,
  balance_snapshot_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_on DATE NOT NULL,
  balance_effect TEXT NOT NULL CHECK (balance_effect IN ('current', 'historical')),
  already_included_in_snapshot BOOLEAN NOT NULL,
  category_id UUID NOT NULL,
  expense_class TEXT CHECK (
    expense_class IS NULL OR expense_class IN ('essential_fixed', 'essential_variable', 'daily')
  ),
  is_unexpected BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'voided')),
  voided_at TIMESTAMPTZ,
  void_reason TEXT CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 1 AND 1000),
  supersedes_transaction_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT transactions_owner_account_id_uq UNIQUE (user_id, account_id, id),
  CONSTRAINT transactions_snapshot_currency_fk
    FOREIGN KEY (user_id, account_id, balance_snapshot_id, currency)
    REFERENCES balance_snapshots(user_id, account_id, id, currency) ON DELETE RESTRICT,
  CONSTRAINT transactions_category_kind_fk
    FOREIGN KEY (category_id, kind) REFERENCES categories(id, transaction_kind) ON DELETE RESTRICT,
  CONSTRAINT transactions_supersedes_same_owner_fk
    FOREIGN KEY (user_id, account_id, supersedes_transaction_id)
    REFERENCES transactions(user_id, account_id, id) ON DELETE RESTRICT,
  CONSTRAINT transactions_not_self_superseding_ck CHECK (id IS DISTINCT FROM supersedes_transaction_id),
  CONSTRAINT transactions_effect_inclusion_ck CHECK (
    (balance_effect = 'historical' AND already_included_in_snapshot)
    OR (balance_effect = 'current' AND NOT already_included_in_snapshot)
  ),
  CONSTRAINT transactions_classification_ck CHECK (
    (kind = 'income' AND expense_class IS NULL AND NOT is_unexpected)
    OR (kind = 'expense' AND expense_class IS NOT NULL)
  ),
  CONSTRAINT transactions_void_state_ck CHECK (
    (status = 'posted' AND voided_at IS NULL AND void_reason IS NULL)
    OR (status = 'voided' AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX transactions_successor_uq
  ON transactions (supersedes_transaction_id)
  WHERE supersedes_transaction_id IS NOT NULL;
CREATE INDEX transactions_activity_idx
  ON transactions (user_id, occurred_on DESC, id DESC);
CREATE INDEX transactions_current_balance_idx
  ON transactions (user_id, balance_snapshot_id, balance_effect, status)
  INCLUDE (kind, amount_minor);

CREATE TABLE idempotency_results (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_id UUID,
  operation TEXT NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 100),
  key_digest CHAR(64) NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  prior_financial_state_version BIGINT,
  committed_financial_state_version BIGINT,
  response_status SMALLINT NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  result_code TEXT NOT NULL CHECK (char_length(result_code) BETWEEN 1 AND 80),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object' AND pg_column_size(result) <= 4096),
  correlation_id TEXT NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
  CONSTRAINT idempotency_results_account_owner_fk
    FOREIGN KEY (user_id, account_id)
    REFERENCES financial_accounts(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_results_versions_ck CHECK (
    prior_financial_state_version IS NULL
    OR prior_financial_state_version >= 1
  ),
  CONSTRAINT idempotency_results_committed_version_ck CHECK (
    committed_financial_state_version IS NULL
    OR committed_financial_state_version >= 1
  )
);

CREATE UNIQUE INDEX idempotency_results_account_scope_uq
  ON idempotency_results (user_id, account_id, operation, key_digest)
  WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX idempotency_results_user_scope_uq
  ON idempotency_results (user_id, operation, key_digest)
  WHERE account_id IS NULL;
CREATE INDEX idempotency_results_expiry_idx ON idempotency_results (expires_at);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  actor_operator_id UUID,
  action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 100),
  resource_type TEXT NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 80),
  resource_id UUID NOT NULL,
  outcome TEXT NOT NULL CHECK (char_length(outcome) BETWEEN 1 AND 40),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  correlation_id TEXT NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 4096),
  CONSTRAINT audit_events_actor_ck CHECK (
    (actor_user_id IS NOT NULL)::integer + (actor_operator_id IS NOT NULL)::integer = 1
  )
);
CREATE INDEX audit_events_owner_time_idx ON audit_events (user_id, occurred_at DESC, id DESC);

CREATE FUNCTION kfin_reject_immutable_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'integrity_constraint_violation',
    MESSAGE = format('%I records are immutable', TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER balance_snapshots_immutable_trg
  BEFORE UPDATE OR DELETE ON balance_snapshots
  FOR EACH ROW EXECUTE FUNCTION kfin_reject_immutable_history();
CREATE TRIGGER audit_events_immutable_trg
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION kfin_reject_immutable_history();

CREATE FUNCTION kfin_guard_account_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.account_type IS DISTINCT FROM OLD.account_type
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'financial account authority fields are immutable';
  END IF;
  IF NEW.financial_state_version <> OLD.financial_state_version
     AND NEW.financial_state_version <> OLD.financial_state_version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'financial state version must be unchanged or increment exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_accounts_authority_trg
  BEFORE UPDATE ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION kfin_guard_account_authority();

CREATE FUNCTION kfin_guard_transaction_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source transactions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'transaction records cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.supersedes_transaction_id IS NOT NULL THEN
      SELECT * INTO source
      FROM transactions
      WHERE id = NEW.supersedes_transaction_id
        AND user_id = NEW.user_id
        AND account_id = NEW.account_id
      FOR UPDATE;
      IF NOT FOUND OR source.status <> 'posted' THEN
        RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
          MESSAGE = 'correction source must be an owned posted terminal transaction';
      END IF;
      IF source.currency IS DISTINCT FROM NEW.currency
         OR source.kind IS DISTINCT FROM NEW.kind
         OR source.balance_snapshot_id IS DISTINCT FROM NEW.balance_snapshot_id
         OR source.balance_effect IS DISTINCT FROM NEW.balance_effect
         OR source.already_included_in_snapshot IS DISTINCT FROM NEW.already_included_in_snapshot THEN
        RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
          MESSAGE = 'correction authority fields must match the source';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.balance_snapshot_id IS DISTINCT FROM OLD.balance_snapshot_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.occurred_on IS DISTINCT FROM OLD.occurred_on
     OR NEW.balance_effect IS DISTINCT FROM OLD.balance_effect
     OR NEW.already_included_in_snapshot IS DISTINCT FROM OLD.already_included_in_snapshot
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.expense_class IS DISTINCT FROM OLD.expense_class
     OR NEW.is_unexpected IS DISTINCT FROM OLD.is_unexpected
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.supersedes_transaction_id IS DISTINCT FROM OLD.supersedes_transaction_id THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'transaction financial facts are immutable';
  END IF;
  IF OLD.status <> 'posted'
     OR NEW.status <> 'voided'
     OR NEW.voided_at IS NULL
     OR NEW.void_reason IS NULL
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'only the reviewed posted-to-voided transition is allowed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_history_trg
  BEFORE INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION kfin_guard_transaction_history();

CREATE VIEW financial_current_balances AS
SELECT
  account.user_id,
  account.id AS account_id,
  account.currency,
  account.financial_state_version,
  snapshot.id AS snapshot_id,
  snapshot.amount_minor AS snapshot_amount_minor,
  snapshot.effective_at AS snapshot_effective_at,
  snapshot.effective_local_date AS snapshot_effective_local_date,
  COALESCE(SUM(txn.amount_minor) FILTER (
    WHERE txn.status = 'posted'
      AND txn.balance_effect = 'current'
      AND txn.kind = 'income'
  ), 0)::numeric AS posted_current_income_minor,
  COALESCE(SUM(txn.amount_minor) FILTER (
    WHERE txn.status = 'posted'
      AND txn.balance_effect = 'current'
      AND txn.kind = 'expense'
  ), 0)::numeric AS posted_current_expense_minor,
  (
    snapshot.amount_minor
    + COALESCE(SUM(txn.amount_minor) FILTER (
      WHERE txn.status = 'posted'
        AND txn.balance_effect = 'current'
        AND txn.kind = 'income'
    ), 0)
    - COALESCE(SUM(txn.amount_minor) FILTER (
      WHERE txn.status = 'posted'
        AND txn.balance_effect = 'current'
        AND txn.kind = 'expense'
    ), 0)
  )::numeric AS current_balance_minor
FROM financial_accounts AS account
JOIN LATERAL (
  SELECT candidate.*
  FROM balance_snapshots AS candidate
  WHERE candidate.user_id = account.user_id
    AND candidate.account_id = account.id
  ORDER BY candidate.effective_at DESC
  LIMIT 1
) AS snapshot ON TRUE
LEFT JOIN transactions AS txn
  ON txn.user_id = account.user_id
 AND txn.account_id = account.id
 AND txn.balance_snapshot_id = snapshot.id
GROUP BY account.user_id, account.id, account.currency, account.financial_state_version,
  snapshot.id, snapshot.amount_minor, snapshot.effective_at, snapshot.effective_local_date;
