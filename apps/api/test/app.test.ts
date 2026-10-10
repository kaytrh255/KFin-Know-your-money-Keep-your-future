import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FinancialError } from '@kfin/domain';
import {
  buildApp,
  type FinancialApiService,
  type ScheduleApiService,
} from '../src/app.js';
import type { AuthApiService } from '../src/auth-routes.js';
import type { AuthenticatedPrincipal } from '../src/types.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000003';
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000004';
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000005';
const SCHEDULED_ITEM_ID = '00000000-0000-4000-8000-000000000007';
const OCCURRENCE_ID = '00000000-0000-4000-8000-000000000008';
const SESSION_ID = '00000000-0000-4000-8000-000000000006';
const CSRF_TOKEN = 'csrf-token-value-0123456789';
const CSRF_DIGEST = 'bound-csrf-digest';
const BROWSER = { host: 'api.kfin.test', origin: 'https://api.kfin.test' };
const PROTECTED = { ...BROWSER, 'x-kfin-csrf': CSRF_TOKEN };
const CREATE_TRANSACTION_BODY = {
  kind: 'expense' as const,
  amountMinor: '1000',
  occurredOn: '2026-10-08',
  categoryCode: 'food',
  expenseClass: 'daily' as const,
  isUnexpected: false,
  expectedFinancialStateVersion: '1',
  reviewedLatestSnapshotId: SNAPSHOT_ID,
};

function csrfVerifier(): AuthApiService {
  return {
    verifyCsrfToken: vi.fn((presented: string | null | undefined, digest: string) => (
      presented === CSRF_TOKEN && digest === CSRF_DIGEST
    )),
  } as unknown as AuthApiService;
}

/** Milestone 07: app wired like production for the one-time transaction write. */
async function buildProtectedTransactionApp(options: {
  financialService: FinancialApiService;
  principal?: AuthenticatedPrincipal | null;
  authVerifier?: AuthApiService | null;
}): Promise<FastifyInstance> {
  const principal = options.principal === undefined
    ? { userId: USER_ID, sessionId: SESSION_ID, csrfDigest: CSRF_DIGEST }
    : options.principal;
  const app = await buildApp({
    financialService: options.financialService,
    ...(options.authVerifier === null
      ? {}
      : { authService: options.authVerifier ?? csrfVerifier() }),
    authenticate: async () => principal,
  });
  apps.push(app);
  return app;
}

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
      unsupportedReasonCode: null,
      scheduleOccurrenceId: null,
      scheduleOccurrenceVersion: null,
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
      reviewedUserTimezone: 'Asia/Ho_Chi_Minh',
      reviewedUserVersion: '1',
      reviewedOwningDomain: {
        type: 'none' as const,
        scheduleOccurrenceId: null,
        scheduleOccurrenceVersion: null,
      },
      reviewedPreviewDigest: 'a'.repeat(64),
    },
  };
}

function service(): FinancialApiService {
  return {
    openFinancialAccount: vi.fn(async () => ({
      accountId: ACCOUNT_ID,
      snapshotId: SNAPSHOT_ID,
      financialStateVersion: '1',
      replayed: false,
    })),
    listFinancialAccounts: vi.fn(async () => ({ items: [] })),
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
      replayed: false,
    })),
    getTransaction: vi.fn(async () => transaction),
    getTransactionCorrectionHistory: vi.fn(async () => ({ items: [transaction], nextCursor: null })),
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
      consequence: {
        currentBalance: correctionPreview().currentBalance,
        reports: correctionPreview().reports,
        owningDomain: {
          type: 'none' as const,
          scheduleOccurrenceId: null,
          scheduleOccurrenceVersion: null,
        },
      },
    })),
    voidTransaction: vi.fn(async () => ({
      sourceTransactionId: TRANSACTION_ID,
      replacementTransactionId: null,
      financialStateVersion: '2',
      consequence: {
        currentBalance: {
          beforeMinor: '999000', deltaMinor: '1000', afterMinor: '1000000', changes: true,
        },
        reports: {
          removed: { month: '2026-10', categoryCode: 'food', kind: 'expense' as const },
          added: null,
        },
        owningDomain: {
          type: 'none' as const,
          scheduleOccurrenceId: null,
          scheduleOccurrenceVersion: null,
        },
      },
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
        balanceEffect: 'current' as const,
        amountMinor: '1000',
        transactionCount: 1,
        amended: false,
        drilldown: {
          month: '2026-10',
          categoryCode: 'food',
          kind: 'expense' as const,
          balanceEffect: 'current' as const,
        },
      }],
    })),
  };
}

