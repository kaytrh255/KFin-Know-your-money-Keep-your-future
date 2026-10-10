import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildApp,
  type FinancialApiService,
  type ScheduleApiService,
} from '../src/app.js';
import type { AuthApiService } from '../src/auth-routes.js';
import type { AuthenticatedPrincipal } from '../src/types.js';

/**
 * E-4 — browser write defense on the correction, void and schedule mutations.
 *
 * Milestone 07 recorded `POST /api/v1/transactions` as "the only authenticated
 * mutation still running plain `requireAuthentication`". That claim was false:
 * eight other mutation routes were equally unguarded at the Milestone 07 commit,
 * and the Milestone 07 record's own "Explicit non-goals" section contradicted it
 * by leaving corrections and schedule untouched. The discrepancy is preserved as
 * erratum **E-4** in `docs/evidence/2026-10-09-MILESTONE-07-VERIFICATION.md`
 * and restated in `docs/evidence/2026-10-10-MILESTONE-08-VERIFICATION.md`.
 *
 * Milestone 08 closed the snapshot route only. This suite is the regression
 * proof that the remaining seven registrations — eight URLs, because
 * `skip` and `cancel` share one handler — now take the same Milestone 04
 * same-origin plus session-bound double-submit CSRF defense at `onRequest`,
 * i.e. before content-type parsing, and that they fail closed.
 *
 * The routes are not read-only: correction and void commits append immutable
 * entries that move the authoritative current balance, and occurrence
 * confirmation posts a real transaction against it. The two preview routes are
 * guarded as writes because they mint the authoritative review context that the
 * corresponding commit route later accepts.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = '00000000-0000-4000-8000-000000000003';
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000004';
const REPLACEMENT_ID = '00000000-0000-4000-8000-000000000005';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000006';
const OCCURRENCE_ID = '00000000-0000-4000-8000-000000000007';
const SCHEDULED_ITEM_ID = '00000000-0000-4000-8000-000000000008';
const CONFIRMED_TRANSACTION_ID = '00000000-0000-4000-8000-000000000009';

const CSRF_TOKEN = 'csrf-token-value-0123456789';
const CSRF_DIGEST = 'bound-csrf-digest';
const BROWSER = { host: 'api.kfin.test', origin: 'https://api.kfin.test' };
const PROTECTED = { ...BROWSER, 'x-kfin-csrf': CSRF_TOKEN };
const PROTECTED_IDEM = { ...PROTECTED, 'idempotency-key': 'e4-key' };

const REVIEW_CONTEXT = {
  expectedFinancialStateVersion: '1',
  reviewedLatestSnapshotId: SNAPSHOT_ID,
  reviewedSourceVersion: '1',
  reviewedSourceSnapshotId: SNAPSHOT_ID,
  reviewedSourceBalanceEffect: 'current',
  reviewedSourceAlreadyIncludedInSnapshot: false,
  reviewedSourceKind: 'expense',
  reviewedSourceCurrency: 'VND',
  reviewedUserTimezone: 'Asia/Ho_Chi_Minh',
  reviewedUserVersion: '1',
  reviewedOwningDomain: {
    type: 'none',
    scheduleOccurrenceId: null,
    scheduleOccurrenceVersion: null,
  },
  reviewedPreviewDigest: 'a'.repeat(64),
} as const;

const REPLACEMENT = {
  amountMinor: '900',
  occurredOn: '2026-10-08',
  categoryCode: 'food',
  expenseClass: 'daily',
  isUnexpected: false,
} as const;

const TRANSITION_BODY = {
  reason: 'No longer relevant',
  expectedFinancialStateVersion: '1',
  reviewedLatestSnapshotId: SNAPSHOT_ID,
  reviewedOccurrenceVersion: '1',
} as const;

interface Services {
  readonly financial: FinancialApiService;
  readonly schedule: ScheduleApiService;
}

interface RouteCase {
  /** Human-readable name used in the generated test titles. */
  readonly label: string;
  readonly url: string;
  /** Path key as it appears in the published OpenAPI document. */
  readonly openapiPath: string;
  readonly body: Record<string, unknown>;
  readonly successStatus: 200 | 201;
  /** Whether the route declares the idempotency header contract. */
  readonly requiresIdempotencyKey: boolean;
  /**
   * The path parameter the handler passes as its **second** service argument,
   * for routes that have one. Anchors the argument list in the owner assertion
   * below, so it cannot silently assert against the wrong position. Absent for
   * `/schedule/one-off`, which takes no resource id.
   */
  readonly resourceId?: string;
  readonly spy: (services: Services) => unknown;
}

