import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../migrations/0001_financial_foundation.sql', import.meta.url);
const scheduleMigrationUrl = new URL(
  '../migrations/0002_one_off_schedule_occurrences.sql',
  import.meta.url,
);
const aggregateMigrationUrl = new URL(
  '../migrations/0003_financial_aggregate_bounds.sql',
  import.meta.url,
);
const accessMigrationUrl = new URL(
  '../migrations/0004_trusted_private_beta_access.sql',
  import.meta.url,
);
const correctionSourceUrl = new URL('../src/transaction-corrections.ts', import.meta.url);

describe('reviewed financial foundation migration', () => {
  it('defines owner/currency/snapshot composite integrity and one account per user', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('CONSTRAINT financial_accounts_user_uq UNIQUE (user_id)');
    expect(sql).toContain('FOREIGN KEY (user_id, account_id, balance_snapshot_id, currency)');
    expect(sql).toContain('REFERENCES balance_snapshots(user_id, account_id, id, currency)');
    expect(sql).toContain('FOREIGN KEY (category_id, kind) REFERENCES categories(id, transaction_kind)');
  });

  it('makes snapshots and audit rows immutable and transaction facts append-only', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('balance_snapshots_immutable_trg');
    expect(sql).toContain('audit_events_immutable_trg');
    expect(sql).toContain('transactions_history_trg');
    expect(sql).toContain('transactions_successor_uq');
    expect(sql).toContain('transaction financial facts are immutable');
  });

  it('stores bigint money and implements the latest-segment current-balance view', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toMatch(/amount_minor BIGINT NOT NULL/g);
    expect(sql).toContain('CREATE VIEW financial_current_balances');
    expect(sql).toContain('txn.balance_snapshot_id = snapshot.id');
    expect(sql).toContain("txn.balance_effect = 'current'");
    expect(sql).toContain("txn.status = 'posted'");
  });

  it('uses digest-only idempotency scope with bounded result JSON', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('key_digest CHAR(64)');
    expect(sql).toContain('request_digest CHAR(64)');
    expect(sql).toContain('idempotency_results_account_scope_uq');
    expect(sql).toContain('idempotency_results_user_scope_uq');
    expect(sql).toContain('pg_column_size(result) <= 4096');
    expect(sql).not.toMatch(/raw_(?:idempotency_)?key/i);
  });
});

describe('one-off schedule occurrence migration', () => {
  it('persists only the accepted occurrence states and an explicit confirmation link', async () => {
    const sql = await readFile(scheduleMigrationUrl, 'utf8');
    expect(sql).toContain("state IN ('scheduled', 'confirmed', 'skipped', 'cancelled')");
    expect(sql).not.toMatch(/state[^\n]*(?:paid|received|due_today|overdue)/i);
    expect(sql).toContain('scheduled_occurrences_confirmed_transaction_uq');
    expect(sql).toContain('confirmed occurrence requires one compatible posted transaction');
    expect(sql).toContain('transactions_schedule_link_guard_trg');
    expect(sql).toContain('a schedule-linked transaction pointer must be transferred before void');
  });

  it('binds item, occurrence, account, currency, direction, and transaction ownership', async () => {
    const sql = await readFile(scheduleMigrationUrl, 'utf8');
    expect(sql).toContain('FOREIGN KEY (user_id, account_id, scheduled_item_id, currency, transaction_kind)');
    expect(sql).toContain('REFERENCES scheduled_items(user_id, account_id, id, currency, transaction_kind)');
    expect(sql).toContain('FOREIGN KEY (user_id, account_id, confirmed_transaction_id)');
    expect(sql).toContain('REFERENCES transactions(user_id, account_id, id)');
  });

  it('fixes this slice to one-off explicit confirmation and append-only occurrence authority', async () => {
    const sql = await readFile(scheduleMigrationUrl, 'utf8');
    expect(sql).toContain("frequency TEXT NOT NULL DEFAULT 'one_off' CHECK (frequency = 'one_off')");
    expect(sql).toContain("confirmation_policy TEXT NOT NULL DEFAULT 'explicit'");
    expect(sql).toContain('scheduled occurrence authority fields are immutable');
    expect(sql).toContain('terminal scheduled occurrence state is immutable');
  });
});


