import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FinancialError, savingsGoalArchived, savingsGoalInvalid, savingsGoalVersionConflict } from '@kfin/domain';
import type { SavingsGoalView } from '@kfin/database';
import { buildApp, type FinancialApiService, type SavingsApiService } from '../src/app.js';
import type { AuthApiService } from '../src/auth-routes.js';
import type { AuthenticatedPrincipal } from '../src/types.js';

/**
 * Milestone 06 — savings-goal HTTP surface: authentication, the CSRF/origin
 * defense at `onRequest` on every mutation, principal-only ownership, contract
 * validation, idempotent replay transport, and stable error envelopes.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000003';
const GOAL_ID = '00000000-0000-4000-8000-000000000010';
const CHANGE_ID = '00000000-0000-4000-8000-000000000011';
const CSRF_TOKEN = 'csrf-token-value-0123456789';
const CSRF_DIGEST = 'bound-csrf-digest';

const BROWSER = { host: 'api.kfin.test', origin: 'https://api.kfin.test' };
const PROTECTED = { ...BROWSER, 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'goal-key-1' };
const CREATE_BODY = {
  name: 'Emergency fund',
  targetAmountMinor: '10000000',
  currentAmountMinor: '0',
  currentAmountAsOf: '2026-10-08',
};

function goalView(overrides: Partial<SavingsGoalView> = {}): SavingsGoalView {
  return {
    id: GOAL_ID,
    name: 'Emergency fund',
    currency: 'VND',
    targetAmountMinor: '10000000',
    currentAmountMinor: '2500000',
    currentAmountAsOf: '2026-10-08',
    targetDate: null,
    plannedContributionMinor: null,
    contributionFrequency: null,
    status: 'active',
    archivedAt: null,
    progress: { percentBasisPoints: '2500', achieved: false, overTarget: false, remainingMinor: '7500000' },
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
    version: '1',
    ...overrides,
  };
}

function savingsService(overrides: Partial<SavingsApiService> = {}): SavingsApiService {
  return {
    createGoal: vi.fn(async () => ({ goalId: GOAL_ID, version: '1', amountChangeId: CHANGE_ID, replayed: false })),
    listGoals: vi.fn(async () => ({ items: [goalView()], nextCursor: null })),
    getGoal: vi.fn(async () => goalView()),
    updatePlan: vi.fn(async () => ({ goalId: GOAL_ID, version: '2', replayed: false })),
    updateCurrentAmount: vi.fn(async () => ({ goalId: GOAL_ID, version: '2', amountChangeId: CHANGE_ID, replayed: false })),
    archiveGoal: vi.fn(async () => ({ goalId: GOAL_ID, version: '2', replayed: false })),
    listAmountChanges: vi.fn(async () => ({
      items: [{
        id: CHANGE_ID,
        goalVersion: '1',
        previousAmountMinor: null,
        newAmountMinor: '2500000',
        asOf: '2026-10-08',
        source: 'initial' as const,
        reason: null,
        actorType: 'user' as const,
        createdAt: '2026-10-08T00:00:00.000Z',
      }],
      nextCursor: null,
    })),
    ...overrides,
  };
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
  service?: SavingsApiService;
  principal?: AuthenticatedPrincipal | null;
  register?: boolean;
} = {}) {
  const service = options.service ?? savingsService();
  const principal = options.principal === undefined
    ? { userId: USER_ID, sessionId: SESSION_ID, csrfDigest: CSRF_DIGEST }
    : options.principal;
  const app = await buildApp({
    financialService: {} as FinancialApiService,
    ...(options.register === false ? {} : { savingsService: service }),
    authService: csrfVerifier(),
    authenticate: async () => principal,
  });
  apps.push(app);
  return { app, service };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const mutations = [
  { method: 'POST' as const, url: '/api/v1/savings-goals', payload: CREATE_BODY },
  { method: 'PATCH' as const, url: `/api/v1/savings-goals/${GOAL_ID}`, payload: { expectedVersion: '1', name: 'x' } },
  {
    method: 'POST' as const,
    url: `/api/v1/savings-goals/${GOAL_ID}/current-amount`,
    payload: { expectedVersion: '1', currentAmountMinor: '1', asOf: '2026-10-08' },
  },
  { method: 'POST' as const, url: `/api/v1/savings-goals/${GOAL_ID}/archive`, payload: { expectedVersion: '1' } },
];

describe('savings-goal mutation guards', () => {
  it.each(mutations)('$method $url rejects unauthenticated requests with 401 before calling the service', async (route) => {
    const { app, service } = await build({ principal: null });
    const response = await app.inject({ ...route, headers: PROTECTED });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(Object.values(service).every((fn) => vi.mocked(fn).mock.calls.length === 0)).toBe(true);
  });

  it.each(mutations)('$method $url rejects a cross-site request with 403', async (route) => {
    const { app, service } = await build();
    const response = await app.inject({
      ...route,
      headers: { ...PROTECTED, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(response.statusCode).toBe(403);
    expect(Object.values(service).every((fn) => vi.mocked(fn).mock.calls.length === 0)).toBe(true);
  });

  it.each(mutations)('$method $url rejects a missing CSRF token with 403', async (route) => {
    const { app } = await build();
    const { 'x-kfin-csrf': _omitted, ...headers } = PROTECTED;
    const response = await app.inject({ ...route, headers });
    expect(response.statusCode).toBe(403);
  });

  it.each(mutations)('$method $url rejects a cross-site HTML form before body parsing', async (route) => {
    const { app } = await build();
    const response = await app.inject({
      method: route.method,
      url: route.url,
      headers: {
        host: 'api.kfin.test',
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': 'k',
      },
      payload: 'name=x',
    });
    expect(response.statusCode).toBe(403);
  });

  it.each(mutations)('$method $url requires an Idempotency-Key', async (route) => {
    const { app } = await build();
    const { 'idempotency-key': _omitted, ...headers } = PROTECTED;
    const response = await app.inject({ ...route, headers });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
  });

  it('keeps every savings route unregistered when no savings service is configured', async () => {
    const { app } = await build({ register: false });
    const response = await app.inject({ method: 'GET', url: '/api/v1/savings-goals' });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/v1/savings-goals', () => {
  it('creates a goal for the principal only and returns a 201 receipt', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/savings-goals',
      headers: PROTECTED,
      payload: { ...CREATE_BODY, plannedContributionMinor: '500000', contributionFrequency: 'monthly' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ goalId: GOAL_ID, version: '1', amountChangeId: CHANGE_ID });
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(service.createGoal).toHaveBeenCalledWith(
      USER_ID,
      { ...CREATE_BODY, plannedContributionMinor: '500000', contributionFrequency: 'monthly' },
      'goal-key-1',
      expect.any(String),
    );
  });

  it('marks a replay with Idempotency-Replayed', async () => {
    const { app } = await build({
      service: savingsService({
        createGoal: vi.fn(async () => ({ goalId: GOAL_ID, version: '1', amountChangeId: CHANGE_ID, replayed: true })),
      }),
    });
    const response = await app.inject({ method: 'POST', url: '/api/v1/savings-goals', headers: PROTECTED, payload: CREATE_BODY });
    expect(response.statusCode).toBe(201);
    expect(response.headers['idempotency-replayed']).toBe('true');
  });

  it.each([
    { ...CREATE_BODY, userId: USER_ID },
    { ...CREATE_BODY, currency: 'USD' },
    { ...CREATE_BODY, targetAmountMinor: '0' },
    { ...CREATE_BODY, currentAmountMinor: '-5' },
    { ...CREATE_BODY, currentAmountMinor: '1.5' },
    { ...CREATE_BODY, currentAmountMinor: 100 },
    { ...CREATE_BODY, name: '   ' },
    { ...CREATE_BODY, name: 'x'.repeat(121) },
    { ...CREATE_BODY, currentAmountAsOf: '08/10/2026' },
    { ...CREATE_BODY, contributionFrequency: 'daily' },
    { name: 'No amounts' },
  ])('rejects a contract-invalid body with 400 (%#)', async (payload) => {
    const { app, service } = await build();
    const response = await app.inject({ method: 'POST', url: '/api/v1/savings-goals', headers: PROTECTED, payload });
    expect(response.statusCode).toBe(400);
    expect(service.createGoal).not.toHaveBeenCalled();
  });

  it('maps a semantic rejection to 422 SAVINGS_GOAL_INVALID', async () => {
    const { app } = await build({
      service: savingsService({
        createGoal: vi.fn(async () => { throw savingsGoalInvalid('As-of date cannot be in the future.'); }),
      }),
    });
    const response = await app.inject({ method: 'POST', url: '/api/v1/savings-goals', headers: PROTECTED, payload: CREATE_BODY });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: 'SAVINGS_GOAL_INVALID', message: 'As-of date cannot be in the future.' });
  });
});

describe('savings-goal reads', () => {
  it('lists the principal’s goals with the default active filter', async () => {
    const { app, service } = await build();
    const response = await app.inject({ method: 'GET', url: '/api/v1/savings-goals' });
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toEqual(goalView());
    expect(service.listGoals).toHaveBeenCalledWith(USER_ID, { status: 'active', limit: 50 });
  });

  it('passes status, limit, and cursor filters and rejects unknown filters', async () => {
    const { app, service } = await build();
    const ok = await app.inject({ method: 'GET', url: '/api/v1/savings-goals?status=archived&limit=5&cursor=abc' });
    expect(ok.statusCode).toBe(200);
    expect(service.listGoals).toHaveBeenCalledWith(USER_ID, { status: 'archived', limit: 5, cursor: 'abc' });
    const bad = await app.inject({ method: 'GET', url: '/api/v1/savings-goals?status=deleted' });
    expect(bad.statusCode).toBe(400);
    const owner = await app.inject({ method: 'GET', url: `/api/v1/savings-goals?userId=${USER_ID}` });
    expect(owner.statusCode).toBe(400);
  });

  it('requires authentication for reads', async () => {
    const { app } = await build({ principal: null });
    for (const url of ['/api/v1/savings-goals', `/api/v1/savings-goals/${GOAL_ID}`, `/api/v1/savings-goals/${GOAL_ID}/amount-changes`]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    }
  });

  it('returns one goal and maps a missing or foreign goal to 404', async () => {
    const { app } = await build({
      service: savingsService({
        getGoal: vi.fn(async (_owner: string, id: string) => {
          if (id === GOAL_ID) return goalView();
          throw new FinancialError({
            code: 'FINANCIAL_RESOURCE_UNAVAILABLE',
            statusCode: 404,
            safeMessage: 'The requested financial resource is unavailable.',
          });
        }),
      }),
    });
    expect((await app.inject({ method: 'GET', url: `/api/v1/savings-goals/${GOAL_ID}` })).statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/savings-goals/00000000-0000-4000-8000-0000000000ff' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('FINANCIAL_RESOURCE_UNAVAILABLE');
    expect((await app.inject({ method: 'GET', url: '/api/v1/savings-goals/not-a-uuid' })).statusCode).toBe(400);
  });

  it('lists amount history for the principal', async () => {
    const { app, service } = await build();
    const response = await app.inject({ method: 'GET', url: `/api/v1/savings-goals/${GOAL_ID}/amount-changes?limit=10` });
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({ source: 'initial', previousAmountMinor: null, actorType: 'user' });
    expect(service.listAmountChanges).toHaveBeenCalledWith(USER_ID, GOAL_ID, { limit: 10 });
  });
});

describe('savings-goal updates', () => {
  it('updates the current amount with the expected version and reason', async () => {
    const { app, service } = await build();
    const payload = { expectedVersion: '1', currentAmountMinor: '0', asOf: '2026-10-08', reason: 'Used for repair' };
    const response = await app.inject({
      method: 'POST', url: `/api/v1/savings-goals/${GOAL_ID}/current-amount`, headers: PROTECTED, payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ goalId: GOAL_ID, version: '2', amountChangeId: CHANGE_ID });
    expect(service.updateCurrentAmount).toHaveBeenCalledWith(USER_ID, GOAL_ID, payload, 'goal-key-1', expect.any(String));
  });

  it('rejects a current-amount update without an expected version', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/savings-goals/${GOAL_ID}/current-amount`,
      headers: PROTECTED,
      payload: { currentAmountMinor: '1', asOf: '2026-10-08' },
    });
    expect(response.statusCode).toBe(400);
    expect(service.updateCurrentAmount).not.toHaveBeenCalled();
  });

  it('maps a stale version to 409 SAVINGS_GOAL_VERSION_CONFLICT and an archived goal to 409', async () => {
    const { app } = await build({
      service: savingsService({
        updateCurrentAmount: vi.fn(async () => { throw savingsGoalVersionConflict(); }),
        archiveGoal: vi.fn(async () => { throw savingsGoalArchived(); }),
      }),
    });
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/savings-goals/${GOAL_ID}/current-amount`,
      headers: PROTECTED,
      payload: { expectedVersion: '1', currentAmountMinor: '1', asOf: '2026-10-08' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('SAVINGS_GOAL_VERSION_CONFLICT');
    const archived = await app.inject({
      method: 'POST', url: `/api/v1/savings-goals/${GOAL_ID}/archive`, headers: PROTECTED, payload: { expectedVersion: '1' },
    });
    expect(archived.statusCode).toBe(409);
    expect(archived.json().error.code).toBe('SAVINGS_GOAL_ARCHIVED');
  });

  it('edits plan details, forbids changing the current amount through PATCH, and requires a field', async () => {
    const { app, service } = await build();
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/savings-goals/${GOAL_ID}`,
      headers: PROTECTED,
      payload: { expectedVersion: '1', targetAmountMinor: '2000000', targetDate: null, contributionFrequency: null },
    });
    expect(ok.statusCode).toBe(200);
    expect(service.updatePlan).toHaveBeenCalledWith(
      USER_ID,
      GOAL_ID,
      { expectedVersion: '1', targetAmountMinor: '2000000', targetDate: null, contributionFrequency: null },
      'goal-key-1',
      expect.any(String),
    );
    const amount = await app.inject({
      method: 'PATCH', url: `/api/v1/savings-goals/${GOAL_ID}`, headers: PROTECTED,
      payload: { expectedVersion: '1', currentAmountMinor: '5' },
    });
    expect(amount.statusCode).toBe(400);
    const empty = await app.inject({
      method: 'PATCH', url: `/api/v1/savings-goals/${GOAL_ID}`, headers: PROTECTED, payload: { expectedVersion: '1' },
    });
    expect(empty.statusCode).toBe(400);
    expect(service.updatePlan).toHaveBeenCalledTimes(1);
  });

  it('archives with an expected version and marks replays', async () => {
    const { app, service } = await build({
      service: savingsService({ archiveGoal: vi.fn(async () => ({ goalId: GOAL_ID, version: '2', replayed: true })) }),
    });
    const response = await app.inject({
      method: 'POST', url: `/api/v1/savings-goals/${GOAL_ID}/archive`, headers: PROTECTED, payload: { expectedVersion: '1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['idempotency-replayed']).toBe('true');
    expect(service.archiveGoal).toHaveBeenCalledWith(USER_ID, GOAL_ID, { expectedVersion: '1' }, 'goal-key-1', expect.any(String));
  });
});