function scheduleService(): ScheduleApiService {
  const occurrence = {
    id: OCCURRENCE_ID,
    scheduledItemId: SCHEDULED_ITEM_ID,
    title: 'Rent',
    kind: 'expense' as const,
    direction: 'outgoing' as const,
    expectedAmountMinor: '12000000',
    currency: 'VND',
    dueOn: '2026-10-15',
    categoryCode: 'housing',
    expenseClass: 'essential_fixed' as const,
    state: 'scheduled' as const,
    presentation: 'upcoming' as const,
    confirmedTransactionId: null,
    confirmedAt: null,
    skippedAt: null,
    skipReason: null,
    cancelledAt: null,
    version: '1',
  };
  return {
    createOneOff: vi.fn(async () => ({
      scheduledItemId: SCHEDULED_ITEM_ID,
      occurrenceId: OCCURRENCE_ID,
      financialStateVersion: '2',
    })),
    getOccurrence: vi.fn(async () => occurrence),
    listOccurrences: vi.fn(async () => ({ items: [occurrence], nextCursor: null })),
    confirmOccurrence: vi.fn(async () => ({
      occurrenceId: OCCURRENCE_ID,
      transactionId: TRANSACTION_ID,
      state: 'confirmed' as const,
      financialStateVersion: '3',
      occurrenceVersion: '2',
    })),
    transitionOccurrence: vi.fn(async (_owner, _id, state) => ({
      occurrenceId: OCCURRENCE_ID,
      state,
      financialStateVersion: '3',
      occurrenceVersion: '2',
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
    const app = await buildProtectedTransactionApp({ financialService });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers: { ...PROTECTED, 'idempotency-key': 'client-key-1' },
      payload: CREATE_TRANSACTION_BODY,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      transactionId: TRANSACTION_ID,
      financialStateVersion: '2',
    });
    expect(financialService.createTransaction).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ amountMinor: '1000' }),
      'client-key-1',
      expect.any(String),
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['idempotency-replayed']).toBeUndefined();
  });

  it('rejects client-supplied userId instead of allowing mass assignment', async () => {
    const financialService = service();
    const app = await buildProtectedTransactionApp({ financialService });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers: { ...PROTECTED, 'idempotency-key': 'client-key-2' },
      payload: { userId: OTHER_USER_ID, ...CREATE_TRANSACTION_BODY },
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
      url: `/api/v1/transactions/${TRANSACTION_ID}/correction-history?limit=1&cursor=opaque-next`,
    });
    expect(history.statusCode).toBe(200);
    expect(financialService.getTransactionCorrectionHistory).toHaveBeenCalledWith(
      USER_ID,
      TRANSACTION_ID,
      { limit: 1, cursor: 'opaque-next' },
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
    const app = await buildProtectedTransactionApp({ financialService });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account/snapshots',
      // Milestone 08: this route is CSRF-protected, so the envelope assertion
      // now sends the same browser headers the guard requires.
      headers: { ...PROTECTED, 'idempotency-key': 'snapshot-key' },
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
    expect(paths).toContain('/financial-accounts');
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

describe('one-off schedule occurrence API', () => {
  it('owner-scopes one-off creation and explicit confirmation', async () => {
    const schedule = scheduleService();
    const app = await buildApp({
      financialService: service(),
      scheduleService: schedule,
      authenticate: async () => ({ userId: USER_ID }),
    });
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/schedule/one-off',
      headers: { 'idempotency-key': 'schedule-create-key' },
      payload: {
        title: 'Rent',
        kind: 'expense',
        expectedAmountMinor: '12000000',
        dueOn: '2026-10-15',
        categoryCode: 'housing',
        expenseClass: 'essential_fixed',
        expectedFinancialStateVersion: '1',
        reviewedLatestSnapshotId: SNAPSHOT_ID,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(schedule.createOneOff).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ title: 'Rent', dueOn: '2026-10-15' }),
      'schedule-create-key',
      expect.any(String),
    );

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/schedule/occurrences/${OCCURRENCE_ID}/confirm`,
      headers: { 'idempotency-key': 'schedule-confirm-key' },
      payload: {
        amountMinor: '11900000',
        occurredOn: '2026-10-15',
        categoryCode: 'housing',
        expenseClass: 'essential_fixed',
        isUnexpected: false,
        expectedFinancialStateVersion: '2',
        reviewedLatestSnapshotId: SNAPSHOT_ID,
        reviewedOccurrenceVersion: '1',
      },
    });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json()).toMatchObject({ state: 'confirmed', occurrenceVersion: '2' });
    expect(schedule.confirmOccurrence).toHaveBeenCalledWith(
      USER_ID,
      OCCURRENCE_ID,
      expect.objectContaining({ amountMinor: '11900000', reviewedOccurrenceVersion: '1' }),
      'schedule-confirm-key',
      expect.any(String),
    );
  });

  it('rejects recurrence, owner injection, and presentation aliases at the strict boundary', async () => {
    const schedule = scheduleService();
    const app = await buildApp({
      financialService: service(),
      scheduleService: schedule,
      authenticate: async () => ({ userId: USER_ID }),
    });
    apps.push(app);

    const invalidCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/schedule/one-off',
      headers: { 'idempotency-key': 'schedule-invalid-key' },
      payload: {
        userId: OTHER_USER_ID,
        title: 'Rent',
        kind: 'expense',
        expectedAmountMinor: '12000000',
        dueOn: '2026-10-15',
        categoryCode: 'housing',
        expenseClass: 'essential_fixed',
        frequency: 'monthly',
        state: 'paid',
        expectedFinancialStateVersion: '1',
        reviewedLatestSnapshotId: SNAPSHOT_ID,
      },
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(schedule.createOneOff).not.toHaveBeenCalled();

    const invalidFilter = await app.inject({
      method: 'GET',
      url: '/api/v1/schedule/occurrences?state=paid',
    });
    expect(invalidFilter.statusCode).toBe(400);
    expect(schedule.listOccurrences).not.toHaveBeenCalled();

    const paidFilterMapping = await app.inject({
      method: 'GET',
      url: '/api/v1/schedule/occurrences?state=confirmed&kind=expense&limit=1&cursor=opaque-next',
    });
    expect(paidFilterMapping.statusCode).toBe(200);
    expect(schedule.listOccurrences).toHaveBeenCalledWith(USER_ID, {
      state: 'confirmed',
      kind: 'expense',
      limit: 1,
      cursor: 'opaque-next',
    });
  });

  it('fails closed without authentication and exposes only accepted schedule routes', async () => {
    const schedule = scheduleService();
    const app = await buildApp({
      financialService: service(),
      scheduleService: schedule,
      authenticate: async () => null,
    });
    apps.push(app);

    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/schedule/occurrences/${OCCURRENCE_ID}`,
    });
    expect(denied.statusCode).toBe(401);
    expect(schedule.getOccurrence).not.toHaveBeenCalled();

    const openapi = await app.inject({ method: 'GET', url: '/openapi.json' });
    const paths = Object.keys(openapi.json().paths);
    expect(paths).toContain('/schedule/one-off');
    expect(paths).toContain('/schedule/occurrences');
    expect(paths).toContain('/schedule/occurrences/{id}');
    expect(paths).toContain('/schedule/occurrences/{id}/confirm');
    expect(paths).toContain('/schedule/occurrences/{id}/skip');
    expect(paths).toContain('/schedule/occurrences/{id}/cancel');
  });
});