const ROUTES: readonly RouteCase[] = [
  {
    label: 'correction preview',
    resourceId: TRANSACTION_ID,
    url: `/api/v1/transactions/${TRANSACTION_ID}/correction-preview`,
    openapiPath: '/transactions/{id}/correction-preview',
    body: { replacement: REPLACEMENT, reason: 'Fix entered amount' },
    successStatus: 200,
    requiresIdempotencyKey: false,
    spy: (s) => s.financial.previewTransactionCorrection,
  },
  {
    label: 'void preview',
    resourceId: TRANSACTION_ID,
    url: `/api/v1/transactions/${TRANSACTION_ID}/void-preview`,
    openapiPath: '/transactions/{id}/void-preview',
    body: { reason: 'Entered by mistake' },
    successStatus: 200,
    requiresIdempotencyKey: false,
    spy: (s) => s.financial.previewTransactionVoid,
  },
  {
    label: 'correction commit',
    resourceId: TRANSACTION_ID,
    url: `/api/v1/transactions/${TRANSACTION_ID}/corrections`,
    openapiPath: '/transactions/{id}/corrections',
    body: { replacement: REPLACEMENT, reason: 'Fix entered amount', context: REVIEW_CONTEXT },
    successStatus: 201,
    requiresIdempotencyKey: true,
    spy: (s) => s.financial.correctTransaction,
  },
  {
    label: 'void commit',
    resourceId: TRANSACTION_ID,
    url: `/api/v1/transactions/${TRANSACTION_ID}/void`,
    openapiPath: '/transactions/{id}/void',
    body: { reason: 'Entered by mistake', context: REVIEW_CONTEXT },
    successStatus: 200,
    requiresIdempotencyKey: true,
    spy: (s) => s.financial.voidTransaction,
  },
  {
    label: 'one-off schedule creation',
    url: '/api/v1/schedule/one-off',
    openapiPath: '/schedule/one-off',
    body: {
      title: 'Rent',
      kind: 'expense',
      expectedAmountMinor: '12000000',
      dueOn: '2026-10-15',
      categoryCode: 'housing',
      expenseClass: 'essential_fixed',
      expectedFinancialStateVersion: '1',
      reviewedLatestSnapshotId: SNAPSHOT_ID,
    },
    successStatus: 201,
    requiresIdempotencyKey: true,
    spy: (s) => s.schedule.createOneOff,
  },
  {
    label: 'occurrence confirmation',
    resourceId: OCCURRENCE_ID,
    url: `/api/v1/schedule/occurrences/${OCCURRENCE_ID}/confirm`,
    openapiPath: '/schedule/occurrences/{id}/confirm',
    body: {
      amountMinor: '11900000',
      occurredOn: '2026-10-15',
      categoryCode: 'housing',
      expenseClass: 'essential_fixed',
      isUnexpected: false,
      expectedFinancialStateVersion: '2',
      reviewedLatestSnapshotId: SNAPSHOT_ID,
      reviewedOccurrenceVersion: '1',
    },
    successStatus: 201,
    requiresIdempotencyKey: true,
    spy: (s) => s.schedule.confirmOccurrence,
  },
  {
    label: 'occurrence skip',
    resourceId: OCCURRENCE_ID,
    url: `/api/v1/schedule/occurrences/${OCCURRENCE_ID}/skip`,
    openapiPath: '/schedule/occurrences/{id}/skip',
    body: TRANSITION_BODY,
    successStatus: 200,
    requiresIdempotencyKey: true,
    spy: (s) => s.schedule.transitionOccurrence,
  },
  {
    label: 'occurrence cancel',
    resourceId: OCCURRENCE_ID,
    url: `/api/v1/schedule/occurrences/${OCCURRENCE_ID}/cancel`,
    openapiPath: '/schedule/occurrences/{id}/cancel',
    body: TRANSITION_BODY,
    successStatus: 200,
    requiresIdempotencyKey: true,
    spy: (s) => s.schedule.transitionOccurrence,
  },
];

