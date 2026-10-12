import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  AuthSessionView,
  LoginResult,
  ProfileView,
  RegisterResult,
  VerifyEmailResult,
} from '@kfin/database';
import {
  buildApp,
  type BuildAppOptions,
  type FinancialApiService,
  type ScheduleApiService,
} from '../src/app.js';
import type { AuthApiService } from '../src/auth-routes.js';
import { RecordingEmailAdapter } from '../src/email-delivery.js';

/**
 * E-6 — the generic error handler mapped unparseable bodies to `500`.
 *
 * Recorded as an open finding by Milestone 10 (E-5) and, before that, by the
 * Milestone 05 QA fix, which noted that "the generic error handler still maps
 * Fastify content-type and JSON-parse errors to `500` on every route". Measured
 * on the pre-fix code, a **same-origin** request with a malformed JSON body
 * answered `500 INTERNAL_ERROR` on every route in the API, even though every
 * route publishes `400` in its OpenAPI contract.
 *
 * Cause: Fastify's content-type parsers reject the request before any handler or
 * schema validation runs, and they already attach the correct client status —
 * `400` for a malformed or empty JSON body, `415` for an unsupported media type,
 * `413` for a body over the configured limit. The generic handler inspected only
 * `validation` and `KfinServiceError`, so all of them fell through to its
 * catch-all `500`.
 *
 * This suite pins the corrected mapping, and pins the two properties that the
 * fix must not trade away:
 *
 * 1. **Precedence is unchanged.** `onRequest` guards still run before the body
 *    parser, so a cross-site request is still `403 AUTH_CSRF_FAILED` and an
 *    unauthenticated one is still `401 AUTHENTICATION_REQUIRED`, both *without*
 *    reading the body; and a body that parses but does not match the contract is
 *    still `400 REQUEST_VALIDATION_FAILED`, not `REQUEST_BODY_UNREADABLE`.
 * 2. **Nothing internal leaks.** The framework message is never echoed; the
 *    response carries a stable code, a fixed safe message and the correlation ID.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000003';

const CSRF_TOKEN = 'csrf-token-value-0123456789';
const CSRF_DIGEST = 'bound-csrf-digest';

const SAME_SITE = { host: 'api.kfin.test', origin: 'https://api.kfin.test' };
const WITH_CSRF = { ...SAME_SITE, 'x-kfin-csrf': CSRF_TOKEN };
const CROSS_SITE = { host: 'api.kfin.test', origin: 'https://evil.example' };

const SAFE_MESSAGE = 'The request body could not be read.';

interface BodyRoute {
  readonly label: string;
  readonly url: string;
  /** Path key as it appears in the published OpenAPI document. */
  readonly openapiPath: string;
  readonly method: 'POST';
  /** Headers a legitimate caller to this route would send. */
  readonly headers: Record<string, string>;
  /** Whether the route needs a session before its body is parsed. */
  readonly sessionBound: boolean;
  /**
   * Whether the route declares a body contract. `POST /api/v1/auth/logout` does
   * not — it takes no input — so a body on that route is parsed and then simply
   * ignored rather than validated. Keeping that distinction explicit stops the
   * validation assertions below from being applied to a route that has nothing to
   * validate.
   */
  readonly hasBodyContract: boolean;
}

/**
 * Three auth routes (the surface the finding was measured on) and one financial
 * mutation, to prove the mapping is a property of the shared error handler and
 * not of any single route family.
 */
const BODY_ROUTES: readonly BodyRoute[] = [
  {
    label: 'sign-in',
    url: '/api/v1/auth/login',
    openapiPath: '/auth/login',
    method: 'POST',
    headers: SAME_SITE,
    sessionBound: false,
    hasBodyContract: true,
  },
  {
    label: 'password change',
    url: '/api/v1/auth/password/change',
    openapiPath: '/auth/password/change',
    method: 'POST',
    headers: WITH_CSRF,
    sessionBound: true,
    hasBodyContract: true,
  },
  {
    label: 'sign-out (no body contract at all)',
    url: '/api/v1/auth/logout',
    openapiPath: '/auth/logout',
    method: 'POST',
    headers: WITH_CSRF,
    sessionBound: true,
    hasBodyContract: false,
  },
  {
    label: 'transaction write',
    url: '/api/v1/transactions',
    openapiPath: '/transactions',
    method: 'POST',
    headers: { ...WITH_CSRF, 'idempotency-key': 'e6-key' },
    sessionBound: true,
    hasBodyContract: true,
  },
];

