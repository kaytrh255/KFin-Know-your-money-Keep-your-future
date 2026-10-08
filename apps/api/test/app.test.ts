import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FinancialError } from '@kfin/domain';
import { buildApp, type FinancialApiService } from '../src/app.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000003';
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000004';
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000005';

const transaction = {
  id: TRANSACTION_ID,
  kind: 'expense' as const,
  amountMinor: '1000',
  currency: 'VND',
  occurredOn: '2026-10-08',
  balanceEffect: 'current' as const,
  alreadyIncludedInSnapshot: false,
  categoryCode: 'food',
  expenseClass: 'daily' as const,
  isUnexpected: false,
  note: null,
  status: 'posted' as const,
  voidedAt: null,
  voidReason: null,
  supersedesTransactionId: null,
  supersededByTransactionId: null,
  corrected: false,
  balanceSnapshotId: SNAPSHOT_ID,
  createdAt: '2026-10-08T08:00:00.000Z',
  updatedAt: '2026-10-08T08:00:00.000Z',
  version: '1',
};

function correctionPreview() {
  return {
    operation: 'correction' as const,
    source: {
      transactionId: TRANSACTION_ID,
      amountMinor: '1000',
      occurredOn: '2026-10-08',
      categoryCode: 'food',
      expenseClass: 'daily' as const,
      isUnexpected: false,
      note: null,
    },
    replacement: {
      amountMinor: '900',
      occurredOn: '2026-10-08',
      categoryCode: 'food',
      expenseClass: 'daily' as const,
      isUnexpected: false,
      note: null,
    },
    authority: {
      currency: 'VND',
      balanceSnapshotId: SNAPSHOT_ID,
      snapshotEffectiveAt: '2026-10-08T00:00:00.000Z',
      balanceEffect: 'current' as const,
      alreadyIncludedInSnapshot: false,
      segment: 'latest' as const,
    },
    currentBalance: {
      beforeMinor: '999000',
      deltaMinor: '100',
      afterMinor: '999100',
      changes: true,
    },
    reports: {
      removed: { month: '2026-10', categoryCode: 'food', kind: 'expense' as const },
      added: { month: '2026-10', categoryCode: 'food', kind: 'expense' as const },
    },
    owningDomain: {
      type: 'none' as const,
      genericCorrectionSupported: true as const,
      genericVoidSupported: true as const,
    },
    context: {
      expectedFinancialStateVersion: '1',
      reviewedLatestSnapshotId: SNAPSHOT_ID,
      reviewedSourceVersion: '1',
      reviewedSourceSnapshotId: SNAPSHOT_ID,
      reviewedSourceBalanceEffect: 'current' as const,
      reviewedSourceAlreadyIncludedInSnapshot: false,
      reviewedSourceKind: 'expense' as const,
      reviewedSourceCurrency: 'VND',
      reviewedPreviewDigest: 'a'.repeat(64),
    },
  };
}

