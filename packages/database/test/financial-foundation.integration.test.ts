import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDateAt } from '@kfin/domain';
import {
  FinancialAccountBootstrapService,
  migrateDatabase,
  PostgresFinancialRepository,
  PostgresUserRepository,
} from '../src/index.js';

const integrationEnabled = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.KFIN_INTEGRATION_TARGET === 'non-production',
);

const integration = describe.skipIf(!integrationEnabled);

integration('financial foundation on real PostgreSQL', () => {
  let administration: Pool;
  let database: Pool;
  let schema: string;

  beforeAll(async () => {
    schema = `kfin_it_${randomUUID().replaceAll('-', '')}`;
    administration = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await administration.query(`CREATE SCHEMA ${schema}`);
    database = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
      options: `-c search_path=${schema},public`,
    });
    await migrateDatabase(database);
  }, 60_000);

  afterAll(async () => {
    if (database) await database.end();
    if (administration && schema) {
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administration.end();
    }
  }, 30_000);

  it('migrates, bootstraps, serializes, replays, isolates owners, and starts a new segment', async () => {
    const now = new Date();
    const initialInstant = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1_000);
    const userRepository = new PostgresUserRepository(database);
    const owner = await userRepository.create({
      email: `owner-${randomUUID()}@example.invalid`,
      locale: 'en-VN',
      timezone: 'Asia/Ho_Chi_Minh',
      baseCurrency: 'VND',
      emailVerifiedAt: new Date(now.getTime() - 10_000),
    });
    const other = await userRepository.create({
      email: `other-${randomUUID()}@example.invalid`,
      locale: 'en-VN',
      timezone: 'Asia/Ho_Chi_Minh',
      baseCurrency: 'VND',
      emailVerifiedAt: new Date(now.getTime() - 10_000),
    });

    const bootstrap = new FinancialAccountBootstrapService(database);
    const foundation = await bootstrap.bootstrap({
      ownerUserId: owner.id,
      openingAmountMinor: '1000000',
      effectiveAt: initialInstant,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      idempotencyRetentionMs: 86_400_000,
    });
    expect(foundation.financialStateVersion).toBe('1');

    const repository = new PostgresFinancialRepository(database, 86_400_000, () => now);
    const key = randomUUID();
    const transactionInput = {
      kind: 'expense' as const,
      amountMinor: '250000',
      occurredOn: localDateAt(now, owner.timezone),
      categoryCode: 'food',
      expenseClass: 'daily' as const,
      isUnexpected: false,
      expectedFinancialStateVersion: '1',
      reviewedLatestSnapshotId: foundation.snapshotId,
    };
    const created = await repository.createTransaction(owner.id, transactionInput, key, randomUUID());
    expect(created).toMatchObject({ financialStateVersion: '2' });
    expect((await repository.getCurrentBalance(owner.id)).currentBalanceMinor).toBe('750000');

    const replayed = await repository.createTransaction(owner.id, transactionInput, key, randomUUID());
    expect(replayed).toEqual(created);
    const receipt = await database.query<{ result: Record<string, unknown> }>(`
      SELECT result FROM idempotency_results
      WHERE user_id = $1 AND operation = 'financial.transaction.create'
    `, [owner.id]);
    expect(receipt.rows[0]?.result).toEqual({
      transactionId: created.transactionId,
      financialStateVersion: '2',
    });
    expect(JSON.stringify(receipt.rows[0]?.result)).not.toContain('250000');
    await expect(repository.getTransaction(other.id, created.transactionId)).rejects.toMatchObject({
      code: 'FINANCIAL_RESOURCE_UNAVAILABLE',
    });

    const newSnapshotInstant = new Date(now.getTime() - 1_000);
    const newSnapshot = await repository.createSnapshot(owner.id, {
      amountMinor: '500000',
      effectiveAt: newSnapshotInstant.toISOString(),
      expectedFinancialStateVersion: '2',
      reviewedLatestSnapshotId: foundation.snapshotId,
    }, randomUUID(), randomUUID());
    expect(newSnapshot).toMatchObject({
      financialStateVersion: '3',
    });
    expect((await repository.getCurrentBalance(owner.id)).currentBalanceMinor).toBe('500000');

    await expect(repository.createTransaction(owner.id, {
      ...transactionInput,
      amountMinor: '1',
      expectedFinancialStateVersion: '2',
    }, randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'FINANCIAL_STATE_STALE' });
    expect((await repository.getCurrentBalance(owner.id)).financialStateVersion).toBe('3');
  }, 30_000);
});
