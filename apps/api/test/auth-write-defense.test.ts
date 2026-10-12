import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  AuthSessionView,
  LoginResult,
  ProfileView,
  RegisterResult,
  SecurityEventPage,
  VerifyEmailResult,
} from '@kfin/database';
import { buildApp, type BuildAppOptions, type FinancialApiService } from '../src/app.js';
import type { AuthApiService } from '../src/auth-routes.js';
import { RecordingEmailAdapter } from '../src/email-delivery.js';

/**
 * E-5 — browser state-change defense on the trusted-beta access surface.
 *
 * Milestone 09 closed E-4 and recorded, as a finding deliberately left open,
 * that `apps/api/src/auth-routes.ts` "applies its own `isBrowserSafeRequest` plus
 * double-submit check inline per route rather than via
 * `requireCsrfProtectedAuthentication` … It was left untouched and should be
 * independently reviewed."
 *
 * This suite is that review, and the regression proof for the two defects it
 * found. Neither is an authentication bypass: an authenticated cross-site write
 * was already rejected. Both are defense *placement* defects, and both are
 * observable from outside the process:
 *
 *  1. **The check ran inside the handler, not at `onRequest`.** The six
 *     pre-session write routes called `isBrowserSafeRequest` as the first
 *     statement of their handler body, i.e. after content-type parsing and Zod
 *     body validation. Measured on the pre-Milestone-10 code: a cross-site
 *     request with a schema-invalid body answered `400 REQUEST_VALIDATION_FAILED`
 *     and a cross-site request with malformed JSON or an unsupported media type
 *     answered `500` — in all three cases the browser-safety check never ran, so
 *     the defense was not the first thing evaluated and the answer to a
 *     cross-site caller differed from the answer to a same-site one.
 *  2. **`HEAD` was treated as a state-changing method.** `requireAccess` exempted
 *     only `request.method === 'GET'`, while `isBrowserSafeRequest` treats
 *     `GET`, `HEAD` and `OPTIONS` as safe (its own source, and RFC 9110 §9.2.1).
 *     Fastify auto-exposes `HEAD` for every declared `GET` route, so a
 *     same-origin `HEAD` of an authenticated read answered `403
 *     AUTH_CSRF_FAILED` unless the caller sent the CSRF header.
 *
 * Both are `onRequest`-placement corrections; the session-bound write routes now
 * resolve the principal in their guard exactly like
 * `requireCsrfProtectedAuthentication` does, and the pre-session routes run the
 * same-origin half of the same defense at the same lifecycle point. No body
 * contract, service behaviour, idempotency rule or error envelope changed.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = '00000000-0000-4000-8000-000000000003';
const OTHER_SESSION_ID = '00000000-0000-4000-8000-000000000004';

const CSRF_TOKEN = 'csrf-token-value-0123456789';
const CSRF_DIGEST = 'bound-csrf-digest';

const SAME_SITE = { host: 'api.kfin.test', origin: 'https://api.kfin.test' };
const WITH_CSRF = { ...SAME_SITE, 'x-kfin-csrf': CSRF_TOKEN };

/**
 * The cases that must answer `403` before the body is parsed. `scheme-less
 * lookalike` is the M09 case: an origin that merely *contains* the host must not
 * be accepted.
 */
const UNSAFE_BROWSER_CONTEXTS = [
  ['foreign origin', { host: 'api.kfin.test', origin: 'https://evil.example' }],
  ['scheme-less lookalike origin', { host: 'api.kfin.test', origin: 'https://api.kfin.test.evil.example' }],
  ['cross-site Fetch Metadata', { host: 'api.kfin.test', 'sec-fetch-site': 'cross-site' }],
  ['no Origin and no Fetch Metadata', { host: 'api.kfin.test' }],
] as const;

const CROSS_SITE = { host: 'api.kfin.test', origin: 'https://evil.example' };

interface PreSessionRoute {
  readonly label: string;
  readonly url: string;
  /** Path key as it appears in the published OpenAPI document. */
  readonly openapiPath: string;
  readonly body: Record<string, unknown>;
  readonly successStatus: 200 | 202;
  readonly spy: (service: AuthApiService) => unknown;
}

/**
 * The six write routes reachable without a session. No session exists, so the
 * session-bound double-submit token cannot apply to them; the same-origin /
 * Fetch Metadata half does, and it must run before the body is parsed.
 */
