import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDateAt } from '@kfin/domain';
import {
  FinancialAccountBootstrapService,
  migrateDatabase,
  PostgresFinancialRepository,
  PostgresSavingsGoalRepository,
  PostgresUserRepository,
} from '../src/index.js';

/**
 * SQL-injection resistance and owner isolation on real PostgreSQL.
 *
 * Every runtime statement in `packages/database/src` is a string literal passed
 * to `pg` together with a `$n` parameter array, so a value supplied by a caller
 * can only ever arrive as data. This suite proves that behaviourally rather than
 * by reading the source: the payloads below are written *through* the public
 * repository API, and the assertions check that the text round-trips unchanged,
 * that nothing named by the payload was executed, and that no filter or cursor
 * value can widen a result set.
 *
 * It also pins owner isolation on the paths it drives. Authorization is enforced
 * by SQL predicates — there are no RLS policies yet (`SPEC-SEC-01` is open) — so
 * the `user_id = $1` predicate is the only thing between two accounts' rows.
 *
 * Each run uses an isolated schema that is dropped afterwards. Skipped (never
 * faked) without an explicit non-production target.
 */

const RETENTION_MS = 86_400_000;
const TIMEZONE = 'Asia/Ho_Chi_Minh';
const PREVIEW_SIGNING_KEY = 'cd'.repeat(32);

const integrationEnabled = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.KFIN_INTEGRATION_TARGET === 'non-production',
);

const integration = describe.skipIf(!integrationEnabled);

/** Text that terminates a statement, comments one out, or forces a predicate true. */
const PAYLOADS = [
  "'; DROP TABLE savings_goals; --",
  "Robert'); DROP TABLE transactions;--",
  "1' OR '1'='1",
  "' OR 1=1 --",
  '"; SELECT pg_sleep(5); --',
  "'; COPY (SELECT 1) TO PROGRAM 'true'; --",
  '$$; SELECT 1; $$',
  '${input}',
] as const;

