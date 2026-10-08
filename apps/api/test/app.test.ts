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
  balanceSnapshotId: SNAPSHOT_ID,
  createdAt: '2026-10-08T08:00:00.000Z',
  updatedAt: '2026-10-08T08:00:00.000Z',
  version: '1',
};

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
    listTransactions: vi.fn(async () => ({ items: [transaction], nextCursor: null })),
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
  });
});