describe('financial remediation invariants', () => {
  it('defers database aggregate-range validation until each transaction reaches its final state', async () => {
    const sql = await readFile(aggregateMigrationUrl, 'utf8');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('current_balance > 9223372036854775807');
    expect(sql).toContain('monthly_income - monthly_expense');
    expect(sql).toContain("ERRCODE = '22003'");
  });

  it('does not acquire a second source-snapshot lock after locking the correction transaction', async () => {
    const source = await readFile(correctionSourceUrl, 'utf8');
    const correctionLock = source.slice(
      source.indexOf('async function lockCorrectionSource'),
      source.indexOf('function validateReviewedSource'),
    );
    expect(correctionLock).toContain('FOR UPDATE OF txn');
    expect(correctionLock).not.toContain('FOR UPDATE OF source_snapshot');
    expect(correctionLock).not.toMatch(/SELECT id\s+FROM balance_snapshots/);
  });
});

describe('trusted private beta access migration', () => {
  it('stores every secret as a digest and never persists a plaintext column', async () => {
    const sql = await readFile(accessMigrationUrl, 'utf8');
    expect(sql).toContain('code_digest BYTEA NOT NULL');
    expect(sql).toContain('secret_digest BYTEA NOT NULL');
    expect(sql).toContain('token_digest BYTEA NOT NULL');
    expect(sql).toContain('csrf_digest BYTEA NOT NULL');
    expect(sql).toContain('scope_digest BYTEA NOT NULL');
    expect(sql).not.toMatch(/\b(?:code|otp|token|secret|password)\s+TEXT\b/i);
    expect(sql).not.toMatch(/password_hash\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\([^)]*'\$argon2id\$%'\)/);
  });

  it('binds Argon2id credentials and prevents invitation reuse', async () => {
    const sql = await readFile(accessMigrationUrl, 'utf8');
    expect(sql).toContain("password_hash LIKE '$argon2id$%'");
    expect(sql).toContain('CONSTRAINT beta_invitations_code_digest_uq UNIQUE (code_digest)');
    expect(sql).toContain('a consumed or revoked invitation is terminal');
    expect(sql).toContain('a consumed invitation cannot be reassigned');
    expect(sql).toContain('beta_invitations_terminal_guard_trg');
  });

  it('keeps one active challenge per user and purpose with monotonic attempts', async () => {
    const sql = await readFile(accessMigrationUrl, 'utf8');
    expect(sql).toContain('CREATE UNIQUE INDEX auth_challenges_one_active_uq');
    expect(sql).toContain('a consumed auth challenge is immutable');
    expect(sql).toContain('auth challenge attempt count cannot decrease');
    expect(sql).toContain('auth challenge purpose and secret digest are immutable');
  });

  it('enforces session revocation, rotation, and replay containment', async () => {
    const sql = await readFile(accessMigrationUrl, 'utf8');
    expect(sql).toContain('CONSTRAINT session_tokens_generation_uq UNIQUE (session_id, generation)');
    expect(sql).toContain('CONSTRAINT sessions_revocation_ck CHECK');
    expect(sql).toContain('a revoked session cannot be restored');
    expect(sql).toContain('CONSTRAINT session_tokens_grace_ck CHECK');
  });

  it('makes security history append-only and free of secret metadata', async () => {
    const sql = await readFile(accessMigrationUrl, 'utf8');
    expect(sql).toContain('security events are append-only');
    expect(sql).toContain("NOT (metadata ?| ARRAY['password', 'otp', 'code', 'token', 'secret', 'sessionToken'])");
    expect(sql).toContain('pg_column_size(metadata) <= 2048');
    expect(sql).toContain("visibility IN ('user', 'operator', 'both')");
  });

  it('bounds abuse counters with a digest-only composite key', async () => {
    const sql = await readFile(accessMigrationUrl, 'utf8');
    expect(sql).toContain('PRIMARY KEY (scope_kind, scope_digest, window_start)');
    expect(sql).toMatch(/scope_kind IN \(\s*'login_target'/);
    expect(sql).toContain('CREATE INDEX auth_attempt_counters_window_idx');
  });
});