const MUTATIONS_REQUIRING_IDEMPOTENCY_KEY = ROUTES.filter((route) => route.requiresIdempotencyKey);

function correctionPreview(operation: 'correction' | 'void', replacement: unknown) {
  return {
    operation,
    source: {
      transactionId: TRANSACTION_ID,
      amountMinor: '1000',
      occurredOn: '2026-10-08',
      categoryCode: 'food',
      expenseClass: 'daily',
      isUnexpected: false,
      note: null,
    },
    replacement,
    authority: {
      currency: 'VND',
      balanceSnapshotId: SNAPSHOT_ID,
      snapshotEffectiveAt: '2026-10-08T00:00:00.000Z',
      balanceEffect: 'current',
      alreadyIncludedInSnapshot: false,
      segment: 'latest',
    },
    currentBalance: {
      beforeMinor: '999000',
      deltaMinor: '100',
      afterMinor: '999100',
      changes: true,
    },
    reports: {
      removed: { month: '2026-10', categoryCode: 'food', kind: 'expense' },
      added: { month: '2026-10', categoryCode: 'food', kind: 'expense' },
    },
    owningDomain: {
      type: 'none',
      genericCorrectionSupported: true,
      genericVoidSupported: true,
      unsupportedReasonCode: null,
      scheduleOccurrenceId: null,
      scheduleOccurrenceVersion: null,
    },
    context: REVIEW_CONTEXT,
  };
}

function commitResult(replacementTransactionId: string | null) {
  return {
    sourceTransactionId: TRANSACTION_ID,
    replacementTransactionId,
    financialStateVersion: '2',
    consequence: {
      currentBalance: {
        beforeMinor: '999000',
        deltaMinor: '100',
        afterMinor: '999100',
        changes: true,
      },
      reports: {
        removed: { month: '2026-10', categoryCode: 'food', kind: 'expense' },
        added: { month: '2026-10', categoryCode: 'food', kind: 'expense' },
      },
      owningDomain: {
        type: 'none',
        scheduleOccurrenceId: null,
        scheduleOccurrenceVersion: null,
      },
    },
  };
}

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
    getTransaction: unexpected,
    getTransactionCorrectionHistory: vi.fn(async () => ({ items: [], nextCursor: null })),
    listTransactions: unexpected,
    previewTransactionCorrection: vi.fn(
      async () => correctionPreview('correction', {
        amountMinor: '900',
        occurredOn: '2026-10-08',
        categoryCode: 'food',
        expenseClass: 'daily',
        isUnexpected: false,
        note: null,
      }),
    ),
    previewTransactionVoid: vi.fn(async () => correctionPreview('void', null)),
    correctTransaction: vi.fn(async () => commitResult(REPLACEMENT_ID)),
    voidTransaction: vi.fn(async () => commitResult(null)),
    getMonthlyActuals: unexpected,
    ...overrides,
  } as FinancialApiService;
}

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

function scheduleService(overrides: Partial<ScheduleApiService> = {}): ScheduleApiService {
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
      transactionId: CONFIRMED_TRANSACTION_ID,
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
    ...overrides,
  } as ScheduleApiService;
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
  financial?: FinancialApiService;
  schedule?: ScheduleApiService;
  principal?: AuthenticatedPrincipal | null;
  authService?: AuthApiService | null;
} = {}): Promise<{ app: FastifyInstance; services: Services }> {
  const financial = options.financial ?? financialService();
  const schedule = options.schedule ?? scheduleService();
  const authService = options.authService === null
    ? undefined
    : options.authService ?? csrfVerifier();
  const principal = options.principal === undefined
    ? { userId: USER_ID, sessionId: SESSION_ID, csrfDigest: CSRF_DIGEST }
    : options.principal;
  const app = await buildApp({
    financialService: financial,
    scheduleService: schedule,
    ...(authService ? { authService } : {}),
    authenticate: async () => principal,
  });
  apps.push(app);
  return { app, services: { financial, schedule } };
}

