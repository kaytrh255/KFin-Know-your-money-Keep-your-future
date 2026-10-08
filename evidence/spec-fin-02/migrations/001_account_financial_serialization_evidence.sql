-- SPEC-FIN-02 evidence schema, version 001.
-- The harness sets search_path to an isolated kfin_fin02_* schema before running this file.
-- Synthetic evidence data only. This is not an application or production migration.

CREATE TABLE evidence_schema_migrations (
    version TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE synthetic_users (
    id UUID PRIMARY KEY,
    email_token TEXT NOT NULL UNIQUE CHECK (email_token ~ '^synthetic-[a-f0-9]{12}$'),
    timezone TEXT NOT NULL DEFAULT 'UTC',
    base_currency CHAR(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE financial_accounts (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES synthetic_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Synthetic aggregate account',
    account_type TEXT NOT NULL DEFAULT 'aggregate_liquid'
        CHECK (account_type = 'aggregate_liquid'),
    currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    financial_state_version BIGINT NOT NULL
        CHECK (financial_state_version >= 1 AND financial_state_version < 9223372036854775807),
    metadata_version INTEGER NOT NULL DEFAULT 1 CHECK (metadata_version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (user_id, id),
    UNIQUE (user_id, id, currency)
);

CREATE TABLE balance_snapshots (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    account_id UUID NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    effective_at TIMESTAMPTZ NOT NULL,
    effective_local_date DATE NOT NULL,
    timezone TEXT NOT NULL,
    reason TEXT NOT NULL
        CHECK (reason IN ('onboarding', 'manual_balance_update', 'recovery_correction')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    correlation_token TEXT NOT NULL CHECK (length(correlation_token) BETWEEN 8 AND 64),
    UNIQUE (account_id, effective_at),
    UNIQUE (user_id, account_id, id),
    UNIQUE (user_id, account_id, id, currency),
    FOREIGN KEY (user_id, account_id, currency)
        REFERENCES financial_accounts(user_id, id, currency) ON DELETE CASCADE
);

CREATE INDEX balance_snapshots_latest_idx
    ON balance_snapshots (user_id, account_id, effective_at DESC, id DESC);

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
    status TEXT NOT NULL CHECK (status IN ('posted', 'voided')),
    voided_at TIMESTAMPTZ,
    void_reason TEXT,
    supersedes_transaction_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    correlation_token TEXT NOT NULL CHECK (length(correlation_token) BETWEEN 8 AND 64),
    CHECK (
        (balance_effect = 'historical' AND already_included_in_snapshot)
        OR (balance_effect = 'current' AND NOT already_included_in_snapshot)
    ),
    CHECK (
        (status = 'posted' AND voided_at IS NULL)
        OR (status = 'voided' AND voided_at IS NOT NULL)
    ),
    CHECK (supersedes_transaction_id IS NULL OR supersedes_transaction_id <> id),
    UNIQUE (supersedes_transaction_id),
    UNIQUE (user_id, account_id, id),
    FOREIGN KEY (user_id, account_id, balance_snapshot_id, currency)
        REFERENCES balance_snapshots(user_id, account_id, id, currency) ON DELETE CASCADE,
    FOREIGN KEY (supersedes_transaction_id)
        REFERENCES transactions(id)
);

CREATE INDEX transactions_account_state_idx
    ON transactions (user_id, account_id, balance_snapshot_id, status, id);

CREATE TABLE scheduled_occurrences (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    account_id UUID NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('scheduled', 'confirmed', 'skipped', 'cancelled')),
    confirmed_transaction_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (confirmed_transaction_id),
    UNIQUE (user_id, account_id, id),
    FOREIGN KEY (user_id, account_id)
        REFERENCES financial_accounts(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, account_id, confirmed_transaction_id)
        REFERENCES transactions(user_id, account_id, id)
        DEFERRABLE INITIALLY IMMEDIATE,
    CHECK (
        (state = 'confirmed' AND confirmed_transaction_id IS NOT NULL)
        OR (state <> 'confirmed' AND confirmed_transaction_id IS NULL)
    )
);

CREATE TABLE idempotency_keys (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    account_id UUID NOT NULL,
    operation TEXT NOT NULL,
    key_digest TEXT NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
    request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
    prior_financial_state_version BIGINT,
    committed_financial_state_version BIGINT,
    response_status TEXT NOT NULL CHECK (response_status IN ('committed', 'stale')),
    response_code TEXT NOT NULL,
    response_reference UUID,
    result JSONB NOT NULL,
    correlation_token TEXT NOT NULL CHECK (length(correlation_token) BETWEEN 8 AND 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '24 hours'),
    UNIQUE (user_id, account_id, operation, key_digest),
    FOREIGN KEY (user_id, account_id)
        REFERENCES financial_accounts(user_id, id) ON DELETE CASCADE
);

CREATE INDEX idempotency_lookup_idx
    ON idempotency_keys (user_id, account_id, operation, key_digest);

CREATE TABLE audit_events (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    account_id UUID NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID,
    outcome TEXT NOT NULL,
    correlation_token TEXT NOT NULL CHECK (length(correlation_token) BETWEEN 8 AND 64),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (user_id, account_id)
        REFERENCES financial_accounts(user_id, id) ON DELETE CASCADE
);

-- Dedicated rows used only to create deterministic real PostgreSQL lock timeouts.
CREATE TABLE evidence_fault_locks (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL UNIQUE
);

INSERT INTO evidence_fault_locks (id, label)
VALUES (1, 'lock-timeout-a'), (2, 'lock-timeout-b');

-- Deterministic server-side SQLSTATE injection for retry-policy evidence.
-- 55P03 and 57014 are exercised through real lock/statement cancellation instead.
CREATE OR REPLACE FUNCTION evidence_raise_sqlstate(requested_code TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    IF requested_code NOT IN ('40P01', '40001') THEN
        RAISE EXCEPTION 'unsupported evidence SQLSTATE'
            USING ERRCODE = '22023';
    END IF;
    RAISE EXCEPTION 'synthetic PostgreSQL evidence fault'
        USING ERRCODE = requested_code;
END;
$$;

CREATE OR REPLACE FUNCTION evidence_immutable_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('kfin.evidence_cleanup', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'immutable evidence row'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER balance_snapshots_immutable
BEFORE UPDATE OR DELETE ON balance_snapshots
FOR EACH ROW EXECUTE FUNCTION evidence_immutable_row();

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION evidence_immutable_row();