/** The routes that declare a body contract, i.e. the ones with something to validate. */
const CONTRACTED_BODY_ROUTES = BODY_ROUTES.filter((route) => route.hasBodyContract);

const SESSION: AuthSessionView = {
  id: SESSION_ID,
  clientType: 'web',
  createdAt: '2026-10-08T02:00:00.000Z',
  lastSeenAt: '2026-10-08T02:00:00.000Z',
  idleExpiresAt: '2026-11-07T02:00:00.000Z',
  absoluteExpiresAt: '2027-01-06T02:00:00.000Z',
  deviceLabel: 'Mozilla iPhone',
  current: true,
};

function authService(): AuthApiService {
  const issued = () => ({ session: SESSION, sessionToken: 'token-never-in-body', csrfToken: CSRF_TOKEN });
  return {
    register: vi.fn(async (): Promise<RegisterResult> => ({
      userId: USER_ID, accepted: true, issued: false, resendAvailableAt: 'x', delivery: null,
    })),
    resendVerification: vi.fn(async () => ({ accepted: true as const, issued: false, resendAvailableAt: 'x', delivery: null })),
    verifyEmail: vi.fn(async (): Promise<VerifyEmailResult> => ({
      userId: USER_ID, status: 'active', session: issued(),
    })),
    login: vi.fn(async (): Promise<LoginResult> => ({ userId: USER_ID, session: issued() })),
    logout: vi.fn(async () => true),
    logoutAll: vi.fn(async () => 1),
    listSessions: vi.fn(async () => ({ items: [SESSION], nextCursor: null })),
    revokeSession: vi.fn(async () => true),
    changePassword: vi.fn(async () => ({ session: issued(), revokedOtherSessions: 0 })),
    requestPasswordReset: vi.fn(async () => ({ accepted: true as const, issued: false, delivery: null })),
    resetPassword: vi.fn(async () => ({ userId: USER_ID, sessionsRevoked: 0 })),
    listSecurityEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    getProfile: vi.fn(async (): Promise<ProfileView> => ({
      userId: USER_ID,
      email: 'beta.user@example.invalid',
      status: 'active',
      emailVerifiedAt: '2026-10-08T02:00:00.000Z',
      displayName: null,
      locale: 'vi-VN',
      timezone: 'Asia/Ho_Chi_Minh',
      baseCurrency: 'VND',
    })),
    verifyCsrfToken: vi.fn((presented: string | null | undefined) => presented === CSRF_TOKEN),
    recordChallengeDelivery: vi.fn(async () => undefined),
  };
}

const apps: FastifyInstance[] = [];

interface Services {
  readonly auth: AuthApiService;
  readonly financial: FinancialApiService;
}