const spyOf = (route: RouteCase, services: Services): Mock => route.spy(services) as Mock;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('E-4 — correction, void and schedule mutations (browser write defense)', () => {
  it.each(ROUTES.map((route) => [route.label, route] as const))(
    'serves %s for an authorized same-origin caller',
    async (_label, route) => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: PROTECTED_IDEM,
        payload: route.body,
      });

      expect(response.statusCode).toBe(route.successStatus);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    'accepts same-site Fetch Metadata on %s without an Origin header',
    async (_label, route) => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: {
          host: 'api.kfin.test',
          'sec-fetch-site': 'same-origin',
          'x-kfin-csrf': CSRF_TOKEN,
          'idempotency-key': 'e4-key',
        },
        payload: route.body,
      });

      expect(response.statusCode).toBe(route.successStatus);
    },
  );

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    'rejects an unauthenticated %s with 401 before the service',
    async (_label, route) => {
      const { app, services } = await build({ principal: null });
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: PROTECTED_IDEM,
        payload: route.body,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
      expect(spyOf(route, services)).not.toHaveBeenCalled();
    },
  );

  const DEFENSE_MATRIX: readonly {
    readonly caseLabel: string;
    readonly route: RouteCase;
    readonly headers: Record<string, string>;
  }[] = ROUTES.flatMap((route) => [
    {
      caseLabel: 'missing CSRF header',
      route,
      headers: { ...BROWSER, 'idempotency-key': 'e4-key' },
    },
    {
      caseLabel: 'wrong CSRF token',
      route,
      headers: {
        ...BROWSER,
        'x-kfin-csrf': 'wrong-token-value-000000',
        'idempotency-key': 'e4-key',
      },
    },
    {
      caseLabel: 'foreign Origin',
      route,
      headers: {
        host: 'api.kfin.test',
        origin: 'https://evil.example',
        'x-kfin-csrf': CSRF_TOKEN,
        'idempotency-key': 'e4-key',
      },
    },
    {
      caseLabel: 'scheme-less lookalike Origin',
      route,
      headers: {
        host: 'api.kfin.test',
        origin: 'https://api.kfin.test.evil.example',
        'x-kfin-csrf': CSRF_TOKEN,
        'idempotency-key': 'e4-key',
      },
    },
    {
      caseLabel: 'cross-site Fetch Metadata',
      route,
      headers: {
        host: 'api.kfin.test',
        'sec-fetch-site': 'cross-site',
        'x-kfin-csrf': CSRF_TOKEN,
        'idempotency-key': 'e4-key',
      },
    },
    {
      caseLabel: 'no Origin and no Fetch Metadata',
      route,
      headers: {
        host: 'api.kfin.test',
        'x-kfin-csrf': CSRF_TOKEN,
        'idempotency-key': 'e4-key',
      },
    },
  ]);

  it.each(DEFENSE_MATRIX)(
    'rejects $caseLabel on $route.label with 403 AUTH_CSRF_FAILED before the service',
    async ({ route, headers }) => {
      const { app, services } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers,
        payload: route.body,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
      expect(spyOf(route, services)).not.toHaveBeenCalled();
    },
  );

  const BODY_PARSING_MATRIX: readonly {
    readonly caseLabel: string;
    readonly route: RouteCase;
    readonly contentType: string;
    readonly payload: string;
  }[] = ROUTES.flatMap((route) => [
    {
      caseLabel: 'HTML form (urlencoded)',
      route,
      contentType: 'application/x-www-form-urlencoded',
      payload: 'title=Rent',
    },
    { caseLabel: 'plain text', route, contentType: 'text/plain', payload: 'title=Rent' },
    { caseLabel: 'malformed JSON', route, contentType: 'application/json', payload: '{"title":' },
  ]);

  it.each(BODY_PARSING_MATRIX)(
    'rejects a cross-site $caseLabel POST to $route.label with 403 before body parsing',
    async ({ route, contentType, payload: rawBody }) => {
      const { app, services } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: {
          host: 'api.kfin.test',
          origin: 'https://evil.example',
          'content-type': contentType,
        },
        payload: rawBody,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
      expect(spyOf(route, services)).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    'fails closed on %s when the principal has no session-bound CSRF digest',
    async (_label, route) => {
      const { app, services } = await build({ principal: { userId: USER_ID } });
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: PROTECTED_IDEM,
        payload: route.body,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
      expect(spyOf(route, services)).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    'fails closed on %s when no CSRF verifier (auth service) is configured',
    async (_label, route) => {
      const { app, services } = await build({ authService: null });
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: PROTECTED_IDEM,
        payload: route.body,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
      expect(spyOf(route, services)).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    'derives the owner on %s from the authenticated principal on a valid request',
    async (_label, route) => {
      const { app, services } = await build();
      const spy = spyOf(route, services);
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        // A client-supplied owner header is present on an otherwise valid
        // request and must be ignored: the owner comes from the principal.
        headers: { ...PROTECTED_IDEM, 'x-user-id': OTHER_USER_ID },
        payload: route.body,
      });

      expect(response.statusCode).toBe(route.successStatus);
      expect(spy).toHaveBeenCalledTimes(1);

      // Every handler in this set takes the owner as its first service argument
      // and, where the path carries one, the resource id as its second. The
      // resource id anchor keeps this assertion pinned to the right positions.
      const args = spy.mock.calls[0] as unknown[];
      expect(args[0]).toBe(USER_ID);
      expect(args[0]).not.toBe(OTHER_USER_ID);
      if (route.resourceId !== undefined) expect(args[1]).toBe(route.resourceId);

      // The injected owner never reaches the service in any position.
      expect(args).not.toContain(OTHER_USER_ID);
    },
  );

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    'rejects a client-supplied owner on %s at the strict body boundary',
    async (_label, route) => {
      const { app, services } = await build();
      const spy = spyOf(route, services);
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...PROTECTED_IDEM, 'x-user-id': OTHER_USER_ID },
        payload: { userId: OTHER_USER_ID, ownerId: OTHER_USER_ID, ...route.body },
      });

      // Every body contract in this set is a `z.strictObject`, so an injected
      // owner is rejected by validation: the handler is never reached and no
      // owner other than the principal's can ever be passed to the service.
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each(MUTATIONS_REQUIRING_IDEMPOTENCY_KEY.map((route) => [route.label, route] as const))(
    'still requires an Idempotency-Key on %s for an authorized same-origin caller',
    async (_label, route) => {
      const { app, services } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: PROTECTED,
        payload: route.body,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
      expect(spyOf(route, services)).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    'publishes the 403 defense in the %s OpenAPI contract',
    async (_label, route) => {
      const { app } = await build();
      const contract = await app.inject({ method: 'GET', url: '/openapi.json' });

      expect(contract.statusCode).toBe(200);
      const responses = contract.json().paths[route.openapiPath].post.responses;
      expect(Object.keys(responses)).toContain('403');
    },
  );
});

describe('E-4 — the defense is scoped to mutations, not reads', () => {
  it('leaves the schedule read routes on plain authentication', async () => {
    const { app, services } = await build();
    const list = await app.inject({ method: 'GET', url: '/api/v1/schedule/occurrences' });
    const read = await app.inject({ method: 'GET', url: `/api/v1/schedule/occurrences/${OCCURRENCE_ID}` });

    expect(list.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    expect(services.schedule.listOccurrences).toHaveBeenCalled();
    expect(services.schedule.getOccurrence).toHaveBeenCalled();
  });

  it('leaves the correction history read on plain authentication', async () => {
    const { app, services } = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/transactions/${TRANSACTION_ID}/correction-history?limit=1`,
    });

    expect(response.statusCode).toBe(200);
    expect(services.financial.getTransactionCorrectionHistory).toHaveBeenCalled();
  });
});
