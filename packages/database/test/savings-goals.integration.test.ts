import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeSavingsReserveMinor, localDateAt } from '@kfin/domain';
import {
  migrateDatabase,
  PostgresFinancialRepository,
  PostgresSavingsGoalRepository,
  PostgresUserRepository,
  type CreateSavingsGoalInput,
  type UserRecord,
} from '../src/index.js';

/**
 * Milestone 06 — savings goals against real PostgreSQL. Each run uses an
 * isolated schema that is dropped afterwards. Skipped (never faked) without an
 * explicit non-production target.
 */

const integrationEnabled = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.KFIN_INTEGRATION_TARGET === 'non-production',
);

const integration = describe.skipIf(!integrationEnabled);
const TIMEZONE = 'Asia/Ho_Chi_Minh';
const DAY_MS = 24 * 60 * 60 * 1_000;

integration('savings goals on real PostgreSQL', () => {
  let administration: Pool;
  let database: Pool;
  let schema: string;
  let savings: PostgresSavingsGoalRepository;
  let financial: PostgresFinancialRepository;
  let users: PostgresUserRepository;

  const today = () => localDateAt(new Date(), TIMEZONE);
  const daysAgo = (days: number) => localDateAt(new Date(Date.now() - days * DAY_MS), TIMEZONE);

  const verifiedUser = async (): Promise<UserRecord> => users.create({
    email: `m06-${randomUUID()}@example.invalid`,
    locale: 'vi-VN',
    timezone: TIMEZONE,
    baseCurrency: 'VND',
    emailVerifiedAt: new Date(Date.now() - 60_000),
  });

  const goalInput = (overrides: Partial<CreateSavingsGoalInput> = {}): CreateSavingsGoalInput => ({
    name: 'Emergency fund',
    targetAmountMinor: '10000000',
    currentAmountMinor: '2500000',
    currentAmountAsOf: daysAgo(1),
    ...overrides,
  });

  const counts = async (userId: string) => {
    const result = await database.query<{
      goals: string; changes: string; receipts: string; audits: string;
    }>(`
      SELECT
        (SELECT count(*) FROM savings_goals WHERE user_id = $1) AS goals,
        (SELECT count(*) FROM savings_amount_changes WHERE user_id = $1) AS changes,
        (SELECT count(*) FROM idempotency_results
          WHERE user_id = $1 AND operation LIKE 'savings.%') AS receipts,
        (SELECT count(*) FROM audit_events
          WHERE user_id = $1 AND resource_type = 'savings_goal') AS audits
    `, [userId]);
    const row = result.rows[0]!;
    return {
      goals: Number(row.goals),
      changes: Number(row.changes),
      receipts: Number(row.receipts),
      audits: Number(row.audits),
    };
  };

  const expectSqlFailure = async (sql: string, values: unknown[] = []) => {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(sql, values).then(() => client.query('COMMIT')))
        .rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };

  beforeAll(async () => {
    schema = `kfin_m06_${randomUUID().replaceAll('-', '')}`;
    administration = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await administration.query(`CREATE SCHEMA ${schema}`);
    database = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 8,
      options: `-c search_path=${schema},public`,
    });
    await migrateDatabase(database);
    savings = new PostgresSavingsGoalRepository(database, { idempotencyRetentionMs: 86_400_000 });
    financial = new PostgresFinancialRepository(database, 86_400_000, 'ef'.repeat(32));
    users = new PostgresUserRepository(database);
  }, 60_000);

  afterAll(async () => {
    if (database) await database.end();
    if (administration && schema) {
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administration.end();
    }
  }, 30_000);

  it('atomically creates the goal, initial amount row, receipt, and audit event', async () => {
    const owner = await verifiedUser();
    const created = await savings.createGoal(owner.id, goalInput({
      targetDate: '2030-01-01',
      plannedContributionMinor: '500000',
      contributionFrequency: 'monthly',
    }), randomUUID(), randomUUID());
    expect(created).toMatchObject({ version: '1', replayed: false });
    expect(await counts(owner.id)).toEqual({ goals: 1, changes: 1, receipts: 1, audits: 1 });

    const goal = await savings.getGoal(owner.id, created.goalId);
    expect(goal).toMatchObject({
      name: 'Emergency fund',
      currency: 'VND',
      targetAmountMinor: '10000000',
      currentAmountMinor: '2500000',
      currentAmountAsOf: daysAgo(1),
      targetDate: '2030-01-01',
      plannedContributionMinor: '500000',
      contributionFrequency: 'monthly',
      status: 'active',
      archivedAt: null,
      version: '1',
      progress: { percentBasisPoints: '2500', achieved: false, overTarget: false, remainingMinor: '7500000' },
    });
    const history = await savings.listAmountChanges(owner.id, created.goalId, { limit: 10 });
    expect(history.items).toEqual([expect.objectContaining({
      id: created.amountChangeId,
      goalVersion: '1',
      previousAmountMinor: null,
      newAmountMinor: '2500000',
      source: 'initial',
      actorType: 'user',
    })]);
    const receipt = await database.query<{ result: unknown }>(
      "SELECT result FROM idempotency_results WHERE user_id = $1 AND operation = 'savings.goal.create'",
      [owner.id],
    );
    expect(JSON.stringify(receipt.rows[0]?.result)).not.toContain('2500000');
  }, 30_000);

  it('replays same key/same payload, rejects key reuse, and serializes concurrent same-key creates', async () => {
    const owner = await verifiedUser();
    const key = randomUUID();
    const input = goalInput();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () => savings.createGoal(owner.id, input, key, randomUUID())),
    );
    expect(new Set(attempts.map((attempt) => attempt.goalId)).size).toBe(1);
    expect(attempts.filter((attempt) => !attempt.replayed)).toHaveLength(1);
    expect(await counts(owner.id)).toEqual({ goals: 1, changes: 1, receipts: 1, audits: 1 });

    await expect(savings.createGoal(owner.id, goalInput({ name: 'Different' }), key, randomUUID()))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
    expect(await counts(owner.id)).toEqual({ goals: 1, changes: 1, receipts: 1, audits: 1 });
  }, 30_000);

  it('rejects a future user-local as-of date and invalid plans without writing anything', async () => {
    const owner = await verifiedUser();
    const tomorrow = localDateAt(new Date(Date.now() + DAY_MS), TIMEZONE);
    await expect(savings.createGoal(owner.id, goalInput({ currentAmountAsOf: tomorrow }), randomUUID(), randomUUID()))
      .rejects.toMatchObject({ code: 'SAVINGS_GOAL_INVALID', statusCode: 422 });
    await expect(savings.createGoal(owner.id, goalInput({ contributionFrequency: 'weekly' }), randomUUID(), randomUUID()))
      .rejects.toMatchObject({ code: 'SAVINGS_GOAL_INVALID', statusCode: 422 });
    await expect(savings.createGoal(owner.id, goalInput({ targetAmountMinor: '0' }), randomUUID(), randomUUID()))
      .rejects.toMatchObject({ code: 'SAVINGS_GOAL_INVALID' });
    await expect(savings.createGoal(owner.id, goalInput({ currentAmountMinor: '-1' }), randomUUID(), randomUUID()))
      .rejects.toMatchObject({ code: 'SAVINGS_GOAL_INVALID' });
    await expect(savings.createGoal(owner.id, goalInput({ currentAmountMinor: '9223372036854775808' }), randomUUID(), randomUUID()))
      .rejects.toMatchObject({ code: 'SAVINGS_GOAL_INVALID' });
    expect(await counts(owner.id)).toEqual({ goals: 0, changes: 0, receipts: 0, audits: 0 });

    const created = await savings.createGoal(owner.id, goalInput({ currentAmountAsOf: today() }), randomUUID(), randomUUID());
    expect(created.version).toBe('1');
  }, 30_000);

  it('replaces the current amount absolutely with one old/new row per version and rejects stale versions', async () => {
    const owner = await verifiedUser();
    const created = await savings.createGoal(owner.id, goalInput(), randomUUID(), randomUUID());
    const key = randomUUID();
    const updated = await savings.updateCurrentAmount(owner.id, created.goalId, {
      expectedVersion: '1', currentAmountMinor: '12000000', asOf: today(), reason: 'Bonus',
    }, key, randomUUID());
    expect(updated).toMatchObject({ version: '2', replayed: false });

    const replay = await savings.updateCurrentAmount(owner.id, created.goalId, {
      expectedVersion: '1', currentAmountMinor: '12000000', asOf: today(), reason: 'Bonus',
    }, key, randomUUID());
    expect(replay).toEqual({ ...updated, replayed: true });

    const goal = await savings.getGoal(owner.id, created.goalId);
    expect(goal).toMatchObject({
      currentAmountMinor: '12000000',
      currentAmountAsOf: today(),
      status: 'active',
      version: '2',
      progress: { percentBasisPoints: '12000', achieved: true, overTarget: true, remainingMinor: '0' },
    });

    await expect(savings.updateCurrentAmount(owner.id, created.goalId, {
      expectedVersion: '1', currentAmountMinor: '1', asOf: today(),
    }, randomUUID(), randomUUID())).rejects.toMatchObject({
      code: 'SAVINGS_GOAL_VERSION_CONFLICT', statusCode: 409,
    });
    await expect(savings.updateCurrentAmount(owner.id, created.goalId, {
      expectedVersion: '2', currentAmountMinor: '1',
      asOf: localDateAt(new Date(Date.now() + DAY_MS), TIMEZONE),
    }, randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'SAVINGS_GOAL_INVALID' });

    const history = await savings.listAmountChanges(owner.id, created.goalId, { limit: 10 });
    expect(history.items.map((item) => [item.goalVersion, item.previousAmountMinor, item.newAmountMinor, item.source, item.reason]))
      .toEqual([
        ['2', '2500000', '12000000', 'manual_update', 'Bonus'],
        ['1', null, '2500000', 'initial', null],
      ]);
    expect(await counts(owner.id)).toEqual({ goals: 1, changes: 2, receipts: 2, audits: 2 });
  }, 30_000);

  it('lets exactly one of several concurrent same-version updates win', async () => {
    const owner = await verifiedUser();
    const created = await savings.createGoal(owner.id, goalInput(), randomUUID(), randomUUID());
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_value, index) => (
      savings.updateCurrentAmount(owner.id, created.goalId, {
        expectedVersion: '1', currentAmountMinor: String(3_000_000 + index), asOf: today(),
      }, randomUUID(), randomUUID())
    )));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected.every((result) => (result.reason as { code?: string }).code === 'SAVINGS_GOAL_VERSION_CONFLICT'))
      .toBe(true);
    expect(await counts(owner.id)).toEqual({ goals: 1, changes: 2, receipts: 2, audits: 2 });
    const goal = await savings.getGoal(owner.id, created.goalId);
    const latest = (await savings.listAmountChanges(owner.id, created.goalId, { limit: 1 })).items[0];
    expect(latest).toMatchObject({ goalVersion: '2', newAmountMinor: goal.currentAmountMinor, previousAmountMinor: '2500000' });
  }, 30_000);

  it('edits plan details without touching the current amount or its history', async () => {
    const owner = await verifiedUser();
    const created = await savings.createGoal(owner.id, goalInput({
      plannedContributionMinor: '100000', contributionFrequency: 'weekly',
    }), randomUUID(), randomUUID());
    const edited = await savings.updatePlan(owner.id, created.goalId, {
      expectedVersion: '1', name: '  New laptop  ', targetAmountMinor: '2500000', targetDate: '2027-06-30',
    }, randomUUID(), randomUUID());
    expect(edited).toMatchObject({ version: '2', replayed: false });
    const goal = await savings.getGoal(owner.id, created.goalId);
    expect(goal).toMatchObject({
      name: 'New laptop',
      targetAmountMinor: '2500000',
      targetDate: '2027-06-30',
      currentAmountMinor: '2500000',
      currentAmountAsOf: daysAgo(1),
      plannedContributionMinor: '100000',
      contributionFrequency: 'weekly',
      progress: { achieved: true, overTarget: false, percentBasisPoints: '10000' },
      status: 'active',
    });
    // Clearing the contribution while a cadence remains is rejected; clearing both works.
    await expect(savings.updatePlan(owner.id, created.goalId, {
      expectedVersion: '2', plannedContributionMinor: null,
    }, randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'SAVINGS_GOAL_INVALID' });
    await savings.updatePlan(owner.id, created.goalId, {
      expectedVersion: '2', plannedContributionMinor: null, contributionFrequency: null, targetDate: null,
    }, randomUUID(), randomUUID());
    expect(await savings.getGoal(owner.id, created.goalId)).toMatchObject({
      plannedContributionMinor: null, contributionFrequency: null, targetDate: null, version: '3',
    });
    const history = await savings.listAmountChanges(owner.id, created.goalId, { limit: 10 });
    expect(history.items).toHaveLength(1);
    expect(await counts(owner.id)).toEqual({ goals: 1, changes: 1, receipts: 3, audits: 3 });
  }, 30_000);

  it('archives without changing the value, removes the goal from active reserves, and is terminal', async () => {
    const owner = await verifiedUser();
    const first = await savings.createGoal(owner.id, goalInput({ name: 'Reserve A', currentAmountMinor: '100000' }), randomUUID(), randomUUID());
    const second = await savings.createGoal(owner.id, goalInput({ name: 'Reserve B', currentAmountMinor: '150000' }), randomUUID(), randomUUID());
    const third = await savings.createGoal(owner.id, goalInput({ name: 'Reserve C', currentAmountMinor: '50000' }), randomUUID(), randomUUID());

    const reserveOf = async () => {
      const all = await savings.listGoals(owner.id, { status: 'all', limit: 100 });
      return activeSavingsReserveMinor(all.items.map((goal) => ({
        status: goal.status, currentAmountMinor: BigInt(goal.currentAmountMinor),
      })));
    };
    expect(await reserveOf()).toBe(300_000n);

    const key = randomUUID();
    const archived = await savings.archiveGoal(owner.id, third.goalId, { expectedVersion: '1' }, key, randomUUID());
    expect(archived).toMatchObject({ version: '2', replayed: false });
    expect(await savings.archiveGoal(owner.id, third.goalId, { expectedVersion: '1' }, key, randomUUID()))
      .toEqual({ ...archived, replayed: true });

    // STS-09/10: 1,000,000 known balance minus active goals 100,000 + 150,000.
    expect(1_000_000n - (await reserveOf())).toBe(750_000n);

    const archivedGoal = await savings.getGoal(owner.id, third.goalId);
    expect(archivedGoal).toMatchObject({ status: 'archived', currentAmountMinor: '50000', version: '2' });
    expect(archivedGoal.archivedAt).not.toBeNull();

    const active = await savings.listGoals(owner.id, { status: 'active', limit: 100 });
    expect(active.items.map((goal) => goal.id)).toEqual([first.goalId, second.goalId]);
    const archivedList = await savings.listGoals(owner.id, { status: 'archived', limit: 100 });
    expect(archivedList.items.map((goal) => goal.id)).toEqual([third.goalId]);

    await expect(savings.updateCurrentAmount(owner.id, third.goalId, {
      expectedVersion: '2', currentAmountMinor: '1', asOf: today(),
    }, randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'SAVINGS_GOAL_ARCHIVED', statusCode: 409 });
    await expect(savings.updatePlan(owner.id, third.goalId, { expectedVersion: '2', name: 'x' }, randomUUID(), randomUUID()))
      .rejects.toMatchObject({ code: 'SAVINGS_GOAL_ARCHIVED' });
    await expect(savings.archiveGoal(owner.id, third.goalId, { expectedVersion: '2' }, randomUUID(), randomUUID()))
      .rejects.toMatchObject({ code: 'SAVINGS_GOAL_ARCHIVED' });
    expect((await savings.listAmountChanges(owner.id, third.goalId, { limit: 10 })).items).toHaveLength(1);
  }, 30_000);

  it('never exposes or mutates another user’s goals', async () => {
    const owner = await verifiedUser();
    const intruder = await verifiedUser();
    const created = await savings.createGoal(owner.id, goalInput(), randomUUID(), randomUUID());
    await expect(savings.getGoal(intruder.id, created.goalId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(savings.listAmountChanges(intruder.id, created.goalId, { limit: 10 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(savings.updateCurrentAmount(intruder.id, created.goalId, {
      expectedVersion: '1', currentAmountMinor: '0', asOf: today(),
    }, randomUUID(), randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    await expect(savings.updatePlan(intruder.id, created.goalId, { expectedVersion: '1', name: 'Mine' }, randomUUID(), randomUUID()))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(savings.archiveGoal(intruder.id, created.goalId, { expectedVersion: '1' }, randomUUID(), randomUUID()))
      .rejects.toMatchObject({ statusCode: 404 });
    expect((await savings.listGoals(intruder.id, { status: 'all', limit: 100 })).items).toEqual([]);
    expect(await savings.getGoal(owner.id, created.goalId)).toMatchObject({ version: '1', currentAmountMinor: '2500000' });
    expect(await counts(intruder.id)).toEqual({ goals: 0, changes: 0, receipts: 0, audits: 0 });
  }, 30_000);

  it('never changes the account balance, financial state version, transactions, or monthly actuals', async () => {
    const owner = await verifiedUser();
    await financial.openFinancialAccount(owner.id, {
      openingBalanceMinor: '1000000',
      effectiveAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    }, randomUUID(), randomUUID());
    const month = today().slice(0, 7);
    const balanceBefore = await financial.getCurrentBalance(owner.id);
    const actualsBefore = await financial.getMonthlyActuals(owner.id, month);

    const created = await savings.createGoal(owner.id, goalInput({ currentAmountMinor: '400000' }), randomUUID(), randomUUID());
    await savings.updateCurrentAmount(owner.id, created.goalId, {
      expectedVersion: '1', currentAmountMinor: '900000', asOf: today(),
    }, randomUUID(), randomUUID());
    await savings.updatePlan(owner.id, created.goalId, { expectedVersion: '2', targetAmountMinor: '5000000' }, randomUUID(), randomUUID());
    await savings.archiveGoal(owner.id, created.goalId, { expectedVersion: '3' }, randomUUID(), randomUUID());

    expect(await financial.getCurrentBalance(owner.id)).toEqual(balanceBefore);
    expect(await financial.getMonthlyActuals(owner.id, month)).toEqual(actualsBefore);
    const transactions = await database.query('SELECT 1 FROM transactions WHERE user_id = $1', [owner.id]);
    expect(transactions.rowCount).toBe(0);
    const snapshots = await database.query('SELECT 1 FROM balance_snapshots WHERE user_id = $1', [owner.id]);
    expect(snapshots.rowCount).toBe(1);
  }, 30_000);

  it('paginates goals and amount history with opaque cursors', async () => {
    const owner = await verifiedUser();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push((await savings.createGoal(owner.id, goalInput({ name: `Goal ${index}` }), randomUUID(), randomUUID())).goalId);
    }
    const page1 = await savings.listGoals(owner.id, { status: 'active', limit: 2 });
    expect(page1.items.map((goal) => goal.id)).toEqual(ids.slice(0, 2));
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await savings.listGoals(owner.id, { status: 'active', limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((goal) => goal.id)).toEqual(ids.slice(2));
    expect(page2.nextCursor).toBeNull();
    await expect(savings.listGoals(owner.id, { status: 'active', limit: 2, cursor: 'not-a-cursor' }))
      .rejects.toMatchObject({ statusCode: 400 });

    let version = 1;
    for (const amount of ['1', '2', '3']) {
      await savings.updateCurrentAmount(owner.id, ids[0]!, {
        expectedVersion: String(version), currentAmountMinor: amount, asOf: today(),
      }, randomUUID(), randomUUID());
      version += 1;
    }
    const history1 = await savings.listAmountChanges(owner.id, ids[0]!, { limit: 3 });
    expect(history1.items.map((item) => item.goalVersion)).toEqual(['4', '3', '2']);
    const history2 = await savings.listAmountChanges(owner.id, ids[0]!, { limit: 3, cursor: history1.nextCursor! });
    expect(history2.items.map((item) => item.goalVersion)).toEqual(['1']);
    expect(history2.nextCursor).toBeNull();
  }, 30_000);

  it('enforces amount-history, immutability, terminal archive, and currency invariants in the database', async () => {
    const owner = await verifiedUser();
    const created = await savings.createGoal(owner.id, goalInput(), randomUUID(), randomUUID());

    // Scalar amount change without a matching old/new audit row fails at commit.
    await expectSqlFailure(
      'UPDATE savings_goals SET current_amount_minor = 1, version = version + 1 WHERE id = $1',
      [created.goalId],
    );
    // Goal insert without its initial change row fails at commit.
    await expectSqlFailure(`
      INSERT INTO savings_goals (id, user_id, name, target_amount_minor, current_amount_minor, currency, current_amount_as_of)
      VALUES ($1, $2, 'Raw', 10, 0, 'VND', CURRENT_DATE - 1)
    `, [randomUUID(), owner.id]);
    // Currency must equal the user's base currency.
    await expectSqlFailure(`
      INSERT INTO savings_goals (id, user_id, name, target_amount_minor, current_amount_minor, currency, current_amount_as_of)
      VALUES ($1, $2, 'Raw', 10, 0, 'USD', CURRENT_DATE - 1)
    `, [randomUUID(), owner.id]);
    // Version must advance by exactly one.
    await expectSqlFailure("UPDATE savings_goals SET name = 'skip', version = version + 2 WHERE id = $1", [created.goalId]);
    // Owner is immutable.
    const other = await verifiedUser();
    await expectSqlFailure(
      'UPDATE savings_goals SET user_id = $2, version = version + 1 WHERE id = $1',
      [created.goalId, other.id],
    );
    // A change row that does not describe the goal's current state is rejected.
    await expectSqlFailure(`
      INSERT INTO savings_amount_changes (
        id, user_id, savings_goal_id, goal_version, previous_amount_minor, new_amount_minor,
        as_of, source, actor_user_id, correlation_id
      ) VALUES ($1, $2, $3, 1, 0, 999, CURRENT_DATE - 1, 'manual_update', $2, 'raw')
    `, [randomUUID(), owner.id, created.goalId]);
    // History rows and goals cannot be rewritten or deleted.
    await expectSqlFailure('UPDATE savings_amount_changes SET reason = $2 WHERE id = $1', [created.amountChangeId, 'rewrite']);
    await expectSqlFailure('DELETE FROM savings_amount_changes WHERE id = $1', [created.amountChangeId]);
    await expectSqlFailure('DELETE FROM savings_goals WHERE id = $1', [created.goalId]);

    // Archived goals are terminal at the database level too.
    await savings.archiveGoal(owner.id, created.goalId, { expectedVersion: '1' }, randomUUID(), randomUUID());
    await expectSqlFailure(
      "UPDATE savings_goals SET status = 'active', archived_at = NULL, version = version + 1 WHERE id = $1",
      [created.goalId],
    );
    expect(await savings.getGoal(owner.id, created.goalId)).toMatchObject({
      status: 'archived', currentAmountMinor: '2500000', version: '2',
    });
  }, 30_000);
});