const savingsMigrationUrl = new URL('../migrations/0005_savings_goals.sql', import.meta.url);
const savingsHistoryChainMigrationUrl = new URL(
  '../migrations/0006_savings_history_chain.sql',
  import.meta.url,
);

describe('savings goals migration', () => {
  it('stores bigint reserve amounts in the user base currency with status and version', async () => {
    const sql = await readFile(savingsMigrationUrl, 'utf8');
    expect(sql).toContain('current_amount_minor BIGINT NOT NULL CHECK (current_amount_minor >= 0)');
    expect(sql).toContain('target_amount_minor BIGINT NOT NULL CHECK (target_amount_minor > 0)');
    expect(sql).toContain('REFERENCES users(id, base_currency)');
    expect(sql).toContain("status IN ('active', 'archived')");
    expect(sql).toContain('CREATE INDEX savings_goals_owner_status_idx');
  });

  it('keeps amount history immutable and tied one-to-one to goal versions', async () => {
    const sql = await readFile(savingsMigrationUrl, 'utf8');
    expect(sql).toContain('savings_amount_changes_immutable_trg');
    expect(sql).toContain('UNIQUE (savings_goal_id, goal_version)');
    expect(sql).toContain("source IN ('initial', 'manual_update', 'planned_purchase_use', 'recovery_correction')");
    expect(sql).toContain("(source = 'planned_purchase_use') = (planned_purchase_id IS NOT NULL)");
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('archived savings goals are terminal');
  });

  it('never references balances, snapshots, or transactions', async () => {
    const sql = await readFile(savingsMigrationUrl, 'utf8')
      .then((text) => text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n'));
    expect(sql).not.toMatch(/financial_accounts|balance_snapshots|transactions|financial_current_balances/);
  });

  it('is frozen: migration 0005 keeps the exact reviewed checksum', async () => {
    const { createHash } = await import('node:crypto');
    const sql = await readFile(savingsMigrationUrl, 'utf8');
    expect(createHash('sha256').update(sql, 'utf8').digest('hex')).toBe(
      '58f264e35dbad3744489dc72378b8f658a73de6465615d4c9ef4eda05983918e',
    );
  });
});

describe('savings history chain migration (QA addendum F-2/F-3)', () => {
  it('only replaces the existing amount-change guard function; it creates no table and changes no other object', async () => {
    const sql = await readFile(savingsHistoryChainMigrationUrl, 'utf8')
      .then((text) => text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n'));
    expect(sql).toContain('CREATE OR REPLACE FUNCTION kfin_guard_savings_amount_change()');
    expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE|CREATE TRIGGER/i);
    expect(sql).not.toMatch(/financial_accounts|balance_snapshots|transactions|financial_current_balances/);
  });

  it('pins every later change row to the newest earlier row of the goal history chain (F-2)', async () => {
    const sql = await readFile(savingsHistoryChainMigrationUrl, 'utf8');
    expect(sql).toContain('change.goal_version < NEW.goal_version');
    expect(sql).toContain('ORDER BY change.goal_version DESC');
    expect(sql).toContain('chain_amount IS DISTINCT FROM NEW.previous_amount_minor');
    expect(sql).toContain('savings amount change must continue the goal history chain');
  });

  it('requires a user actor to be the goal owner (F-3)', async () => {
    const sql = await readFile(savingsHistoryChainMigrationUrl, 'utf8');
    expect(sql).toContain('NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id <> NEW.user_id');
    expect(sql).toContain('savings amount change user actor must be the goal owner');
  });
});