async function build(options: { principal?: { userId: string; sessionId?: string; csrfDigest?: string } | null } = {}): Promise<{
  app: FastifyInstance;
  services: Services;
}> {
  const auth = authService();
  const financial = { createTransaction: vi.fn() } as unknown as FinancialApiService;
  const principal = options.principal === undefined
    ? { userId: USER_ID, sessionId: SESSION_ID, csrfDigest: CSRF_DIGEST }
    : options.principal;
  const app = await buildApp({
    financialService: financial,
    scheduleService: {} as unknown as ScheduleApiService,
    authService: auth,
    emailDelivery: new RecordingEmailAdapter(),
    authTransport: { secure: true, prefixHost: true },
    authenticate: async () => principal,
  } satisfies BuildAppOptions);
  apps.push(app);
  return { app, services: { auth, financial } };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('E-6 — an unreadable body is a client error, never 500', () => {
  /**
   * `FST_ERR_CTP_INVALID_JSON_BODY` on the pre-fix code and `400` after it. This
   * is the exact case the finding recorded.
   */
  it.each(BODY_ROUTES.map((route) => [route.label, route] as const))(
    'answers 400 for malformed JSON on %s',
    async (_label, route) => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...route.headers, 'content-type': 'application/json' },
        payload: '{"email":',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('REQUEST_BODY_UNREADABLE');
      expect(response.json().error.message).toBe(SAFE_MESSAGE);
    },
  );

  it.each(BODY_ROUTES.map((route) => [route.label, route] as const))(
    'answers 400 for a truncated JSON body on %s',
    async (_label, route) => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...route.headers, 'content-type': 'application/json' },
        payload: '{"email": "beta.user@example.invalid" ',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('REQUEST_BODY_UNREADABLE');
    },
  );

  it.each(BODY_ROUTES.map((route) => [route.label, route] as const))(
    'answers 400 for an empty JSON body on %s',
    async (_label, route) => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...route.headers, 'content-type': 'application/json' },
        payload: '',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('REQUEST_BODY_UNREADABLE');
    },
  );

  it.each(BODY_ROUTES.map((route) => [route.label, route] as const))(
    'answers 415 for a content type that has no parser on %s',
    async (_label, route) => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...route.headers, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=beta.user%40example.invalid',
      });

      expect(response.statusCode).toBe(415);
      expect(response.json().error.code).toBe('REQUEST_BODY_UNREADABLE');
      expect(response.json().error.message).toBe(SAFE_MESSAGE);
    },
  );

  it.each(BODY_ROUTES.map((route) => [route.label, route] as const))(
    'answers 413 for a body over the configured limit on %s',
    async (_label, route) => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...route.headers, 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'a'.repeat(70_000) }),
      });

      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe('REQUEST_BODY_UNREADABLE');
    },
  );

  /**
   * SEC-APP-11: prototype pollution is a parser-level rejection, and it must be a
   * client error like any other unparseable body.
   */
  it.each(BODY_ROUTES.map((route) => [route.label, route] as const))(
    'answers 400 for a prototype-pollution payload on %s',
    async (_label, route) => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...route.headers, 'content-type': 'application/json' },
        payload: '{"email":"beta.user@example.invalid","__proto__":{"polluted":true}}',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('REQUEST_BODY_UNREADABLE');
    },
  );

  it.each(BODY_ROUTES.map((route) => [route.label, route] as const))(
    'never answers 500 for the unreadable-body family on %s',
    async (_label, route) => {
      const { app } = await build();
      const responses = await Promise.all([
        app.inject({ method: 'POST', url: route.url, headers: { ...route.headers, 'content-type': 'application/json' }, payload: '{"email":' }),
        app.inject({ method: 'POST', url: route.url, headers: { ...route.headers, 'content-type': 'application/json' }, payload: '' }),
        app.inject({ method: 'POST', url: route.url, headers: { ...route.headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a=1' }),
        app.inject({ method: 'POST', url: route.url, headers: { ...route.headers, 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'a'.repeat(70_000) }) }),
      ]);

      for (const response of responses) {
        expect(response.statusCode).not.toBe(500);
        expect(response.json().error.code).not.toBe('INTERNAL_ERROR');
      }
    },
  );

  it.each(BODY_ROUTES.map((route) => [route.label, route] as const))(
    'returns a correlation id and never echoes framework wording on %s',
    async (_label, route) => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...route.headers, 'content-type': 'application/json', 'x-correlation-id': '00000000-0000-4000-8000-00000000000f' },
        payload: '{"email":',
      });

      const body = response.body;
      expect(response.json().error.correlationId).toBe('00000000-0000-4000-8000-00000000000f');
      // The framework's own wording must never reach the client.
      expect(body).not.toContain('FST_ERR');
      expect(body).not.toContain('content-type is set to');
      expect(body).not.toContain('is not valid JSON');
      expect(body).not.toContain('too large');
      expect(body).not.toContain('Unsupported Media Type');
      expect(Object.keys(response.json().error).sort()).toEqual(['code', 'correlationId', 'message']);
    },
  );

  it.each(BODY_ROUTES.map((route) => [route.label, route] as const))(
    'publishes the 400 it now returns in the %s OpenAPI contract',
    async (_label, route) => {
      const { app } = await build();
      const contract = await app.inject({ method: 'GET', url: '/openapi.json' });

      expect(contract.statusCode).toBe(200);
      const responses = contract.json().paths[route.openapiPath].post.responses;
      expect(Object.keys(responses)).toContain('400');
    },
  );
});

