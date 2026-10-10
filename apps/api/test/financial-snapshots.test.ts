import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type FinancialApiService } from '../src/app.js';
import type { AuthApiService } from '../src/auth-routes.js';
import type { AuthenticatedPrincipal } from '../src/types.js';

/**
 * Milestone 08 — browser write defense on the manual balance snapshot.
 *
 * `POST /api/v1/financial-account/snapshots` overwrites the authoritative
 * current balance with a client-supplied signed `amountMinor`, so it takes the
 * Milestone 04 same-origin plus double-submit CSRF defense at `onRequest` —
 * the convention Milestones 05/06/07 apply to every other financial mutation.
 * Milestone 07 recorded this route as a deferred observation; this suite is the
 * regression proof that the gap is closed and fails closed.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = '00000000-0000-4000-8000-000000000003';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000004';
const PRIOR_SNAPSHOT_ID = '00000000-0000-4000-8000-000000000005';
const CSRF_TOKEN = 'csrf-token-value-0123456789';
const CSRF_DIGEST = 'bound-csrf-digest';
const URL = '/api/v1/financial-account/snapshots';

const BROWSER = { host: 'api.kfin.test', origin: 'https://api.kfin.test' };
const PROTECTED = { ...BROWSER, 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'snapshot-key-1' };
const VALID_BODY = {
  amountMinor: '500000',
  effectiveAt: '2026-10-08T00:00:00.000Z',
  expectedFinancialStateVersion: '1',
  reviewedLatestSnapshotId: PRIOR_SNAPSHOT_ID,
};

function financialService(overrides: Partial<FinancialApiService> = {}): FinancialApiService {
  const unexpected = vi.fn(async () => {
    throw new Error('not used by this suite');
  });
  return {
    openFinancialAccount: unexpected,
    listFinancialAccounts: unexpected,
    getCurrentBalance: unexpected,
    createSnapshot: vi.fn(async () => ({
      snapshotId: SNAPSHOT_ID,
      financialStateVersion: '2',
    })),
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
  return { app, service };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('POST /api/v1/financial-account/snapshots (Milestone 08 CSRF defense)', () => {
  it('creates the snapshot for the authenticated principal and returns 201', async () => {
    const { app, service } = await build();
    const response = await app.inject({ method: 'POST', url: URL, headers: PROTECTED, payload: VALID_BODY });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ snapshotId: SNAPSHOT_ID, financialStateVersion: '2' });
    expect(service.createSnapshot).toHaveBeenCalledWith(
      USER_ID,
      {
        amountMinor: '500000',
        effectiveAt: '2026-10-08T00:00:00.000Z',
        expectedFinancialStateVersion: '1',
        reviewedLatestSnapshotId: PRIOR_SNAPSHOT_ID,
      },
      'snapshot-key-1',
      expect.any(String),
    );
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('accepts same-site Fetch Metadata without an Origin header', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: { host: 'api.kfin.test', 'sec-fetch-site': 'same-origin', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'k' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(201);
    expect(service.createSnapshot).toHaveBeenCalledTimes(1);
  });

  it('requires authentication before any CSRF or body handling', async () => {
    const { app, service } = await build({ principal: null });
    const response = await app.inject({ method: 'POST', url: URL, headers: PROTECTED, payload: VALID_BODY });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(service.createSnapshot).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated form POST with 401 before body parsing', async () => {
    const { app, service } = await build({ principal: null });
    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: { host: 'api.kfin.test', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'amountMinor=500000',
    });

    expect(response.statusCode).toBe(401);
    expect(service.createSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['missing CSRF header', { ...BROWSER, 'idempotency-key': 'k' }],
    ['wrong CSRF token', { ...BROWSER, 'x-kfin-csrf': 'wrong-token-value-000000', 'idempotency-key': 'k' }],
    ['foreign Origin', { host: 'api.kfin.test', origin: 'https://evil.example', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'k' }],
    ['scheme-less lookalike Origin', { host: 'api.kfin.test', origin: 'https://api.kfin.test.evil.example', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'k' }],
    ['cross-site Fetch Metadata', { host: 'api.kfin.test', 'sec-fetch-site': 'cross-site', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'k' }],
    ['no Origin and no Fetch Metadata', { host: 'api.kfin.test', 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'k' }],
  ])('rejects %s with 403 AUTH_CSRF_FAILED before the service', async (_label, headers) => {
    const { app, service } = await build();
    const response = await app.inject({ method: 'POST', url: URL, headers, payload: VALID_BODY });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(service.createSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['HTML form (urlencoded)', 'application/x-www-form-urlencoded', 'amountMinor=500000'],
    ['plain text', 'text/plain', 'amountMinor=500000'],
    ['malformed JSON', 'application/json', '{"amountMinor":'],
  ])('rejects a cross-site %s POST with 403 before body parsing', async (_label, contentType, payload) => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: { host: 'api.kfin.test', origin: 'https://evil.example', 'content-type': contentType },
      payload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(service.createSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed when the principal has no session-bound CSRF digest', async () => {
    const { app, service } = await build({ principal: { userId: USER_ID } });
    const response = await app.inject({ method: 'POST', url: URL, headers: PROTECTED, payload: VALID_BODY });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(service.createSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed when no CSRF verifier (auth service) is configured', async () => {
    const { app, service } = await build({ authService: null });
    const response = await app.inject({ method: 'POST', url: URL, headers: PROTECTED, payload: VALID_BODY });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(service.createSnapshot).not.toHaveBeenCalled();
  });

  it('derives the owner from the principal and rejects a client-supplied owner', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: { ...PROTECTED, 'x-user-id': OTHER_USER_ID },
      payload: { userId: OTHER_USER_ID, ownerId: OTHER_USER_ID, ...VALID_BODY },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
    expect(service.createSnapshot).not.toHaveBeenCalled();
  });

  it('requires an Idempotency-Key header even for an authorized same-origin caller', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: { ...BROWSER, 'x-kfin-csrf': CSRF_TOKEN },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
    expect(service.createSnapshot).not.toHaveBeenCalled();
  });

  it('publishes the 403 defense in the route OpenAPI contract', async () => {
    const { app } = await build();
    const contract = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(contract.statusCode).toBe(200);
    const responses = contract.json().paths['/financial-account/snapshots'].post.responses;
    expect(Object.keys(responses)).toContain('403');
  });
});