describe('Milestone 07 — one-time transaction write defense (PRD-INC-01, SEC-APP browser state changes)', () => {
  it('rejects unauthenticated requests with 401 before reaching the service', async () => {
    const financialService = service();
    const app = await buildProtectedTransactionApp({ financialService, principal: null });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers: { ...PROTECTED, 'idempotency-key': 'm07-unauthenticated' },
      payload: CREATE_TRANSACTION_BODY,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(financialService.createTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['missing CSRF header', { ...BROWSER, 'idempotency-key': 'm07' }],
    ['wrong CSRF token', { ...BROWSER, 'x-kfin-csrf': 'wrong-token-value-000000', 'idempotency-key': 'm07' }],
    ['foreign Origin', { host: 'api.kfin.test', origin: 'https://evil.example', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'm07' }],
    ['scheme-less lookalike Origin', { host: 'api.kfin.test', origin: 'https://api.kfin.test.evil.example', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'm07' }],
    ['cross-site Fetch Metadata', { host: 'api.kfin.test', 'sec-fetch-site': 'cross-site', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'm07' }],
    ['no Origin and no Fetch Metadata', { host: 'api.kfin.test', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'm07' }],
  ])('rejects %s with 403 AUTH_CSRF_FAILED before the service', async (_label, headers) => {
    const financialService = service();
    const app = await buildProtectedTransactionApp({ financialService });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers,
      payload: CREATE_TRANSACTION_BODY,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(financialService.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects a cross-site text/plain POST with 403 before body parsing', async () => {
    const financialService = service();
    const app = await buildProtectedTransactionApp({ financialService });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers: {
        host: 'api.kfin.test',
        origin: 'https://evil.example',
        'x-kfin-csrf': CSRF_TOKEN,
        'content-type': 'text/plain',
      },
      payload: 'kind=expense&amountMinor=1',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(financialService.createTransaction).not.toHaveBeenCalled();
  });

  it('fails closed when the principal has no session-bound CSRF digest', async () => {
    const financialService = service();
    const app = await buildProtectedTransactionApp({
      financialService,
      principal: { userId: USER_ID },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers: { ...PROTECTED, 'idempotency-key': 'm07-no-digest' },
      payload: CREATE_TRANSACTION_BODY,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(financialService.createTransaction).not.toHaveBeenCalled();
  });

  it('fails closed when no CSRF verifier (auth service) is configured', async () => {
    const financialService = service();
    const app = await buildProtectedTransactionApp({ financialService, authVerifier: null });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers: { ...PROTECTED, 'idempotency-key': 'm07-no-verifier' },
      payload: CREATE_TRANSACTION_BODY,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(financialService.createTransaction).not.toHaveBeenCalled();
  });

  it('marks an idempotent replay, and only a replay, at the transport level', async () => {
    const financialService = service();
    const app = await buildProtectedTransactionApp({ financialService });

    vi.mocked(financialService.createTransaction).mockResolvedValueOnce({
      transactionId: TRANSACTION_ID,
      financialStateVersion: '2',
      replayed: true,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers: { ...PROTECTED, 'idempotency-key': 'm07-replay' },
      payload: CREATE_TRANSACTION_BODY,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual({ transactionId: TRANSACTION_ID, financialStateVersion: '2' });

    const original = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers: { ...PROTECTED, 'idempotency-key': 'm07-original' },
      payload: CREATE_TRANSACTION_BODY,
    });
    expect(original.statusCode).toBe(201);
    expect(original.headers['idempotency-replayed']).toBeUndefined();
  });
});