const PRE_SESSION_ROUTES: readonly PreSessionRoute[] = [
  {
    label: 'registration',
    url: '/api/v1/auth/register',
    openapiPath: '/auth/register',
    body: {
      email: 'beta.user@example.invalid',
      password: 'correct horse battery staple',
      invitationCode: 'ABCDEFGH-JKMNPQRS-TVWXYZ23-456789AB',
      locale: 'vi-VN',
      timezone: 'Asia/Ho_Chi_Minh',
      baseCurrency: 'VND',
    },
    successStatus: 202,
    spy: (service) => service.register,
  },
  {
    label: 'verification resend',
    url: '/api/v1/auth/verification/resend',
    openapiPath: '/auth/verification/resend',
    body: { email: 'beta.user@example.invalid' },
    successStatus: 200,
    spy: (service) => service.resendVerification,
  },
  {
    label: 'email verification',
    url: '/api/v1/auth/verify-email',
    openapiPath: '/auth/verify-email',
    body: { email: 'beta.user@example.invalid', oneTimeCode: '123456' },
    successStatus: 200,
    spy: (service) => service.verifyEmail,
  },
  {
    label: 'sign-in',
    url: '/api/v1/auth/login',
    openapiPath: '/auth/login',
    body: { email: 'beta.user@example.invalid', password: 'value' },
    successStatus: 200,
    spy: (service) => service.login,
  },
  {
    label: 'password reset request',
    url: '/api/v1/auth/password/reset-request',
    openapiPath: '/auth/password/reset-request',
    body: { email: 'beta.user@example.invalid' },
    successStatus: 200,
    spy: (service) => service.requestPasswordReset,
  },
  {
    label: 'password reset completion',
    url: '/api/v1/auth/password/reset',
    openapiPath: '/auth/password/reset',
    body: {
      email: 'beta.user@example.invalid',
      resetSecret: 'reset-secret-value-0123456789012345678901',
      newPassword: 'a-brand-new-passphrase',
    },
    successStatus: 200,
    spy: (service) => service.resetPassword,
  },
];

interface SessionBoundRoute {
  readonly label: string;
  readonly method: 'POST' | 'DELETE';
  readonly url: string;
  readonly openapiPath: string;
  readonly body?: Record<string, unknown>;
  readonly spy: (service: AuthApiService) => unknown;
}

/**
 * The four session-bound write routes. They already required the double-submit
 * token, but resolved it inside the handler; they now do it at `onRequest`.
 */
const SESSION_BOUND_ROUTES: readonly SessionBoundRoute[] = [
  {
    label: 'sign-out',
    method: 'POST',
    url: '/api/v1/auth/logout',
    openapiPath: '/auth/logout',
    spy: (service) => service.logout,
  },
  {
    label: 'sign-out everywhere',
    method: 'POST',
    url: '/api/v1/auth/logout-all',
    openapiPath: '/auth/logout-all',
    spy: (service) => service.logoutAll,
  },
  {
    label: 'session revocation',
    method: 'DELETE',
    url: `/api/v1/auth/sessions/${OTHER_SESSION_ID}`,
    openapiPath: '/auth/sessions/{id}',
    spy: (service) => service.revokeSession,
  },
  {
    label: 'password change',
    method: 'POST',
    url: '/api/v1/auth/password/change',
    openapiPath: '/auth/password/change',
    body: {
      currentPassword: 'current-passphrase-value',
      newPassword: 'next-passphrase-value-1',
    },
    spy: (service) => service.changePassword,
  },
];

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

function issued() {
  return { session: SESSION, sessionToken: 'bearer-token-value-never-in-body', csrfToken: CSRF_TOKEN };
}

function authService(overrides: Partial<AuthApiService> = {}): AuthApiService {
  return {
    register: vi.fn(async (): Promise<RegisterResult> => ({
      userId: USER_ID,
      accepted: true,
      issued: true,
      resendAvailableAt: '2026-10-08T02:01:00.000Z',
      delivery: null,
    })),
    resendVerification: vi.fn(async () => ({
      accepted: true as const,
      issued: false,
      resendAvailableAt: '2026-10-08T02:01:00.000Z',
      delivery: null,
    })),
    verifyEmail: vi.fn(async (): Promise<VerifyEmailResult> => ({
      userId: USER_ID,
      status: 'active',
      session: issued(),
    })),
    login: vi.fn(async (): Promise<LoginResult> => ({ userId: USER_ID, session: issued() })),
    logout: vi.fn(async () => true),
    logoutAll: vi.fn(async () => 3),
    listSessions: vi.fn(async () => ({ items: [SESSION], nextCursor: null })),
    revokeSession: vi.fn(async () => true),
    changePassword: vi.fn(async () => ({ session: issued(), revokedOtherSessions: 2 })),
    requestPasswordReset: vi.fn(async () => ({
      accepted: true as const,
      issued: false,
      delivery: null,
    })),
    resetPassword: vi.fn(async () => ({ userId: USER_ID, sessionsRevoked: 4 })),
    listSecurityEvents: vi.fn(async (): Promise<SecurityEventPage> => ({ items: [], nextCursor: null })),
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
    ...overrides,
  };
}

const apps: FastifyInstance[] = [];

