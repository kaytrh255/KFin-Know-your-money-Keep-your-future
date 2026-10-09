import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDateAt } from '@kfin/domain';
import {
  migrateDatabase,
  PostgresFinancialRepository,
  PostgresUserRepository,
  type UserRecord,
} from '../src/index.js';

/**
 * Milestone 05 — authenticated financial-account onboarding and listing
 * against real PostgreSQL. Each run uses an isolated schema that is dropped
 * afterwards. Skipped (never faked) without an explicit non-production target.
 */

const PREVIEW_SIGNING_KEY = 'cd'.repeat(32);

const integrationEnabled = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.KFIN_INTEGRATION_TARGET === 'non-production',
);

const integration = describe.skipIf(!integrationEnabled);

integration('financial-account onboarding on real PostgreSQL', () => {
  let administration: Pool;
  let database: Pool;
  let schema: string;
  let repository: PostgresFinancialRepository;
  let users: PostgresUserRepository;

  const opening = (amount = '1000000', ageMs = 2 * 24 * 60 * 60 * 1_000) => ({
    openingBalanceMinor: amount,
    effectiveAt: new Date(Date.now() - ageMs).toISOString(),
  });

  const verifiedUser = async (): Promise<UserRecord> => users.create({
    email: `m05-${randomUUID()}@example.invalid`,
    locale: 'vi-VN',
    timezone: 'Asia/Ho_Chi_Minh',
    baseCurrency: 'VND',
    emailVerifiedAt: new Date(Date.now() - 60_000),
  });

  const counts = async (userId: string) => {
    const result = await database.query<{
      accounts: string; snapshots: string; receipts: string; audits: string;
    }>(`
      SELECT
        (SELECT count(*) FROM financial_accounts WHERE user_id = $1) AS accounts,
        (SELECT count(*) FROM balance_snapshots WHERE user_id = $1) AS snapshots,
        (SELECT count(*) FROM idempotency_results
          WHERE user_id = $1 AND operation = 'financial.account.bootstrap') AS receipts,
        (SELECT count(*) FROM audit_events
          WHERE user_id = $1 AND action = 'financial.account.bootstrap') AS audits
    `, [userId]);
    const row = result.rows[0]!;
    return {
      accounts: Number(row.accounts),
      snapshots: Number(row.snapshots),
      receipts: Number(row.receipts),
      audits: Number(row.audits),
    };
  };

  beforeAll(async () => {
    schema = `kfin_m05_${randomUUID().replaceAll('-', '')}`;
    administration = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await administration.query(`CREATE SCHEMA ${schema}`);
    database = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 6,
      options: `-c search_path=${schema},public`,
    });
    await migrateDatabase(database);
    repository = new PostgresFinancialRepository(database, 86_400_000, PREVIEW_SIGNING_KEY);
    users = new PostgresUserRepository(database);
  }, 60_000);

  afterAll(async () => {
    if (database) await database.end();
    if (administration && schema) {
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administration.end();
    }
  }, 30_000);

  it('atomically creates the account, onboarding snapshot, receipt, and audit event', async () => {
    const owner = await verifiedUser();
    const input = opening('1000000');
    const result = await repository.openFinancialAccount(owner.id, input, randomUUID(), randomUUID());
    expect(result).toMatchObject({ financialStateVersion: '1', replayed: false });

    expect(await counts(owner.id)).toEqual({ accounts: 1, snapshots: 1, receipts: 1, audits: 1 });
    const account = await database.query<{ user_id: string; currency: string; account_type: string }>(
      'SELECT user_id, currency, account_type FROM financial_accounts WHERE id = $1',
      [result.accountId],
    );
    expect(account.rows[0]).toEqual({ user_id: owner.id, currency: 'VND', account_type: 'aggregate_liquid' });
    const snapshot = await database.query<{ reason: string; amount_minor: string; account_id: string }>(
      'SELECT reason, amount_minor, account_id FROM balance_snapshots WHERE id = $1',
      [result.snapshotId],
    );
    expect(snapshot.rows[0]).toEqual({ reason: 'onboarding', amount_minor: '1000000', account_id: result.accountId });

    const receipt = await database.query<{ result: Record<string, unknown>; key_digest: string }>(`
      SELECT result, key_digest FROM idempotency_results
      WHERE user_id = $1 AND operation = 'financial.account.bootstrap'
    `, [owner.id]);
    expect(receipt.rows[0]?.result).toEqual({
      accountId: result.accountId,
      snapshotId: result.snapshotId,
      financialStateVersion: '1',
    });
    // Digest-only receipt: no raw amount in the stored result.
    expect(JSON.stringify(receipt.rows[0]?.result)).not.toContain('1000000');
  }, 30_000);

  it('rolls back every row when any step of the onboarding transaction fails', async () => {
    const owner = await verifiedUser();
    const key = randomUUID();
    // Inject a failure on the last insert of the transaction, for this owner only.
    await database.query(`
      CREATE FUNCTION ${schema}.m05_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id = '${owner.id}'::uuid THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'injected onboarding failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER m05_fail_audit BEFORE INSERT ON ${schema}.audit_events
        FOR EACH ROW EXECUTE FUNCTION ${schema}.m05_fail_audit();
    `);
    try {
      await expect(repository.openFinancialAccount(owner.id, opening(), key, randomUUID()))
        .rejects.toMatchObject({ statusCode: 503 });
      expect(await counts(owner.id)).toEqual({ accounts: 0, snapshots: 0, receipts: 0, audits: 0 });
    } finally {
      await database.query(`
        DROP TRIGGER m05_fail_audit ON ${schema}.audit_events;
        DROP FUNCTION ${schema}.m05_fail_audit();
      `);
    }
    // The same key is not poisoned by the rolled-back attempt.
    const retried = await repository.openFinancialAccount(owner.id, opening(), key, randomUUID());
    expect(retried.replayed).toBe(false);
    expect(await counts(owner.id)).toEqual({ accounts: 1, snapshots: 1, receipts: 1, audits: 1 });
  }, 30_000);

  it('replays a same-key same-payload request without creating rows', async () => {
    const owner = await verifiedUser();
    const key = randomUUID();
    const input = opening('500000');
    const first = await repository.openFinancialAccount(owner.id, input, key, randomUUID());
    const second = await repository.openFinancialAccount(owner.id, input, key, randomUUID());
    expect(second).toEqual({ ...first, replayed: true });
    expect(await counts(owner.id)).toEqual({ accounts: 1, snapshots: 1, receipts: 1, audits: 1 });
  }, 30_000);

  it('rejects a same-key different-payload request as IDEMPOTENCY_KEY_REUSED', async () => {
    const owner = await verifiedUser();
    const key = randomUUID();
    const input = opening('500000');
    await repository.openFinancialAccount(owner.id, input, key, randomUUID());
    await expect(repository.openFinancialAccount(owner.id, { ...input, openingBalanceMinor: '500001' }, key, randomUUID()))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
    expect(await counts(owner.id)).toEqual({ accounts: 1, snapshots: 1, receipts: 1, audits: 1 });
  }, 30_000);

  it('returns 409 FIN_ACCOUNT_ALREADY_EXISTS for a second onboarding with a new key', async () => {
    const owner = await verifiedUser();
    await repository.openFinancialAccount(owner.id, opening(), randomUUID(), randomUUID());
    await expect(repository.openFinancialAccount(owner.id, opening('42'), randomUUID(), randomUUID()))
      .rejects.toMatchObject({ code: 'FIN_ACCOUNT_ALREADY_EXISTS', statusCode: 409 });
    expect(await counts(owner.id)).toEqual({ accounts: 1, snapshots: 1, receipts: 1, audits: 1 });
  }, 30_000);

  it('serializes concurrent onboarding: different keys yield one account and one 409', async () => {
    const owner = await verifiedUser();
    const outcomes = await Promise.allSettled([
      repository.openFinancialAccount(owner.id, opening('100'), randomUUID(), randomUUID()),
      repository.openFinancialAccount(owner.id, opening('200'), randomUUID(), randomUUID()),
      repository.openFinancialAccount(owner.id, opening('300'), randomUUID(), randomUUID()),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const outcome of rejected) {
      expect(outcome.reason).toMatchObject({ code: 'FIN_ACCOUNT_ALREADY_EXISTS', statusCode: 409 });
    }
    expect(await counts(owner.id)).toEqual({ accounts: 1, snapshots: 1, receipts: 1, audits: 1 });
  }, 30_000);

  it('serializes concurrent same-key retries to one committed result', async () => {
    const owner = await verifiedUser();
    const key = randomUUID();
    const input = opening('777');
    const results = await Promise.all([
      repository.openFinancialAccount(owner.id, input, key, randomUUID()),
      repository.openFinancialAccount(owner.id, input, key, randomUUID()),
    ]);
    expect(results[0]?.accountId).toBe(results[1]?.accountId);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(await counts(owner.id)).toEqual({ accounts: 1, snapshots: 1, receipts: 1, audits: 1 });
  }, 30_000);

  it('returns 404 for an unknown owner and for an unverified owner without writing', async () => {
    const unknownOwner = randomUUID();
    await expect(repository.openFinancialAccount(unknownOwner, opening(), randomUUID(), randomUUID()))
      .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE', statusCode: 404 });
    expect(await counts(unknownOwner)).toEqual({ accounts: 0, snapshots: 0, receipts: 0, audits: 0 });

    const unverified = await users.create({
      email: `m05-unverified-${randomUUID()}@example.invalid`,
      locale: 'vi-VN',
      timezone: 'Asia/Ho_Chi_Minh',
      baseCurrency: 'VND',
    });
    expect(unverified.status).toBe('pending_verification');
    await expect(repository.openFinancialAccount(unverified.id, opening(), randomUUID(), randomUUID()))
      .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE', statusCode: 404 });
    expect(await counts(unverified.id)).toEqual({ accounts: 0, snapshots: 0, receipts: 0, audits: 0 });
  }, 30_000);

  it('rejects an invalid opening balance with 422 and writes nothing', async () => {
    const owner = await verifiedUser();
    await expect(repository.openFinancialAccount(owner.id, opening('12.50'), randomUUID(), randomUUID()))
      .rejects.toMatchObject({ code: 'FIN_OPENING_BALANCE_INVALID', statusCode: 422 });
    await expect(repository.openFinancialAccount(owner.id, {
      openingBalanceMinor: '1000',
      effectiveAt: new Date(Date.now() + 60_000).toISOString(),
    }, randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'FIN_OPENING_BALANCE_INVALID', statusCode: 422 });
    expect(await counts(owner.id)).toEqual({ accounts: 0, snapshots: 0, receipts: 0, audits: 0 });
  }, 30_000);

  it('lists only the owner accounts and reads balances from financial_current_balances', async () => {
    const owner = await verifiedUser();
    const other = await verifiedUser();
    const outsider = await verifiedUser();
    const opened = await repository.openFinancialAccount(owner.id, opening('1000000'), randomUUID(), randomUUID());
    const otherOpened = await repository.openFinancialAccount(other.id, opening('-50000'), randomUUID(), randomUUID());

    const initial = await repository.listFinancialAccounts(owner.id);
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0]).toMatchObject({
      accountId: opened.accountId,
      name: 'Aggregate liquid account',
      accountType: 'aggregate_liquid',
      currency: 'VND',
      financialStateVersion: '1',
      snapshot: { id: opened.snapshotId, amountMinor: '1000000' },
      postedCurrentIncomeMinor: '0',
      postedCurrentExpenseMinor: '0',
      currentBalanceMinor: '1000000',
    });

    const now = new Date();
    const today = localDateAt(now, owner.timezone);
    const expense = await repository.createTransaction(owner.id, {
      kind: 'expense', amountMinor: '250000', occurredOn: today,
      categoryCode: 'food', expenseClass: 'daily', isUnexpected: false,
      expectedFinancialStateVersion: '1', reviewedLatestSnapshotId: opened.snapshotId,
    }, randomUUID(), randomUUID());
    await repository.createTransaction(owner.id, {
      kind: 'income', amountMinor: '40000', occurredOn: today,
      categoryCode: 'income_other', isUnexpected: false,
      expectedFinancialStateVersion: expense.financialStateVersion,
      reviewedLatestSnapshotId: opened.snapshotId,
    }, randomUUID(), randomUUID());

    const afterActivity = await repository.listFinancialAccounts(owner.id);
    expect(afterActivity.items[0]).toMatchObject({
      financialStateVersion: '3',
      postedCurrentIncomeMinor: '40000',
      postedCurrentExpenseMinor: '250000',
      currentBalanceMinor: '790000',
    });
    // The list balance is exactly the authoritative view and the existing balance endpoint.
    const view = await database.query<{ current_balance_minor: string }>(
      'SELECT current_balance_minor::text FROM financial_current_balances WHERE user_id = $1',
      [owner.id],
    );
    expect(afterActivity.items[0]?.currentBalanceMinor).toBe(view.rows[0]?.current_balance_minor);
    const { name: _name, accountType: _type, ...balanceShape } = afterActivity.items[0]!;
    expect(balanceShape).toEqual(await repository.getCurrentBalance(owner.id));

    // Owner isolation: neither owner sees the other, and an account-less owner sees nothing.
    const otherList = await repository.listFinancialAccounts(other.id);
    expect(otherList.items.map((item) => item.accountId)).toEqual([otherOpened.accountId]);
    expect(otherList.items[0]?.currentBalanceMinor).toBe('-50000');
    expect(otherList.items.map((item) => item.accountId)).not.toContain(opened.accountId);
    expect((await repository.listFinancialAccounts(outsider.id)).items).toEqual([]);
    expect((await repository.listFinancialAccounts(randomUUID())).items).toEqual([]);
  }, 30_000);
});