function service(): FinancialApiService {
  return {
    getCurrentBalance: vi.fn(async () => ({
      accountId: ACCOUNT_ID,
      currency: 'VND',
      financialStateVersion: '1',
      snapshot: {
        id: SNAPSHOT_ID,
        amountMinor: '1000000',
        effectiveAt: '2026-10-08T00:00:00.000Z',
        effectiveLocalDate: '2026-10-08',
      },
      postedCurrentIncomeMinor: '0',
      postedCurrentExpenseMinor: '0',
      currentBalanceMinor: '1000000',
    })),
    createSnapshot: vi.fn(async () => ({
      snapshotId: SNAPSHOT_ID,
      financialStateVersion: '2',
    })),
    createTransaction: vi.fn(async () => ({
      transactionId: TRANSACTION_ID,
      financialStateVersion: '2',
    })),
    getTransaction: vi.fn(async () => transaction),
    getTransactionCorrectionHistory: vi.fn(async () => ({ items: [transaction] })),
    listTransactions: vi.fn(async () => ({ items: [transaction], nextCursor: null })),
    previewTransactionCorrection: vi.fn(async () => correctionPreview()),
    previewTransactionVoid: vi.fn(async () => ({
      ...correctionPreview(),
      operation: 'void' as const,
      replacement: null,
      currentBalance: {
        beforeMinor: '999000',
        deltaMinor: '1000',
        afterMinor: '1000000',
        changes: true,
      },
      reports: {
        removed: { month: '2026-10', categoryCode: 'food', kind: 'expense' as const },
        added: null,
      },
    })),
    correctTransaction: vi.fn(async () => ({
      sourceTransactionId: TRANSACTION_ID,
      replacementTransactionId: '00000000-0000-4000-8000-000000000006',
      financialStateVersion: '2',
    })),
    voidTransaction: vi.fn(async () => ({
      sourceTransactionId: TRANSACTION_ID,
      replacementTransactionId: null,
      financialStateVersion: '2',
    })),
    getMonthlyActuals: vi.fn(async () => ({
      month: '2026-10',
      currency: 'VND',
      incomeMinor: '0',
      expenseMinor: '1000',
      netMinor: '-1000',
      groups: [{
        categoryCode: 'food',
        kind: 'expense' as const,
        amountMinor: '1000',
        transactionCount: 1,
        amended: false,
      }],
    })),
  };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('KFin API ownership boundary', () => {
  it('fails closed when no trusted authenticator establishes a principal', async () => {
    const financialService = service();
    const app = await buildApp({ financialService, authenticate: async () => null });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/financial-account' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(financialService.getCurrentBalance).not.toHaveBeenCalled();
  });

  it('derives owner scope from authentication and never from request data', async () => {
    const financialService = service();
    const app = await buildApp({
      financialService,
      authenticate: async () => ({ userId: USER_ID }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers: { 'idempotency-key': 'client-key-1' },
      payload: {
        kind: 'expense',
        amountMinor: '1000',
        occurredOn: '2026-10-08',
        categoryCode: 'food',
        expenseClass: 'daily',
        isUnexpected: false,
        expectedFinancialStateVersion: '1',
        reviewedLatestSnapshotId: SNAPSHOT_ID,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(financialService.createTransaction).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ amountMinor: '1000' }),
      'client-key-1',
      expect.any(String),
    );
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects client-supplied userId instead of allowing mass assignment', async () => {
    const financialService = service();
    const app = await buildApp({
      financialService,
      authenticate: async () => ({ userId: USER_ID }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers: { 'idempotency-key': 'client-key-2' },
      payload: {
        userId: OTHER_USER_ID,
        kind: 'expense',
        amountMinor: '1000',
        occurredOn: '2026-10-08',
        categoryCode: 'food',
        expenseClass: 'daily',
        isUnexpected: false,
        expectedFinancialStateVersion: '1',
        reviewedLatestSnapshotId: SNAPSHOT_ID,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
    expect(financialService.createTransaction).not.toHaveBeenCalled();
  });

  it('passes authenticated owner scope to object lookup for BOLA resistance', async () => {
    const financialService = service();
    const app = await buildApp({
      financialService,
      authenticate: async () => ({ userId: USER_ID }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/transactions/${TRANSACTION_ID}`,
    });
    expect(response.statusCode).toBe(200);
    expect(financialService.getTransaction).toHaveBeenCalledWith(USER_ID, TRANSACTION_ID);
  });

  it('requires an owner-scoped authoritative preview before correction commit', async () => {
    const financialService = service();
    const app = await buildApp({
      financialService,
      authenticate: async () => ({ userId: USER_ID }),
    });
    apps.push(app);

    const previewPayload = {
      reason: 'Fix entered amount',
      replacement: {
        amountMinor: '900',
        occurredOn: '2026-10-08',
        categoryCode: 'food',
        expenseClass: 'daily',
        isUnexpected: false,
      },
    };
    const preview = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${TRANSACTION_ID}/correction-preview`,
      payload: previewPayload,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().currentBalance).toMatchObject({ deltaMinor: '100', afterMinor: '999100' });
    expect(financialService.previewTransactionCorrection).toHaveBeenCalledWith(
      USER_ID,
      TRANSACTION_ID,
      expect.objectContaining({ reason: 'Fix entered amount' }),
    );

    const commit = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${TRANSACTION_ID}/corrections`,
      headers: { 'idempotency-key': 'correction-key' },
      payload: { ...previewPayload, context: preview.json().context },
    });
    expect(commit.statusCode).toBe(201);
    expect(financialService.correctTransaction).toHaveBeenCalledWith(
      USER_ID,
      TRANSACTION_ID,
      expect.objectContaining({ context: preview.json().context }),
      'correction-key',
      expect.any(String),
    );
    expect(commit.headers['cache-control']).toBe('no-store');
  });

  it('owner-scopes correction history and monthly amended reporting', async () => {
    const financialService = service();
    const app = await buildApp({
      financialService,
      authenticate: async () => ({ userId: USER_ID }),
    });
    apps.push(app);

    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/transactions/${TRANSACTION_ID}/correction-history`,
    });
    expect(history.statusCode).toBe(200);
    expect(financialService.getTransactionCorrectionHistory).toHaveBeenCalledWith(
      USER_ID,
      TRANSACTION_ID,
    );

    const report = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/monthly-actuals?month=2026-10',
    });
    expect(report.statusCode).toBe(200);
    expect(financialService.getMonthlyActuals).toHaveBeenCalledWith(USER_ID, '2026-10');
  });

  it('returns only stable safe errors and retry guidance', async () => {
    const financialService = service();
    financialService.createSnapshot = vi.fn(async () => {
      throw new FinancialError({
        code: 'FINANCIAL_CONCURRENCY_BUSY',
        statusCode: 503,
        safeMessage: 'The financial account is busy. Retry with the same idempotency key.',
        retryAfterSeconds: 1,
        cause: new Error('sensitive SQL detail'),
      });
    });
    const app = await buildApp({
      financialService,
      authenticate: async () => ({ userId: USER_ID }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account/snapshots',
      headers: { 'idempotency-key': 'snapshot-key' },
      payload: {
        amountMinor: '1000',
        effectiveAt: '2026-10-08T08:00:00.000Z',
        expectedFinancialStateVersion: '1',
        reviewedLatestSnapshotId: SNAPSHOT_ID,
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.body).not.toContain('SQL');
    expect(response.json().error).toMatchObject({ code: 'FINANCIAL_CONCURRENCY_BUSY' });
  });

  it('generates OpenAPI for the minimal financial routes', async () => {
    const app = await buildApp({ financialService: service(), authenticate: async () => null });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const contract = response.json();
    const paths = Object.keys(contract.paths);
    expect(contract.servers).toContainEqual({ url: '/api/v1' });
    expect(paths).toContain('/financial-account');
    expect(paths).toContain('/financial-account/snapshots');
    expect(paths).toContain('/transactions');
    expect(paths).toContain('/transactions/{id}');
    expect(paths).toContain('/transactions/{id}/correction-preview');
    expect(paths).toContain('/transactions/{id}/corrections');
    expect(paths).toContain('/transactions/{id}/void-preview');
    expect(paths).toContain('/transactions/{id}/void');
    expect(paths).toContain('/transactions/{id}/correction-history');
    expect(paths).toContain('/reports/monthly-actuals');
  });
});