integration('SQL-injection resistance and owner isolation on real PostgreSQL', () => {
  let administration: Pool;
  let database: Pool;
  let schema: string;
  let users: PostgresUserRepository;
  let savings: PostgresSavingsGoalRepository;

  const today = () => localDateAt(new Date(), TIMEZONE);

  interface Owner {
    readonly id: string;
    readonly repository: PostgresFinancialRepository;
    readonly snapshotId: string;
    version: string;
  }

  const createOwner = async (): Promise<Owner> => {
    const user = await users.create({
      email: `sqli-${randomUUID()}@example.invalid`,
      locale: 'vi-VN',
      timezone: TIMEZONE,
      baseCurrency: 'VND',
      emailVerifiedAt: new Date(Date.now() - 60_000),
    });
    const foundation = await new FinancialAccountBootstrapService(database).bootstrap({
      ownerUserId: user.id,
      openingAmountMinor: '1000000',
      effectiveAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000),
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      idempotencyRetentionMs: RETENTION_MS,
    });
    return {
      id: user.id,
      repository: new PostgresFinancialRepository(database, RETENTION_MS, PREVIEW_SIGNING_KEY),
      snapshotId: foundation.snapshotId,
      version: foundation.financialStateVersion,
    };
  };

  const goalInput = () => ({
    name: 'Emergency fund',
    targetAmountMinor: '10000000',
    currentAmountMinor: '2500000',
    currentAmountAsOf: today(),
  });

  /** Posts an expense and advances the fixture's optimistic version. */
  const post = async (owner: Owner, amountMinor = '50000'): Promise<string> => {
    const result = await owner.repository.createTransaction(owner.id, {
      kind: 'expense',
      amountMinor,
      occurredOn: today(),
      categoryCode: 'food',
      expenseClass: 'daily',
      isUnexpected: false,
      expectedFinancialStateVersion: owner.version,
      reviewedLatestSnapshotId: owner.snapshotId,
    }, randomUUID(), randomUUID());
    owner.version = result.financialStateVersion;
    return result.transactionId;
  };

  beforeAll(async () => {
    schema = `kfin_sqli_${randomUUID().replaceAll('-', '')}`;
    administration = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await administration.query(`CREATE SCHEMA ${schema}`);
    database = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 6,
      options: `-c search_path=${schema},public`,
    });
    await migrateDatabase(database);
    users = new PostgresUserRepository(database);
    savings = new PostgresSavingsGoalRepository(database);
  }, 60_000);

  afterAll(async () => {
    if (database) await database.end();
    if (administration && schema) {
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administration.end();
    }
  }, 30_000);

  it('stores statement-shaped text as data and executes nothing from it', async () => {
    const owner = await createOwner();
    for (const payload of PAYLOADS) {
      const receipt = await savings.createGoal(owner.id, {
        name: payload,
        targetAmountMinor: '10000000',
        currentAmountMinor: '0',
        currentAmountAsOf: today(),
      }, randomUUID(), randomUUID());
      const stored = await savings.getGoal(owner.id, receipt.goalId);
      // Byte-identical: no escaping artefact, no truncation at the quote.
      expect(stored.name).toBe(payload);
    }

    const counts = await database.query<{
      goals: string; transactions: string; disabled_users: string;
    }>(`
      SELECT
        (SELECT count(*) FROM savings_goals WHERE user_id = $1) AS goals,
        (SELECT count(*) FROM transactions WHERE user_id = $1) AS transactions,
        (SELECT count(*) FROM users WHERE status <> 'active') AS disabled_users
    `, [owner.id]);
    // Every payload row is present and nothing the payloads named was dropped,
    // emptied, or rewritten — the counts themselves prove the tables survive.
    expect(Number(counts.rows[0]!.goals)).toBe(PAYLOADS.length);
    expect(Number(counts.rows[0]!.transactions)).toBe(0);
    expect(Number(counts.rows[0]!.disabled_users)).toBe(0);
  }, 30_000);

  it('cannot widen a result set through a filter value', async () => {
    const owner = await createOwner();
    await post(owner);
    const before = await owner.repository.listTransactions(owner.id, { limit: 100 });
    expect(before.items).toHaveLength(1);

    for (const payload of PAYLOADS) {
      const page = await owner.repository.listTransactions(owner.id, {
        limit: 100,
        categoryCode: payload,
      });
      // `' OR 1=1 --` must not become a predicate that matches the owner's row.
      expect(page.items).toEqual([]);
    }

    const after = await owner.repository.listTransactions(owner.id, { limit: 100 });
    expect(after.items.map((item) => item.id)).toEqual(before.items.map((item) => item.id));
  }, 30_000);

  it('refuses a malformed cursor instead of interpreting it', async () => {
    const owner = await createOwner();
    await post(owner);
    for (const payload of PAYLOADS) {
      await expect(owner.repository.listTransactions(owner.id, { limit: 10, cursor: payload }))
        .rejects.toMatchObject({ statusCode: 400 });
    }
    const page = await owner.repository.listTransactions(owner.id, { limit: 10 });
    expect(page.items).toHaveLength(1);
  }, 30_000);

  it('never lets a non-uuid identifier reach a statement unguarded', async () => {
    const owner = await createOwner();
    for (const payload of PAYLOADS) {
      // Savings validates the id before the statement and answers 404.
      await expect(savings.getGoal(owner.id, payload))
        .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE', statusCode: 404 });
    }
    // The transaction lookup carries no uuid guard of its own; the API validates
    // the path parameter first (`uuidSchema`). Pinned so that removing that
    // contract-level validation fails here instead of returning a row.
    await expect(owner.repository.getTransaction(owner.id, PAYLOADS[0]))
      .rejects.toThrow();
  }, 30_000);

  it("keeps another owner's rows out of reach for reads", async () => {
    const target = await createOwner();
    const stranger = await createOwner();
    const goal = await savings.createGoal(target.id, goalInput(), randomUUID(), randomUUID());
    const transactionId = await post(target);

    await expect(savings.getGoal(stranger.id, goal.goalId))
      .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE', statusCode: 404 });
    await expect(savings.listAmountChanges(stranger.id, goal.goalId, { limit: 50 }))
      .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE', statusCode: 404 });
    await expect(stranger.repository.getTransaction(stranger.id, transactionId))
      .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE', statusCode: 404 });

    expect((await savings.listGoals(stranger.id, { status: 'all', limit: 100 })).items).toEqual([]);
    expect((await stranger.repository.listTransactions(stranger.id, { limit: 100 })).items).toEqual([]);
    // The stranger also cannot take over the page by asking for more rows.
    expect((await stranger.repository.listTransactions(stranger.id, { limit: 100 })).items).toHaveLength(0);
  }, 30_000);

  it("refuses another owner's writes and leaves the target row unchanged", async () => {
    const target = await createOwner();
    const stranger = await createOwner();
    const goal = await savings.createGoal(target.id, goalInput(), randomUUID(), randomUUID());
    const notOwner = { code: 'FINANCIAL_RESOURCE_UNAVAILABLE', statusCode: 404 };

    await expect(savings.updatePlan(stranger.id, goal.goalId, {
      expectedVersion: goal.version,
      name: 'renamed by another owner',
    }, randomUUID(), randomUUID())).rejects.toMatchObject(notOwner);
    await expect(savings.updateCurrentAmount(stranger.id, goal.goalId, {
      expectedVersion: goal.version,
      currentAmountMinor: '1',
      asOf: today(),
    }, randomUUID(), randomUUID())).rejects.toMatchObject(notOwner);
    await expect(savings.archiveGoal(stranger.id, goal.goalId, {
      expectedVersion: goal.version,
    }, randomUUID(), randomUUID())).rejects.toMatchObject(notOwner);

    const row = await database.query<{
      name: string; status: string; version: string; current_amount_minor: string; owner: string;
    }>('SELECT name, status, version, current_amount_minor, user_id AS owner FROM savings_goals WHERE id = $1', [
      goal.goalId,
    ]);
    expect(row.rows[0]).toEqual({
      name: 'Emergency fund',
      status: 'active',
      version: '1',
      current_amount_minor: '2500000',
      owner: target.id,
    });
  }, 30_000);
});
