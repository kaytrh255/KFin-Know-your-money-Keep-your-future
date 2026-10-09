import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FinancialError } from '@kfin/domain';
import type { FinancialAccountSummaryView } from '@kfin/database';
import { buildApp, type FinancialApiService } from '../src/app.js';
import type { AuthApiService } from '../src/auth-routes.js';
import type { AuthenticatedPrincipal } from '../src/types.js';

/**
 * Milestone 05 — authenticated financial-account onboarding and listing.
 *
 * Covers authorization, the Milestone 04 CSRF/origin defense on the new
 * state-changing route, principal-only ownership, idempotent replay transport,
 * duplicate-account and validation envelopes, and owner-scoped listing.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = '00000000-0000-4000-8000-000000000003';
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000004';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000005';
const CSRF_TOKEN = 'csrf-token-value-0123456789';
const CSRF_DIGEST = 'bound-csrf-digest';

const BROWSER = { host: 'api.kfin.test', origin: 'https://api.kfin.test' };
const PROTECTED = { ...BROWSER, 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'open-key-1' };
const VALID_BODY = { openingBalanceMinor: '1000000', effectiveAt: '2026-10-08T00:00:00.000Z' };

function summary(overrides: Partial<FinancialAccountSummaryView> = {}): FinancialAccountSummaryView {
  return {
    accountId: ACCOUNT_ID,
    name: 'Aggregate liquid account',
    accountType: 'aggregate_liquid',
    currency: 'VND',
    financialStateVersion: '2',
    snapshot: {
      id: SNAPSHOT_ID,
      amountMinor: '1000000',
      effectiveAt: '2026-10-08T00:00:00.000Z',
      effectiveLocalDate: '2026-10-08',
    },
    postedCurrentIncomeMinor: '0',
    postedCurrentExpenseMinor: '250000',
    currentBalanceMinor: '750000',
    ...overrides,
  };
}

function financialService(overrides: Partial<FinancialApiService> = {}): FinancialApiService {
  const unexpected = vi.fn(async () => {
    throw new Error('not used by this suite');
  });
  return {
    openFinancialAccount: vi.fn(async () => ({
      accountId: ACCOUNT_ID,
      snapshotId: SNAPSHOT_ID,
      financialStateVersion: '1',
      replayed: false,
    })),
    listFinancialAccounts: vi.fn(async () => ({ items: [summary()] })),
    getCurrentBalance: unexpected,
    createSnapshot: unexpected,
    createTransaction: unexpected,
    getTransaction: unexpected,
    getTransactionCorrectionHistory: unexpected,
    listTransactions: unexpected,
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
  return { app, service, authService };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('POST /api/v1/financial-account (onboarding)', () => {
  it('creates the account for the authenticated principal and returns 201', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: PROTECTED,
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      accountId: ACCOUNT_ID,
      snapshotId: SNAPSHOT_ID,
      financialStateVersion: '1',
    });
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(service.openFinancialAccount).toHaveBeenCalledTimes(1);
    expect(service.openFinancialAccount).toHaveBeenCalledWith(
      USER_ID,
      VALID_BODY,
      'open-key-1',
      expect.any(String),
    );
  });

  it('accepts same-site Fetch Metadata without an Origin header', async () => {
    const { app } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: {
        host: 'api.kfin.test',
        'sec-fetch-site': 'same-origin',
        'x-kfin-csrf': CSRF_TOKEN,
        'idempotency-key': 'open-key-1',
      },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(201);
  });

  it('marks an idempotent replay without changing the response body', async () => {
    const service = financialService({
      openFinancialAccount: vi.fn(async () => ({
        accountId: ACCOUNT_ID,
        snapshotId: SNAPSHOT_ID,
        financialStateVersion: '1',
        replayed: true,
      })),
    });
    const { app } = await build({ service });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: PROTECTED,
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['idempotency-replayed']).toBe('true');
    expect(response.json()).toEqual({
      accountId: ACCOUNT_ID,
      snapshotId: SNAPSHOT_ID,
      financialStateVersion: '1',
    });
  });

  it('requires authentication before any CSRF or body handling', async () => {
    const { app, service } = await build({ principal: null });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: PROTECTED,
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.openFinancialAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['missing CSRF header', { ...BROWSER, 'idempotency-key': 'k' }],
    ['wrong CSRF token', { ...BROWSER, 'x-kfin-csrf': 'wrong-token-value-000000', 'idempotency-key': 'k' }],
    ['foreign Origin', { host: 'api.kfin.test', origin: 'https://evil.example', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'k' }],
    ['scheme-less lookalike Origin', { host: 'api.kfin.test', origin: 'https://api.kfin.test.evil.example', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'k' }],
    ['cross-site Fetch Metadata', { host: 'api.kfin.test', 'sec-fetch-site': 'cross-site', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'k' }],
    ['no Origin and no Fetch Metadata', { host: 'api.kfin.test', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'k' }],
  ])('rejects %s with 403 AUTH_CSRF_FAILED', async (_label, headers) => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers,
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(service.openFinancialAccount).not.toHaveBeenCalled();
  });

  it('rejects cross-site requests before body validation so nothing is interpreted', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: { host: 'api.kfin.test', origin: 'https://evil.example' },
      payload: { ownerId: OTHER_USER_ID },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(service.openFinancialAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['HTML form (urlencoded)', 'application/x-www-form-urlencoded', 'openingBalanceMinor=1&effectiveAt=2026-10-08T00%3A00%3A00Z'],
    ['multipart form', 'multipart/form-data; boundary=x', '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n'],
    ['malformed JSON', 'application/json', '{"openingBalanceMinor":'],
  ])('rejects a cross-site %s POST with 403 before body parsing', async (_label, contentType, payload) => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: { host: 'api.kfin.test', origin: 'https://evil.example', 'content-type': contentType },
      payload,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(service.openFinancialAccount).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated form POST with 401 before body parsing', async () => {
    const { app, service } = await build({ principal: null });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: { host: 'api.kfin.test', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'openingBalanceMinor=1',
    });
    expect(response.statusCode).toBe(401);
    expect(service.openFinancialAccount).not.toHaveBeenCalled();
  });

  it('fails closed when the principal has no session-bound CSRF digest', async () => {
    const { app, service } = await build({ principal: { userId: USER_ID } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: PROTECTED,
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(service.openFinancialAccount).not.toHaveBeenCalled();
  });

  it('fails closed when no CSRF verifier (auth service) is configured', async () => {
    const { app, service } = await build({ authService: null });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: PROTECTED,
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(service.openFinancialAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['ownerId', { ...VALID_BODY, ownerId: OTHER_USER_ID }],
    ['userId', { ...VALID_BODY, userId: OTHER_USER_ID }],
    ['accountId', { ...VALID_BODY, accountId: ACCOUNT_ID }],
    ['currency', { ...VALID_BODY, currency: 'USD' }],
  ])('never accepts a client-supplied %s', async (_field, payload) => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: PROTECTED,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
    expect(service.openFinancialAccount).not.toHaveBeenCalled();
  });

  it('ignores ownership hints in query strings and headers; the principal is the owner', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/financial-account?ownerId=${OTHER_USER_ID}&userId=${OTHER_USER_ID}`,
      headers: { ...PROTECTED, 'x-user-id': OTHER_USER_ID, 'x-owner-id': OTHER_USER_ID },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(201);
    expect(vi.mocked(service.openFinancialAccount).mock.calls[0]?.[0]).toBe(USER_ID);
  });

  it('requires an Idempotency-Key header', async () => {
    const { app, service } = await build();
    const { 'idempotency-key': _omitted, ...headers } = PROTECTED;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers,
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(400);
    expect(service.openFinancialAccount).not.toHaveBeenCalled();
  });

  it('rejects a JSON-number opening balance at the contract boundary', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: PROTECTED,
      payload: { ...VALID_BODY, openingBalanceMinor: 1000000 },
    });
    expect(response.statusCode).toBe(400);
    expect(service.openFinancialAccount).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'FIN_ACCOUNT_ALREADY_EXISTS', 'The aggregate financial account already exists.'],
    [409, 'IDEMPOTENCY_KEY_REUSED', 'The idempotency key was already used for a different request.'],
    [404, 'FINANCIAL_RESOURCE_UNAVAILABLE', 'The requested financial resource is unavailable.'],
    [422, 'FIN_OPENING_BALANCE_INVALID', 'Opening balance must be an integer minor-unit string.'],
    [503, 'FINANCIAL_RESULT_UNKNOWN', 'The financial result is not yet known. Retry with the same idempotency key.'],
  ] as const)('maps %s %s to the stable error envelope', async (statusCode, code, safeMessage) => {
    const service = financialService({
      openFinancialAccount: vi.fn(async () => {
        throw new FinancialError({ code, statusCode, safeMessage });
      }),
    });
    const { app } = await build({ service });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/financial-account',
      headers: { ...PROTECTED, 'x-correlation-id': '00000000-0000-4000-8000-0000000000aa' },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({
      error: { code, message: safeMessage, correlationId: '00000000-0000-4000-8000-0000000000aa' },
    });
  });
});

describe('GET /api/v1/financial-accounts', () => {
  it('lists only the authenticated owner accounts with authoritative balances', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/financial-accounts?ownerId=${OTHER_USER_ID}`,
      headers: { host: 'api.kfin.test', 'x-user-id': OTHER_USER_ID },
    });
    // Ownership hints in the query string or headers are ignored entirely.
    expect(response.statusCode).toBe(200);
    expect(service.listFinancialAccounts).toHaveBeenCalledTimes(1);
    expect(service.listFinancialAccounts).toHaveBeenCalledWith(USER_ID);
  });

  it('returns the owner list without requiring CSRF on a safe method', async () => {
    const { app, service } = await build();
    const response = await app.inject({ method: 'GET', url: '/api/v1/financial-accounts' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ items: [summary()] });
    expect(service.listFinancialAccounts).toHaveBeenCalledWith(USER_ID);
  });

  it('returns an empty list for an owner without an account', async () => {
    const service = financialService({ listFinancialAccounts: vi.fn(async () => ({ items: [] })) });
    const { app } = await build({ service });
    const response = await app.inject({ method: 'GET', url: '/api/v1/financial-accounts' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it('requires authentication', async () => {
    const { app, service } = await build({ principal: null });
    const response = await app.inject({ method: 'GET', url: '/api/v1/financial-accounts' });
    expect(response.statusCode).toBe(401);
    expect(service.listFinancialAccounts).not.toHaveBeenCalled();
  });

  it('rejects a principal with a malformed user identifier', async () => {
    const { app, service } = await build({ principal: { userId: 'not-a-uuid' } });
    const response = await app.inject({ method: 'GET', url: '/api/v1/financial-accounts' });
    expect(response.statusCode).toBe(401);
    expect(service.listFinancialAccounts).not.toHaveBeenCalled();
  });

  it('refuses to serialize a non-contract balance shape', async () => {
    const service = financialService({
      listFinancialAccounts: vi.fn(async () => ({
        items: [summary({ currentBalanceMinor: '1.5' })],
      })),
    });
    const { app } = await build({ service });
    const response = await app.inject({ method: 'GET', url: '/api/v1/financial-accounts' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('1.5');
  });

  it('publishes both routes in the OpenAPI contract', async () => {
    const { app } = await build();
    const contract = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(contract.paths['/financial-account']).toHaveProperty('post');
    expect(contract.paths['/financial-accounts']).toHaveProperty('get');
  });
});