async function build(options: {
  service?: AuthApiService;
  principal?: { userId: string; sessionId?: string; csrfDigest?: string } | null;
} = {}): Promise<{ app: FastifyInstance; service: AuthApiService }> {
  const service = options.service ?? authService();
  const principal = options.principal === undefined
    ? { userId: USER_ID, sessionId: SESSION_ID, csrfDigest: CSRF_DIGEST }
    : options.principal;
  const app = await buildApp({
    financialService: {} as unknown as FinancialApiService,
    authService: service,
    emailDelivery: new RecordingEmailAdapter(),
    authTransport: { secure: true, prefixHost: true },
    authenticate: async () => principal,
  } satisfies BuildAppOptions);
  apps.push(app);
  return { app, service };
}

const spyOf = (route: PreSessionRoute | SessionBoundRoute, service: AuthApiService): Mock =>
  route.spy(service) as Mock;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('E-5 — the pre-session write surface (no session exists yet)', () => {
  it.each(PRE_SESSION_ROUTES.map((route) => [route.label, route] as const))(
    'still serves %s for a same-origin caller',
    async (_label, route) => {
      const { app, service } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: SAME_SITE,
        payload: route.body,
      });

      expect(response.statusCode).toBe(route.successStatus);
      expect(spyOf(route, service)).toHaveBeenCalled();
    },
  );

  it.each(PRE_SESSION_ROUTES.map((route) => [route.label, route] as const))(
    'accepts same-site Fetch Metadata on %s without an Origin header',
    async (_label, route) => {
      const { app, service } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { host: 'api.kfin.test', 'sec-fetch-site': 'same-origin' },
        payload: route.body,
      });

      expect(response.statusCode).toBe(route.successStatus);
      expect(spyOf(route, service)).toHaveBeenCalled();
    },
  );

  it.each(
    PRE_SESSION_ROUTES.flatMap((route) =>
      UNSAFE_BROWSER_CONTEXTS.map(([context, headers]) => [route.label, context, route, headers] as const),
    ),
  )(
    'rejects %s with 403 for a %s and never calls the service',
    async (_label, _context, route, headers) => {
      const { app, service } = await build();
      const response = await app.inject({
        method: 'POST',
        url: route.url,
        headers,
        payload: route.body,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
      expect(spyOf(route, service)).not.toHaveBeenCalled();
    },
  );

  /**
   * The E-5 assertion. These bodies are *unparseable or invalid by design*, so on
   * the pre-Milestone-10 code the parse/validation failure decided the response
   * (`500` for malformed JSON and for an unsupported media type, `400` for a
   * schema-invalid body) and the browser-safety check was never reached. Answering
   * `403` proves the check now runs before parsing.
   */
  it.each(PRE_SESSION_ROUTES.map((route) => [route.label, route] as const))(
    'rejects %s with 403 before body parsing, whatever the body looks like',
    async (_label, route) => {
      const { app, service } = await build();

      const malformed = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...CROSS_SITE, 'content-type': 'application/json' },
        payload: '{"email":',
      });
      const urlencoded = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...CROSS_SITE, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=beta.user%40example.invalid&password=value',
      });
      const plainText = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...CROSS_SITE, 'content-type': 'text/plain' },
        payload: 'not-json-at-all',
      });
      const schemaInvalid = await app.inject({
        method: 'POST',
        url: route.url,
        headers: CROSS_SITE,
        payload: { unexpected: 'field', userId: OTHER_USER_ID },
      });

      for (const response of [malformed, urlencoded, plainText, schemaInvalid]) {
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
      }
      // Anchored explicitly: a 500 here would mean the body parser saw the
      // request first, which is the defect this suite exists to prevent.
      expect(malformed.statusCode).not.toBe(500);
      expect(urlencoded.statusCode).not.toBe(500);
      expect(schemaInvalid.statusCode).not.toBe(400);
      expect(spyOf(route, service)).not.toHaveBeenCalled();
    },
  );

  it.each(PRE_SESSION_ROUTES.map((route) => [route.label, route] as const))(
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

describe('E-5 — the session-bound write surface', () => {
  it.each(SESSION_BOUND_ROUTES.map((route) => [route.label, route] as const))(
    'serves %s for an authorized same-origin caller holding the CSRF token',
    async (_label, route) => {
      const { app, service } = await build();
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: WITH_CSRF,
        ...(route.body === undefined ? {} : { payload: route.body }),
      });

      expect(response.statusCode).toBe(200);
      expect(spyOf(route, service)).toHaveBeenCalled();
    },
  );

  it.each(SESSION_BOUND_ROUTES.map((route) => [route.label, route] as const))(
    'answers 401 on %s without a session',
    async (_label, route) => {
      const { app, service } = await build({ principal: null });
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: WITH_CSRF,
        ...(route.body === undefined ? {} : { payload: route.body }),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
      expect(spyOf(route, service)).not.toHaveBeenCalled();
    },
  );

  it.each(SESSION_BOUND_ROUTES.map((route) => [route.label, route] as const))(
    'rejects %s with 403 when the CSRF token is missing or wrong',
    async (_label, route) => {
      const { app, service } = await build();

      const missing = await app.inject({
        method: route.method,
        url: route.url,
        headers: SAME_SITE,
        ...(route.body === undefined ? {} : { payload: route.body }),
      });
      const wrong = await app.inject({
        method: route.method,
        url: route.url,
        headers: { ...SAME_SITE, 'x-kfin-csrf': 'not-the-bound-token' },
        ...(route.body === undefined ? {} : { payload: route.body }),
      });

      for (const response of [missing, wrong]) {
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
      }
      expect(spyOf(route, service)).not.toHaveBeenCalled();
    },
  );

  it.each(
    SESSION_BOUND_ROUTES.flatMap((route) =>
      UNSAFE_BROWSER_CONTEXTS.map(([context, headers]) => [route.label, context, route, headers] as const),
    ),
  )(
    'rejects %s with 403 for a %s even when the session is valid',
    async (_label, _context, route, headers) => {
      const { app, service } = await build();
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { ...headers, 'x-kfin-csrf': CSRF_TOKEN },
        ...(route.body === undefined ? {} : { payload: route.body }),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
      expect(spyOf(route, service)).not.toHaveBeenCalled();
    },
  );

  it.each(SESSION_BOUND_ROUTES.map((route) => [route.label, route] as const))(
    'fails closed on %s when the principal carries no CSRF digest',
    async (_label, route) => {
      const { app, service } = await build({ principal: { userId: USER_ID, sessionId: SESSION_ID } });
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: WITH_CSRF,
        ...(route.body === undefined ? {} : { payload: route.body }),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
      expect(spyOf(route, service)).not.toHaveBeenCalled();
    },
  );

  /**
   * The E-5 ordering assertion for this surface. `password/change` is the one
   * session-bound write route with a body, so it is the one where an unparsed
   * body used to decide the answer: measured on the pre-Milestone-10 code this
   * request answered `500`, not `403`.
   */
  it('rejects a cross-site password change with 403 before body parsing', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: { ...CROSS_SITE, 'content-type': 'application/json' },
      payload: '{"currentPassword":',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_CSRF_FAILED');
    expect(response.statusCode).not.toBe(500);
    expect(service.changePassword).not.toHaveBeenCalled();
  });

  it.each(SESSION_BOUND_ROUTES.map((route) => [route.label, route] as const))(
    'publishes the 403 defense in the %s OpenAPI contract',
    async (_label, route) => {
      const { app } = await build();
      const contract = await app.inject({ method: 'GET', url: '/openapi.json' });

      expect(contract.statusCode).toBe(200);
      const responses = contract.json().paths[route.openapiPath][route.method.toLowerCase()].responses;
      expect(Object.keys(responses)).toContain('403');
    },
  );
});

