import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FinancialAccountBootstrapService,
  migrateDatabase,
  PostgresFinancialRepository,
  PostgresScheduleRepository,
  PostgresUserRepository,
} from '../src/index.js';

const PREVIEW_SIGNING_KEY = 'ab'.repeat(32);

const integrationEnabled = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.KFIN_INTEGRATION_TARGET === 'non-production',
);
const integration = describe.skipIf(!integrationEnabled);
const RETENTION_MS = 86_400_000;
const INITIAL_NOW = new Date('2026-10-15T05:00:00.000Z');

interface Fixture {
  readonly ownerId: string;
  readonly snapshotId: string;
  readonly accountId: string;
  readonly schedule: PostgresScheduleRepository;
  readonly financial: PostgresFinancialRepository;
  readonly setNow: (value: Date) => void;
}

integration('one-off schedule occurrences on real PostgreSQL', () => {
  let administration: Pool;
  let database: Pool;
  let schema: string;

  beforeAll(async () => {
    schema = `kfin_schedule_it_${randomUUID().replaceAll('-', '')}`;
    administration = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await administration.query(`CREATE SCHEMA ${schema}`);
    database = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 12,
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

  async function fixture(initialNow = INITIAL_NOW): Promise<Fixture> {
    let currentNow = initialNow;
    const now = () => currentNow;
    const user = await new PostgresUserRepository(database, () => currentNow.getTime()).create({
      email: `schedule-${randomUUID()}@example.invalid`,
      locale: 'en-VN',
      timezone: 'Asia/Ho_Chi_Minh',
      baseCurrency: 'VND',
      emailVerifiedAt: new Date(currentNow.getTime() - 1_000),
    });
    const foundation = await new FinancialAccountBootstrapService(
      database,
      () => currentNow.getTime(),
    ).bootstrap({
      ownerUserId: user.id,
      openingAmountMinor: '1000000',
      effectiveAt: new Date('2026-10-01T05:00:00.000Z'),
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      idempotencyRetentionMs: RETENTION_MS,
    });
    return {
      ownerId: user.id,
      snapshotId: foundation.snapshotId,
      accountId: foundation.accountId,
      schedule: new PostgresScheduleRepository(database, RETENTION_MS, now),
      financial: new PostgresFinancialRepository(database, RETENTION_MS, PREVIEW_SIGNING_KEY, now),
      setNow: (value) => { currentNow = value; },
    };
  }

  function expenseSchedule(target: Fixture, expectedVersion = '1') {
    return {
      title: 'Rent',
      kind: 'expense' as const,
      expectedAmountMinor: '300000',
      dueOn: '2026-10-15',
      categoryCode: 'rent',
      expenseClass: 'essential_fixed' as const,
      expectedFinancialStateVersion: expectedVersion,
      reviewedLatestSnapshotId: target.snapshotId,
    };
  }

  it('FIN-OCC-01/04: creates/replays one occurrence and derives date labels without mutation', async () => {
    const target = await fixture(new Date('2026-10-14T05:00:00.000Z'));
    const key = randomUUID();
    const created = await target.schedule.createOneOff(
      target.ownerId,
      expenseSchedule(target),
      key,
      randomUUID(),
    );
    expect(created.financialStateVersion).toBe('2');
    await expect(target.schedule.createOneOff(
      target.ownerId,
      expenseSchedule(target),
      key,
      randomUUID(),
    )).resolves.toEqual(created);
    await target.schedule.createOneOff(target.ownerId, {
      ...expenseSchedule(target, '2'), title: 'Utilities', dueOn: '2026-10-16',
    }, randomUUID(), randomUUID());
    await target.schedule.createOneOff(target.ownerId, {
      ...expenseSchedule(target, '3'), title: 'Insurance', dueOn: '2026-10-17',
    }, randomUUID(), randomUUID());
    const firstPage = await target.schedule.listOccurrences(target.ownerId, { limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await target.schedule.listOccurrences(target.ownerId, {
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size).toBe(3);

    expect(await target.schedule.getOccurrence(target.ownerId, created.occurrenceId)).toMatchObject({
      state: 'scheduled', presentation: 'upcoming', direction: 'outgoing', version: '1',
    });
    target.setNow(new Date('2026-10-15T05:00:00.000Z'));
    expect((await target.schedule.getOccurrence(target.ownerId, created.occurrenceId)).presentation)
      .toBe('due_today');
    target.setNow(new Date('2026-10-16T05:00:00.000Z'));
    expect(await target.schedule.getOccurrence(target.ownerId, created.occurrenceId)).toMatchObject({
      state: 'scheduled', presentation: 'overdue', version: '1',
    });
    expect((await target.financial.getCurrentBalance(target.ownerId)).financialStateVersion).toBe('4');

    const stored = await database.query<{ state: string; confirmed_transaction_id: string | null }>(`
      SELECT state, confirmed_transaction_id FROM scheduled_occurrences
      WHERE user_id = $1 AND id = $2
    `, [target.ownerId, created.occurrenceId]);
    expect(stored.rows[0]).toEqual({ state: 'scheduled', confirmed_transaction_id: null });
    await expect(database.query(`
      UPDATE scheduled_occurrences SET state = 'paid' WHERE id = $1
    `, [created.occurrenceId])).rejects.toMatchObject({
      code: expect.stringMatching(/^23/),
    });
  }, 30_000);

  it('confirms an outgoing exactly once, rejects orphaning, and transfers its correction pointer', async () => {
    const target = await fixture();
    const created = await target.schedule.createOneOff(
      target.ownerId,
      expenseSchedule(target),
      randomUUID(),
      randomUUID(),
    );
    const confirmInput = {
      amountMinor: '250000',
      occurredOn: '2026-10-15',
      categoryCode: 'rent',
      expenseClass: 'essential_fixed' as const,
      isUnexpected: false,
      expectedFinancialStateVersion: '2',
      reviewedLatestSnapshotId: target.snapshotId,
      reviewedOccurrenceVersion: '1',
    };
    const confirmKey = randomUUID();
    const confirmed = await target.schedule.confirmOccurrence(
      target.ownerId,
      created.occurrenceId,
      confirmInput,
      confirmKey,
      randomUUID(),
    );
    expect(confirmed).toMatchObject({
      state: 'confirmed', financialStateVersion: '3', occurrenceVersion: '2',
    });
    await expect(target.schedule.confirmOccurrence(
      target.ownerId,
      created.occurrenceId,
      confirmInput,
      confirmKey,
      randomUUID(),
    )).resolves.toEqual(confirmed);
    expect(await target.schedule.getOccurrence(target.ownerId, created.occurrenceId)).toMatchObject({
      state: 'confirmed', presentation: 'paid', confirmedTransactionId: confirmed.transactionId,
      expectedAmountMinor: '300000', version: '2',
    });
    expect((await target.financial.getCurrentBalance(target.ownerId)).currentBalanceMinor).toBe('750000');

    const voidPreview = await target.financial.previewTransactionVoid(
      target.ownerId,
      confirmed.transactionId,
      { reason: 'Attempt to orphan schedule claim' },
    );
    expect(voidPreview.owningDomain).toEqual({
      type: 'schedule',
      genericCorrectionSupported: true,
      genericVoidSupported: false,
      unsupportedReasonCode: 'FIN_CORRECTION_LINKED_DOMAIN_REQUIRED',
      scheduleOccurrenceId: created.occurrenceId,
      scheduleOccurrenceVersion: '2',
    });
    const linkedVoidKey = randomUUID();
    const linkedVoidInput = {
      reason: 'Attempt to orphan schedule claim',
      context: voidPreview.context,
    };
    await expect(target.financial.voidTransaction(
      target.ownerId,
      confirmed.transactionId,
      linkedVoidInput,
      linkedVoidKey,
      randomUUID(),
    )).rejects.toMatchObject({ code: 'FIN_CORRECTION_LINKED_DOMAIN_REQUIRED' });
    await expect(target.financial.voidTransaction(
      target.ownerId,
      confirmed.transactionId,
      linkedVoidInput,
      linkedVoidKey,
      randomUUID(),
    )).rejects.toMatchObject({ code: 'FIN_CORRECTION_LINKED_DOMAIN_REQUIRED' });
    expect((await target.financial.getCurrentBalance(target.ownerId)).financialStateVersion).toBe('3');
    await expect(database.query(`
      UPDATE transactions
      SET status = 'voided', voided_at = clock_timestamp(), void_reason = 'bypass',
          version = version + 1, updated_at = clock_timestamp()
      WHERE id = $1
    `, [confirmed.transactionId])).rejects.toMatchObject({
      code: expect.stringMatching(/^23/),
    });

    const preview = await target.financial.previewTransactionCorrection(
      target.ownerId,
      confirmed.transactionId,
      {
        reason: 'Correct paid amount',
        replacement: {
          amountMinor: '200000',
          occurredOn: '2026-10-15',
          categoryCode: 'rent',
          expenseClass: 'essential_fixed',
          isUnexpected: false,
        },
      },
    );
    expect(preview.owningDomain).toMatchObject({
      type: 'schedule', genericCorrectionSupported: true, scheduleOccurrenceVersion: '2',
    });
    const corrected = await target.financial.correctTransaction(
      target.ownerId,
      confirmed.transactionId,
      {
        reason: 'Correct paid amount',
        replacement: {
          amountMinor: '200000',
          occurredOn: '2026-10-15',
          categoryCode: 'rent',
          expenseClass: 'essential_fixed',
          isUnexpected: false,
        },
        context: preview.context,
      },
      randomUUID(),
      randomUUID(),
    );
    expect(corrected).toMatchObject({
      financialStateVersion: '4',
      consequence: {
        owningDomain: {
          type: 'schedule',
          scheduleOccurrenceId: created.occurrenceId,
          scheduleOccurrenceVersion: '3',
        },
      },
    });
    expect(await target.schedule.getOccurrence(target.ownerId, created.occurrenceId)).toMatchObject({
      state: 'confirmed',
      presentation: 'paid',
      confirmedTransactionId: corrected.replacementTransactionId,
      version: '3',
    });
    expect((await target.financial.getCurrentBalance(target.ownerId)).currentBalanceMinor).toBe('800000');
    expect(await target.financial.getTransaction(target.ownerId, confirmed.transactionId)).toMatchObject({
      status: 'voided', supersededByTransactionId: corrected.replacementTransactionId,
    });
  }, 30_000);

  it('FIN-OCC-03: confirms income as Received while persisting only confirmed', async () => {
    const target = await fixture();
    const created = await target.schedule.createOneOff(target.ownerId, {
      title: 'Contract payment',
      kind: 'income',
      expectedAmountMinor: '400000',
      dueOn: '2026-10-15',
      categoryCode: 'income_other',
      expectedFinancialStateVersion: '1',
      reviewedLatestSnapshotId: target.snapshotId,
    }, randomUUID(), randomUUID());
    const before = await target.schedule.getOccurrence(target.ownerId, created.occurrenceId);
    expect(before).toMatchObject({ state: 'scheduled', presentation: 'projected', direction: 'incoming' });

    const confirmed = await target.schedule.confirmOccurrence(target.ownerId, created.occurrenceId, {
      amountMinor: '450000',
      occurredOn: '2026-10-15',
      categoryCode: 'income_other',
      isUnexpected: false,
      expectedFinancialStateVersion: '2',
      reviewedLatestSnapshotId: target.snapshotId,
      reviewedOccurrenceVersion: '1',
    }, randomUUID(), randomUUID());
    expect(await target.schedule.getOccurrence(target.ownerId, created.occurrenceId)).toMatchObject({
      state: 'confirmed', presentation: 'received', confirmedTransactionId: confirmed.transactionId,
    });
    expect((await target.financial.getCurrentBalance(target.ownerId)).currentBalanceMinor).toBe('1450000');
  }, 30_000);

  it('serializes competing confirmations to one transaction and one stable stale loser', async () => {
    const target = await fixture();
    const created = await target.schedule.createOneOff(
      target.ownerId,
      expenseSchedule(target),
      randomUUID(),
      randomUUID(),
    );
    const input = {
      amountMinor: '250000',
      occurredOn: '2026-10-15',
      categoryCode: 'rent',
      expenseClass: 'essential_fixed' as const,
      isUnexpected: false,
      expectedFinancialStateVersion: '2',
      reviewedLatestSnapshotId: target.snapshotId,
      reviewedOccurrenceVersion: '1',
    };
    const outcomes = await Promise.allSettled([
      target.schedule.confirmOccurrence(
        target.ownerId, created.occurrenceId, input, randomUUID(), randomUUID(),
      ),
      target.schedule.confirmOccurrence(
        target.ownerId, created.occurrenceId, input, randomUUID(), randomUUID(),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected'))
      .toMatchObject({ reason: { code: 'FINANCIAL_STATE_STALE' } });
    const rows = await database.query<{ id: string }>(`
      SELECT id FROM transactions WHERE user_id = $1
    `, [target.ownerId]);
    expect(rows.rows).toHaveLength(1);
    expect(await target.schedule.getOccurrence(target.ownerId, created.occurrenceId))
      .toMatchObject({ state: 'confirmed', version: '2' });
  }, 30_000);

  it('supports explicit skipped/cancelled terminals and keeps all objects owner-scoped', async () => {
    const target = await fixture();
    const other = await fixture();
    const skippedOccurrence = await target.schedule.createOneOff(
      target.ownerId,
      expenseSchedule(target),
      randomUUID(),
      randomUUID(),
    );
    const skipped = await target.schedule.transitionOccurrence(
      target.ownerId,
      skippedOccurrence.occurrenceId,
      'skipped',
      {
        reason: 'No payment due this month',
        expectedFinancialStateVersion: '2',
        reviewedLatestSnapshotId: target.snapshotId,
        reviewedOccurrenceVersion: '1',
      },
      randomUUID(),
      randomUUID(),
    );
    expect(skipped).toMatchObject({ state: 'skipped', financialStateVersion: '3' });
    expect(await target.schedule.getOccurrence(target.ownerId, skippedOccurrence.occurrenceId))
      .toMatchObject({ state: 'skipped', presentation: 'skipped', skipReason: 'No payment due this month' });
    await expect(target.schedule.confirmOccurrence(target.ownerId, skippedOccurrence.occurrenceId, {
      amountMinor: '300000',
      occurredOn: '2026-10-15',
      categoryCode: 'rent',
      expenseClass: 'essential_fixed',
      isUnexpected: false,
      expectedFinancialStateVersion: '3',
      reviewedLatestSnapshotId: target.snapshotId,
      reviewedOccurrenceVersion: '2',
    }, randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'FINANCIAL_STATE_STALE' });
    expect((await target.financial.getCurrentBalance(target.ownerId)).financialStateVersion).toBe('3');
    await expect(other.schedule.getOccurrence(other.ownerId, skippedOccurrence.occurrenceId))
      .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE' });
    await expect(other.schedule.confirmOccurrence(other.ownerId, skippedOccurrence.occurrenceId, {
      amountMinor: '1',
      occurredOn: '2026-10-15',
      categoryCode: 'rent',
      expenseClass: 'essential_fixed',
      isUnexpected: false,
      expectedFinancialStateVersion: '1',
      reviewedLatestSnapshotId: other.snapshotId,
      reviewedOccurrenceVersion: '2',
    }, randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE' });

    const cancelledOccurrence = await target.schedule.createOneOff(
      target.ownerId,
      { ...expenseSchedule(target, '3'), title: 'Cancelled rent', dueOn: '2026-11-15' },
      randomUUID(),
      randomUUID(),
    );
    await target.schedule.transitionOccurrence(
      target.ownerId,
      cancelledOccurrence.occurrenceId,
      'cancelled',
      {
        reason: 'Lease ended',
        expectedFinancialStateVersion: '4',
        reviewedLatestSnapshotId: target.snapshotId,
        reviewedOccurrenceVersion: '1',
      },
      randomUUID(),
      randomUUID(),
    );
    expect(await target.schedule.getOccurrence(target.ownerId, cancelledOccurrence.occurrenceId))
      .toMatchObject({ state: 'cancelled', presentation: 'cancelled', version: '2' });
    expect((await target.schedule.listOccurrences(target.ownerId, { state: 'scheduled', limit: 50 })).items)
      .toHaveLength(0);
  }, 30_000);
});