describe('E-6 — precedence is unchanged: guards still run before the parser', () => {
  it.each(BODY_ROUTES.map((route) => [route.label, route] as const))(
    'still answers 403 for a cross-site unreadable body on %s',
    async (_label, route) => {
      const { app, services } = await build();
      for (const contentType of ['application/json', 'application/x-www-form-urlencoded', 'text/plain']) {
        const response = await app.inject({
          method: 'POST',
          url: route.url,
          headers: { ...CROSS_SITE, 'content-type': contentType, 'x-kfin-csrf': CSRF_TOKEN, 'idempotency-key': 'e6-key' },
          payload: '{"email":',
        });

        // The browser defense at `onRequest` rejects before the parser runs, so
        // the new mapping never turns a cross-site rejection into a 400/415/413.
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
      }
      expect(services.auth.login).not.toHaveBeenCalled();
      expect(services.auth.changePassword).not.toHaveBeenCalled();
      expect(services.auth.logout).not.toHaveBeenCalled();
    },
  );

  it.each(BODY_ROUTES.filter((route) => route.sessionBound).map((route) => [route.label, route] as const))(
    'still answers 401 for an unauthenticated unreadable body on %s',
    async (_label, route) => {
      const { app } = await build({ principal: null });
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...route.headers, 'content-type': 'application/json' },
        payload: '{"email":',
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
    },
  );

  /**
   * A body that parses but does not match the contract keeps the mapping it had:
   * `FST_ERR_VALIDATION` is not a content-type-parser error and must not be
   * captured by the new branch.
   */
  it.each(CONTRACTED_BODY_ROUTES.map((route) => [route.label, route] as const))(
    'still answers 400 REQUEST_VALIDATION_FAILED for a schema-invalid body on %s',
    async (_label, route) => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: route.headers,
        payload: { unexpected: 'field' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
      expect(response.json().error.message).toBe('The request does not match the API contract.');
    },
  );

  it.each(CONTRACTED_BODY_ROUTES.map((route) => [route.label, route] as const))(
    'still answers 400 REQUEST_VALIDATION_FAILED for a parsed non-object body on %s',
    async (_label, route) => {
      const { app } = await build();
      // `text/plain` has a built-in parser, so this body parses to a string and
      // then fails the object contract — a validation error, not a parse error.
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...route.headers, 'content-type': 'text/plain' },
        payload: 'not-json-at-all',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('REQUEST_VALIDATION_FAILED');
    },
  );

  it('ignores a parsed body on the one write route that declares no body contract', async () => {
    const { app, services } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: WITH_CSRF,
      payload: { unexpected: 'field' },
    });

    // `POST /api/v1/auth/logout` takes no input, so there is nothing to validate:
    // the body is parsed and then discarded, and the request is served. Recorded
    // explicitly so that the absence of a validation assertion for this route is
    // a documented property rather than an unnoticed gap. Note the asymmetry that
    // matters here — a body that *parses* is ignored, while a body that cannot be
    // parsed at all is still `400 REQUEST_BODY_UNREADABLE`, because the JSON
    // parser runs for every route regardless of its contract.
    expect(response.statusCode).toBe(200);
    expect(services.auth.logout).toHaveBeenCalled();
  });

  it('still answers 400 AUTH_CSRF_FAILED-style 403 for a same-site request without the token', async () => {
    const { app } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: { ...SAME_SITE, 'content-type': 'application/json' },
      payload: '{"currentPassword":',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
  });
});

describe('E-6 — a readable, authorized body is unaffected', () => {
  it('serves sign-in for a same-origin caller', async () => {
    const { app, services } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_SITE,
      payload: { email: 'beta.user@example.invalid', password: 'value' },
    });

    expect(response.statusCode).toBe(200);
    expect(services.auth.login).toHaveBeenCalled();
  });

  it('still answers 500 for a genuine handler failure', async () => {
    const { app, services } = await build();
    vi.mocked(services.auth.login).mockRejectedValueOnce(new Error('synthetic internal failure'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: SAME_SITE,
      payload: { email: 'beta.user@example.invalid', password: 'value' },
    });

    // The new branch must not swallow real errors: this contract stays 400-class
    // only for bodies the parser refused, never for a handler that threw.
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
  });
});
