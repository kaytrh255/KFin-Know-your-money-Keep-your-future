import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FinancialError } from '@kfin/domain';
import { buildApp, type FinancialApiService } from '../src/app.js';
import type { AuthApiService } from '../src/auth-routes.js';
import type { AuthenticatedPrincipal } from '../src/types.js';

/**
 * Milestone 08 — API read boundary for transaction reads.
 *
 * `GET /api/v1/transactions` had no API-level coverage and
 * `GET /api/v1/transactions/:id` had a single owner-scoping assertion. This
 * suite pins the three read-boundary properties the API is responsible for:
 * authentication before the service is reached, owner scope taken only from the
 * authenticated principal, and contract validation of the path and query.
 * It also proves the boundary is not over-restricted: safe methods need no CSRF
 * token, and an unavailable object answers a stable 404 without leaking detail.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = '00000000-0000-4000-8000-000000000003';
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000004';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000005';
const CSRF_TOKEN = 'csrf-token-value-0123456789';
const CSRF_DIGEST = 'bound-csrf-digest';
const LIST_URL = '/api/v1/transactions';

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

function financialService(overrides: Partial<FinancialApiService> = {}): FinancialApiService {
  const unexpected = vi.fn(async () => {
    throw new Error('not used by this suite');
  });
  return {
    openFinancialAccount: unexpected,
    listFinancialAccounts: unexpected,
    getCurrentBalance: unexpected,
    createSnapshot: unexpected,
    createTransaction: unexpected,
    getTransaction: vi.fn(async () => transaction),
    getTransactionCorrectionHistory: unexpected,
    listTransactions: vi.fn(async () => ({ items: [transaction], nextCursor: null })),
    previewTransactionCorrection: unexpected,
    previewTransactionVoid: unexpected,
    correctTransaction: unexpected,
    voidTransaction: unexpected,
    getMonthlyActuals: unexpected,
    ...overrides,
  } as FinancialApiService;
}

function csrfVerifier(): AuthApiService {
  return {
    verifyCsrfToken: vi.fn((presented: string | null | undefined, digest: string) => (
      presented === CSRF_TOKEN && digest === CSRF_DIGEST
    )),
  } as unknown as AuthApiService;
}

const apps: FastifyInstance[] = [];

async function build(options: {
  service?: FinancialApiService;
  principal?: AuthenticatedPrincipal | null;
  authService?: AuthApiService | null;
} = {}) {
  const service = options.service ?? financialService();
  const authService = options.authService === null ? undefined : options.authService ?? csrfVerifier();
  const principal = options.principal === undefined
    ? { userId: USER_ID, sessionId: SESSION_ID, csrfDigest: CSRF_DIGEST }
    : options.principal;
  const app = await buildApp({
    financialService: service,
    ...(authService ? { authService } : {}),
    authenticate: async () => principal,
  });
  apps.push(app);
  return { app, service };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /api/v1/transactions — authentication boundary', () => {
  it('answers 401 and never reaches the service when no principal is established', async () => {
    const { app, service } = await build({ principal: null });
    const response = await app.inject({ method: 'GET', url: LIST_URL });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(service.listTransactions).not.toHaveBeenCalled();
  });

  it('answers 401 for a principal whose user identifier is malformed', async () => {
    const { app, service } = await build({ principal: { userId: 'not-a-uuid' } });
    const response = await app.inject({ method: 'GET', url: LIST_URL });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.listTransactions).not.toHaveBeenCalled();
  });

  it('requires no CSRF token on a safe method, even from a cross-site Origin', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'GET',
      url: LIST_URL,
      headers: { host: 'api.kfin.test', origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(200);
    expect(service.listTransactions).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/v1/transactions — owner scoping', () => {
  it('takes the owner exclusively from the principal and applies the page default', async () => {
    const { app, service } = await build();
    const response = await app.inject({ method: 'GET', url: LIST_URL });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [transaction], nextCursor: null });
    expect(service.listTransactions).toHaveBeenCalledWith(USER_ID, { limit: 50 });
  });

  it('rejects an owner hint in the query string instead of scoping by it', async () => {
    const { app, service } = await build();
    const response = await app.inject({ method: 'GET', url: `${LIST_URL}?userId=${OTHER_USER_ID}` });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
    expect(service.listTransactions).not.toHaveBeenCalled();
  });

  it.each([['ownerId'], ['accountId'], ['owner_user_id']])(
    'rejects the %s query alias at the strict contract boundary',
    async (alias) => {
      const { app, service } = await build();
      const response = await app.inject({ method: 'GET', url: `${LIST_URL}?${alias}=${OTHER_USER_ID}` });

      expect(response.statusCode).toBe(400);
      expect(service.listTransactions).not.toHaveBeenCalled();
    },
  );

  it('ignores an owner hint sent as a header and still scopes to the principal', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'GET',
      url: LIST_URL,
      headers: { 'x-user-id': OTHER_USER_ID, 'x-owner-id': OTHER_USER_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(service.listTransactions).toHaveBeenCalledWith(USER_ID, { limit: 50 });
  });

  it('passes the authenticated owner to the object lookup for BOLA resistance', async () => {
    const { app, service } = await build();
    const response = await app.inject({ method: 'GET', url: `${LIST_URL}/${TRANSACTION_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(transaction);
    expect(service.getTransaction).toHaveBeenCalledWith(USER_ID, TRANSACTION_ID);
  });

  it('answers a stable 404 for another owner’s transaction without leaking detail', async () => {
    const service = financialService({
      getTransaction: vi.fn(async () => {
        throw new FinancialError({
          code: 'FINANCIAL_RESOURCE_UNAVAILABLE',
          statusCode: 404,
          safeMessage: 'The requested financial resource is unavailable.',
          cause: new Error('row belongs to user 00000000-0000-4000-8000-000000000002'),
        });
      }),
    });
    const { app } = await build({ service });
    const response = await app.inject({ method: 'GET', url: `${LIST_URL}/${TRANSACTION_ID}` });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE' });
    expect(response.body).not.toContain(OTHER_USER_ID);
    expect(response.body).not.toContain('row belongs to');
  });
});

describe('GET /api/v1/transactions — query and path validation', () => {
  it.each([
    ['limit below the minimum', 'limit=0'],
    ['limit above the maximum', 'limit=101'],
    ['negative limit', 'limit=-1'],
    ['fractional limit', 'limit=1.5'],
    ['non-numeric limit', 'limit=many'],
    ['empty limit', 'limit='],
    ['empty cursor', 'cursor='],
    ['over-long cursor', `cursor=${'a'.repeat(513)}`],
    ['month out of range', 'month=2026-13'],
    ['month with a slash separator', 'month=2026%2F10'],
    ['month without a day separator', 'month=202610'],
    ['year-zero month', 'month=0000-01'],
    ['uppercase category code', 'categoryCode=Food'],
    ['category code starting with a digit', 'categoryCode=1food'],
    ['single-character category code', 'categoryCode=f'],
    ['over-long category code', `categoryCode=${'a'.repeat(64)}`],
    ['unknown kind', 'kind=transfer'],
    ['unknown balance effect', 'balanceEffect=future'],
    ['unsupported pagination alias', 'page=2'],
  ])('rejects %s with 400 before reaching the service', async (_label, query) => {
    const { app, service } = await build();
    const response = await app.inject({ method: 'GET', url: `${LIST_URL}?${query}` });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
    expect(service.listTransactions).not.toHaveBeenCalled();
  });

  it.each([['limit=1'], ['limit=100']])(
    'accepts the inclusive page bound %s',
    async (query) => {
      const { app, service } = await build();
      const response = await app.inject({ method: 'GET', url: `${LIST_URL}?${query}` });

      expect(response.statusCode).toBe(200);
      expect(service.listTransactions).toHaveBeenCalledWith(
        USER_ID,
        { limit: Number(query.slice('limit='.length)) },
      );
    },
  );

  it('forwards every accepted filter and omits the absent ones', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'GET',
      url: `${LIST_URL}?limit=2&cursor=opaque-cursor&month=2026-10&categoryCode=food&kind=expense&balanceEffect=current`,
    });

    expect(response.statusCode).toBe(200);
    expect(service.listTransactions).toHaveBeenCalledWith(USER_ID, {
      limit: 2,
      cursor: 'opaque-cursor',
      month: '2026-10',
      categoryCode: 'food',
      kind: 'expense',
      balanceEffect: 'current',
    });
  });

  it('serializes an opaque next cursor when the service reports another page', async () => {
    const service = financialService({
      listTransactions: vi.fn(async () => ({ items: [transaction], nextCursor: 'next-page-cursor' })),
    });
    const { app } = await build({ service });
    const response = await app.inject({ method: 'GET', url: `${LIST_URL}?limit=1` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [transaction], nextCursor: 'next-page-cursor' });
  });

  it('rejects a malformed transaction identifier in the path', async () => {
    const { app, service } = await build();
    const response = await app.inject({ method: 'GET', url: `${LIST_URL}/not-a-uuid` });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
    expect(service.getTransaction).not.toHaveBeenCalled();
  });

  it('refuses to serialize an amount outside the response contract', async () => {
    const service = financialService({
      getTransaction: vi.fn(async () => ({ ...transaction, amountMinor: '1.5' })),
    });
    const { app } = await build({ service });
    const response = await app.inject({ method: 'GET', url: `${LIST_URL}/${TRANSACTION_ID}` });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('1.5');
  });

  it('fails closed rather than leaking a field outside the response contract', async () => {
    const service = financialService({
      getTransaction: vi.fn(async () => ({ ...transaction, internalOwnerId: OTHER_USER_ID })),
    });
    const { app } = await build({ service });
    const response = await app.inject({ method: 'GET', url: `${LIST_URL}/${TRANSACTION_ID}` });

    // The strict serializer refuses the extra property instead of passing it
    // through, so an internal owner identifier can never reach a client.
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('internalOwnerId');
    expect(response.body).not.toContain(OTHER_USER_ID);
  });
});
