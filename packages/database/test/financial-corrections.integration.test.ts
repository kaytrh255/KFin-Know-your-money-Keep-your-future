import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FinancialAccountBootstrapService,
  migrateDatabase,
  PostgresFinancialRepository,
  PostgresUserRepository,
  type CorrectionPreviewView,
} from '../src/index.js';

const integrationEnabled = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.KFIN_INTEGRATION_TARGET === 'non-production',
);
const integration = describe.skipIf(!integrationEnabled);
const NOW = new Date('2026-10-15T05:00:00.000Z');
const RETENTION_MS = 86_400_000;

interface Fixture {
  readonly ownerId: string;
  readonly repository: PostgresFinancialRepository;
  readonly snapshotId: string;
}

integration('snapshot_correction.v1 on real PostgreSQL', () => {
  let administration: Pool;
  let database: Pool;
  let schema: string;

  beforeAll(async () => {
    schema = `kfin_correction_it_${randomUUID().replaceAll('-', '')}`;
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

  async function fixture(
    effectiveAt = new Date('2026-10-01T05:00:00.000Z'),
    openingAmountMinor = '1000000',
  ): Promise<Fixture> {
    const user = await new PostgresUserRepository(database, () => NOW.getTime()).create({
      email: `correction-${randomUUID()}@example.invalid`,
      locale: 'en-VN',
      timezone: 'Asia/Ho_Chi_Minh',
      baseCurrency: 'VND',
      emailVerifiedAt: new Date(NOW.getTime() - 1_000),
    });
    const foundation = await new FinancialAccountBootstrapService(
      database,
      () => NOW.getTime(),
    ).bootstrap({
      ownerUserId: user.id,
      openingAmountMinor,
      effectiveAt,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      idempotencyRetentionMs: RETENTION_MS,
    });
    return {
      ownerId: user.id,
      repository: new PostgresFinancialRepository(database, RETENTION_MS, () => NOW),
      snapshotId: foundation.snapshotId,
    };
  }

  async function createExpense(
    target: Fixture,
    input: {
      amountMinor: string;
      occurredOn: string;
      expectedVersion?: string;
      snapshotId?: string;
      alreadyIncludedInSnapshot?: boolean;
    },
  ) {
    return target.repository.createTransaction(target.ownerId, {
      kind: 'expense',
      amountMinor: input.amountMinor,
      occurredOn: input.occurredOn,
      categoryCode: 'food',
      expenseClass: 'daily',
      isUnexpected: false,
      expectedFinancialStateVersion: input.expectedVersion ?? '1',
      reviewedLatestSnapshotId: input.snapshotId ?? target.snapshotId,
      ...(input.alreadyIncludedInSnapshot === undefined
        ? {}
        : { alreadyIncludedInSnapshot: input.alreadyIncludedInSnapshot }),
    }, randomUUID(), randomUUID());
  }

  async function previewAmount(
    target: Fixture,
    sourceTransactionId: string,
    amountMinor: string,
    occurredOn: string,
  ): Promise<CorrectionPreviewView> {
    return target.repository.previewTransactionCorrection(target.ownerId, sourceTransactionId, {
      reason: 'Correct entered financial fact',
      replacement: {
        amountMinor,
        occurredOn,
        categoryCode: 'food',
        expenseClass: 'daily',
        isUnexpected: false,
      },
    });
  }

  it('FIN-COR-01/09: corrects one latest effect, exposes its chain, reports only replacement, and replays', async () => {
    const target = await fixture();
    const created = await createExpense(target, { amountMinor: '300000', occurredOn: '2026-10-10' });
    const preview = await previewAmount(target, created.transactionId, '250000', '2026-10-10');
    expect(preview.currentBalance).toEqual({
      beforeMinor: '700000',
      deltaMinor: '50000',
      afterMinor: '750000',
      changes: true,
    });
    expect(preview.authority).toMatchObject({ segment: 'latest', balanceEffect: 'current' });

    const key = randomUUID();
    const input = {
      reason: 'Correct entered financial fact',
      replacement: {
        amountMinor: '250000',
        occurredOn: '2026-10-10',
        categoryCode: 'food',
        expenseClass: 'daily' as const,
        isUnexpected: false,
      },
      context: preview.context,
    };
    const corrected = await target.repository.correctTransaction(
      target.ownerId,
      created.transactionId,
      input,
      key,
      randomUUID(),
    );
    expect(corrected).toMatchObject({ sourceTransactionId: created.transactionId, financialStateVersion: '3' });
    expect((await target.repository.getCurrentBalance(target.ownerId)).currentBalanceMinor).toBe('750000');

    const history = await target.repository.getTransactionCorrectionHistory(
      target.ownerId,
      corrected.replacementTransactionId!,
    );
    expect(history.items).toHaveLength(2);
    expect(history.items[0]).toMatchObject({
      id: created.transactionId,
      status: 'voided',
      supersededByTransactionId: corrected.replacementTransactionId,
      corrected: true,
    });
    expect(history.items[1]).toMatchObject({
      id: corrected.replacementTransactionId,
      status: 'posted',
      supersedesTransactionId: created.transactionId,
      amountMinor: '250000',
      corrected: true,
    });

    const report = await target.repository.getMonthlyActuals(target.ownerId, '2026-10');
    expect(report).toMatchObject({ expenseMinor: '250000', netMinor: '-250000' });
    expect(report.groups).toContainEqual(expect.objectContaining({
      categoryCode: 'food', amountMinor: '250000', transactionCount: 1, amended: true,
    }));

    await expect(target.repository.correctTransaction(
      target.ownerId,
      created.transactionId,
      input,
      key,
      randomUUID(),
    )).resolves.toEqual(corrected);
    await expect(target.repository.correctTransaction(
      target.ownerId,
      created.transactionId,
      { ...input, replacement: { ...input.replacement, amountMinor: '240000' } },
      key,
      randomUUID(),
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const receipt = await database.query<{ result: Record<string, unknown> }>(`
      SELECT result FROM idempotency_results
      WHERE user_id = $1 AND operation = 'financial.transaction.correct'
    `, [target.ownerId]);
    expect(receipt.rows).toHaveLength(1);
    expect(receipt.rows[0]?.result).toEqual({
      sourceTransactionId: created.transactionId,
      replacementTransactionId: corrected.replacementTransactionId,
      financialStateVersion: '3',
    });
    expect(JSON.stringify(receipt.rows[0]?.result)).not.toContain('250000');
  }, 30_000);

  it('FIN-COR-02/04: amends a closed segment and moves active reporting without changing current balance', async () => {
    const target = await fixture(new Date('2026-08-01T05:00:00.000Z'));
    const created = await createExpense(target, { amountMinor: '300000', occurredOn: '2026-08-15' });
    const nextSnapshot = await target.repository.createSnapshot(target.ownerId, {
      amountMinor: '900000',
      effectiveAt: '2026-10-01T05:00:00.000Z',
      expectedFinancialStateVersion: '2',
      reviewedLatestSnapshotId: target.snapshotId,
    }, randomUUID(), randomUUID());

    const preview = await previewAmount(target, created.transactionId, '250000', '2026-09-15');
    expect(preview.authority.segment).toBe('closed');
    expect(preview.currentBalance).toEqual({
      beforeMinor: '900000', deltaMinor: '0', afterMinor: '900000', changes: false,
    });
    expect(preview.reports).toMatchObject({
      removed: { month: '2026-08' },
      added: { month: '2026-09' },
    });

    await target.repository.correctTransaction(target.ownerId, created.transactionId, {
      reason: 'Correct entered financial fact',
      replacement: {
        amountMinor: '250000',
        occurredOn: '2026-09-15',
        categoryCode: 'food',
        expenseClass: 'daily',
        isUnexpected: false,
      },
      context: preview.context,
    }, randomUUID(), randomUUID());
    expect((await target.repository.getCurrentBalance(target.ownerId))).toMatchObject({
      currentBalanceMinor: '900000', financialStateVersion: '4', snapshot: { id: nextSnapshot.snapshotId },
    });
    expect((await target.repository.getMonthlyActuals(target.ownerId, '2026-08')).expenseMinor).toBe('0');
    expect((await target.repository.getMonthlyActuals(target.ownerId, '2026-09')).expenseMinor).toBe('250000');
  }, 30_000);

  it('FIN-COR-03: corrects historical reporting with zero current-balance effect', async () => {
    const target = await fixture(new Date('2026-10-10T05:00:00.000Z'));
    const created = await createExpense(target, {
      amountMinor: '300000',
      occurredOn: '2026-10-05',
      alreadyIncludedInSnapshot: true,
    });
    const preview = await previewAmount(target, created.transactionId, '250000', '2026-10-05');
    expect(preview.authority.balanceEffect).toBe('historical');
    expect(preview.currentBalance.deltaMinor).toBe('0');
    await target.repository.correctTransaction(target.ownerId, created.transactionId, {
      reason: 'Correct entered financial fact',
      replacement: {
        amountMinor: '250000',
        occurredOn: '2026-10-05',
        categoryCode: 'food',
        expenseClass: 'daily',
        isUnexpected: false,
      },
      context: preview.context,
    }, randomUUID(), randomUUID());
    expect((await target.repository.getCurrentBalance(target.ownerId)).currentBalanceMinor).toBe('1000000');
    expect((await target.repository.getMonthlyActuals(target.ownerId, '2026-10')).expenseMinor).toBe('250000');
  }, 30_000);

  it('FIN-COR-05/06: rejects cross-anchor dates and reviewed authority tampering with no write', async () => {
    const target = await fixture(new Date('2026-08-01T05:00:00.000Z'));
    const created = await createExpense(target, { amountMinor: '300000', occurredOn: '2026-08-15' });
    await target.repository.createSnapshot(target.ownerId, {
      amountMinor: '900000',
      effectiveAt: '2026-10-01T05:00:00.000Z',
      expectedFinancialStateVersion: '2',
      reviewedLatestSnapshotId: target.snapshotId,
    }, randomUUID(), randomUUID());

    await expect(previewAmount(target, created.transactionId, '250000', '2026-10-02')).rejects.toMatchObject({
      code: 'FIN_CORRECTION_CROSS_SEGMENT_UNSUPPORTED',
    });
    const validPreview = await previewAmount(target, created.transactionId, '250000', '2026-09-15');
    const reviewedInput = {
      reason: 'Correct entered financial fact',
      replacement: {
        amountMinor: '250000',
        occurredOn: '2026-09-15',
        categoryCode: 'food',
        expenseClass: 'daily' as const,
        isUnexpected: false,
      },
      context: validPreview.context,
    };
    await expect(target.repository.correctTransaction(target.ownerId, created.transactionId, {
      ...reviewedInput,
      context: { ...validPreview.context, reviewedSourceBalanceEffect: 'historical' },
    }, randomUUID(), randomUUID())).rejects.toMatchObject({
      code: 'FIN_CORRECTION_EFFECT_CHANGE_UNSUPPORTED',
    });
    await expect(target.repository.correctTransaction(target.ownerId, created.transactionId, {
      ...reviewedInput,
      replacement: { ...reviewedInput.replacement, amountMinor: '240000' },
    }, randomUUID(), randomUUID())).rejects.toMatchObject({
      code: 'FIN_CORRECTION_INVALID_TRANSITION',
    });
    const source = await target.repository.getTransaction(target.ownerId, created.transactionId);
    expect(source).toMatchObject({ status: 'posted', version: '1' });
    expect((await target.repository.getCurrentBalance(target.ownerId)).financialStateVersion).toBe('3');
  }, 30_000);

  it('FIN-COR-07: standalone void reverses a latest effect exactly once and replays', async () => {
    const target = await fixture();
    const created = await createExpense(target, { amountMinor: '300000', occurredOn: '2026-10-10' });
    const preview = await target.repository.previewTransactionVoid(target.ownerId, created.transactionId, {
      reason: 'Remove duplicate entry',
    });
    expect(preview).toMatchObject({
      operation: 'void', replacement: null,
      currentBalance: { beforeMinor: '700000', deltaMinor: '300000', afterMinor: '1000000' },
    });
    const key = randomUUID();
    const input = { reason: 'Remove duplicate entry', context: preview.context };
    const voided = await target.repository.voidTransaction(
      target.ownerId,
      created.transactionId,
      input,
      key,
      randomUUID(),
    );
    expect(voided).toEqual({
      sourceTransactionId: created.transactionId,
      replacementTransactionId: null,
      financialStateVersion: '3',
    });
    expect((await target.repository.getCurrentBalance(target.ownerId)).currentBalanceMinor).toBe('1000000');
    await expect(target.repository.voidTransaction(
      target.ownerId,
      created.transactionId,
      input,
      key,
      randomUUID(),
    )).resolves.toEqual(voided);
    expect((await target.repository.getTransactionCorrectionHistory(target.ownerId, created.transactionId)).items)
      .toHaveLength(1);
  }, 30_000);

  it('FIN-COR-09/10: concurrent requests yield one chain winner and one stable stale loser', async () => {
    const sameKeyTarget = await fixture();
    const sameKeySource = await createExpense(sameKeyTarget, {
      amountMinor: '300000', occurredOn: '2026-10-10',
    });
    const sameKeyPreview = await previewAmount(
      sameKeyTarget,
      sameKeySource.transactionId,
      '250000',
      '2026-10-10',
    );
    const sameKeyInput = {
      reason: 'Correct entered financial fact',
      replacement: {
        amountMinor: '250000', occurredOn: '2026-10-10', categoryCode: 'food',
        expenseClass: 'daily' as const, isUnexpected: false,
      },
      context: sameKeyPreview.context,
    };
    const key = randomUUID();
    const compatible = await Promise.all([
      sameKeyTarget.repository.correctTransaction(
        sameKeyTarget.ownerId, sameKeySource.transactionId, sameKeyInput, key, randomUUID(),
      ),
      sameKeyTarget.repository.correctTransaction(
        sameKeyTarget.ownerId, sameKeySource.transactionId, sameKeyInput, key, randomUUID(),
      ),
    ]);
    expect(compatible[0]).toEqual(compatible[1]);

    const competingTarget = await fixture();
    const competingSource = await createExpense(competingTarget, {
      amountMinor: '300000', occurredOn: '2026-10-10',
    });
    const competingPreview = await previewAmount(
      competingTarget,
      competingSource.transactionId,
      '250000',
      '2026-10-10',
    );
    const competingPreviewB = await previewAmount(
      competingTarget,
      competingSource.transactionId,
      '240000',
      '2026-10-10',
    );
    const baseInput = {
      reason: 'Correct entered financial fact',
      replacement: {
        amountMinor: '250000', occurredOn: '2026-10-10', categoryCode: 'food',
        expenseClass: 'daily' as const, isUnexpected: false,
      },
      context: competingPreview.context,
    };
    const competingInput = {
      ...baseInput,
      replacement: { ...baseInput.replacement, amountMinor: '240000' },
      context: competingPreviewB.context,
    };
    const outcomes = await Promise.allSettled([
      competingTarget.repository.correctTransaction(
        competingTarget.ownerId, competingSource.transactionId, baseInput, randomUUID(), randomUUID(),
      ),
      competingTarget.repository.correctTransaction(
        competingTarget.ownerId,
        competingSource.transactionId,
        competingInput,
        randomUUID(),
        randomUUID(),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'FIN_CORRECTION_STALE_STATE' } });
    expect((await competingTarget.repository.getCurrentBalance(competingTarget.ownerId)).financialStateVersion)
      .toBe('3');
    const rows = await database.query<{ status: string }>(`
      SELECT status FROM transactions WHERE user_id = $1
    `, [competingTarget.ownerId]);
    expect(rows.rows.filter((row) => row.status === 'posted')).toHaveLength(1);
    expect(rows.rows.filter((row) => row.status === 'voided')).toHaveLength(1);
  }, 30_000);

  it('FIN-COR-10: snapshot/correction race has exactly one version winner and no auto-reanchor', async () => {
    const target = await fixture();
    const created = await createExpense(target, { amountMinor: '300000', occurredOn: '2026-10-10' });
    const preview = await previewAmount(target, created.transactionId, '250000', '2026-10-10');
    const outcomes = await Promise.allSettled([
      target.repository.correctTransaction(target.ownerId, created.transactionId, {
        reason: 'Correct entered financial fact',
        replacement: {
          amountMinor: '250000', occurredOn: '2026-10-10', categoryCode: 'food',
          expenseClass: 'daily', isUnexpected: false,
        },
        context: preview.context,
      }, randomUUID(), randomUUID()),
      target.repository.createSnapshot(target.ownerId, {
        amountMinor: '900000',
        effectiveAt: '2026-10-14T05:00:00.000Z',
        expectedFinancialStateVersion: preview.context.expectedFinancialStateVersion,
        reviewedLatestSnapshotId: preview.context.reviewedLatestSnapshotId,
      }, randomUUID(), randomUUID()),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(['FIN_CORRECTION_STALE_STATE', 'FIN_SNAPSHOT_STALE_STATE']).toContain(
      rejected?.status === 'rejected' ? (rejected.reason as { code?: string }).code : undefined,
    );
    expect((await target.repository.getCurrentBalance(target.ownerId)).financialStateVersion).toBe('3');
    const source = await target.repository.getTransaction(target.ownerId, created.transactionId);
    if (source.status === 'voided') {
      const history = await target.repository.getTransactionCorrectionHistory(target.ownerId, source.id);
      expect(history.items[1]?.balanceSnapshotId).toBe(source.balanceSnapshotId);
    } else {
      expect(source).toMatchObject({ status: 'posted', version: '1' });
    }
  }, 30_000);

  it('keeps preview, mutation, history, and reports owner-scoped', async () => {
    const owner = await fixture();
    const other = await fixture();
    const created = await createExpense(owner, { amountMinor: '300000', occurredOn: '2026-10-10' });
    await expect(other.repository.previewTransactionVoid(other.ownerId, created.transactionId, {
      reason: 'Attempt foreign void',
    })).rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE' });
    await expect(other.repository.getTransactionCorrectionHistory(other.ownerId, created.transactionId))
      .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE' });
    expect((await other.repository.getMonthlyActuals(other.ownerId, '2026-10')).expenseMinor).toBe('0');
    expect((await owner.repository.getTransaction(owner.ownerId, created.transactionId)).status).toBe('posted');
  }, 30_000);
});
