import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../migrations/0001_financial_foundation.sql', import.meta.url);
const scheduleMigrationUrl = new URL(
  '../migrations/0002_one_off_schedule_occurrences.sql',
  import.meta.url,
);

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