describe('E-5 — the defense is scoped to state-changing methods', () => {
  it('leaves the read routes on plain session authentication', async () => {
    const { app, service } = await build();
    for (const url of ['/api/v1/auth/me', '/api/v1/auth/sessions', '/api/v1/auth/security-events']) {
      const response = await app.inject({ method: 'GET', url, headers: SAME_SITE });
      expect(response.statusCode).toBe(200);
    }
    expect(service.getProfile).toHaveBeenCalled();
    expect(service.listSessions).toHaveBeenCalled();
    expect(service.listSecurityEvents).toHaveBeenCalled();
  });

  /**
   * The E-5 safe-method assertion. Fastify auto-exposes `HEAD` for every declared
   * `GET` route, and `HEAD` is a safe method by RFC 9110 §9.2.1 and by
   * `isBrowserSafeRequest`'s own definition — but `requireAccess` exempted only
   * `'GET'`, so this request answered `403` before the fix.
   */
  it('does not demand a CSRF token for HEAD of an authenticated read', async () => {
    const { app } = await build();
    const response = await app.inject({ method: 'HEAD', url: '/api/v1/auth/me', headers: SAME_SITE });

    expect(response.statusCode).toBe(200);
  });

  it('makes HEAD mirror GET for a cross-site caller, because a safe method carries no state change', async () => {
    const { app } = await build();
    const get = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: CROSS_SITE });
    const head = await app.inject({ method: 'HEAD', url: '/api/v1/auth/me', headers: CROSS_SITE });

    // Pre-existing semantics, unchanged by this milestone: a read is governed by
    // session authentication alone, so the same-origin check does not apply to it
    // (the response body of a cross-origin read is not readable to the caller
    // anyway). HEAD now mirrors GET instead of answering 403.
    expect(get.statusCode).toBe(200);
    expect(head.statusCode).toBe(get.statusCode);
  });
});
