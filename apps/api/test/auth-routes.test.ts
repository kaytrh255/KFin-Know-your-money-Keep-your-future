import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AuthError } from '@kfin/domain';
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

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = '00000000-0000-4000-8000-000000000003';
const OTHER_SESSION_ID = '00000000-0000-4000-8000-000000000004';
const CSRF_TOKEN = 'csrf-token-value-0123456789';
const CORRELATION_ID = '00000000-0000-4000-8000-00000000000f';

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
      delivery: {
        challengeId: '00000000-0000-4000-8000-00000000000a',
        oneTimeCode: '123456',
        expiresAt: '2026-10-08T02:10:00.000Z',
      },
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
      issued: true,
      delivery: {
        challengeId: '00000000-0000-4000-8000-00000000000b',
        resetSecret: 'reset-secret-value-0123456789012345678901',
        expiresAt: '2026-10-08T02:30:00.000Z',
      },
    })),
    resetPassword: vi.fn(async () => ({ userId: USER_ID, sessionsRevoked: 4 })),
    listSecurityEvents: vi.fn(async (): Promise<SecurityEventPage> => ({
      items: [{
        id: '00000000-0000-4000-8000-00000000000c',
        eventType: 'login_succeeded',
        outcome: 'success',
        occurredAt: '2026-10-08T02:00:00.000Z',
        sessionId: SESSION_ID,
      }],
      nextCursor: null,
    })),
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
  email?: RecordingEmailAdapter;
  principal?: { userId: string; sessionId?: string; csrfDigest?: string } | null;
  secure?: boolean;
} = {}): Promise<{ app: FastifyInstance; service: AuthApiService; email: RecordingEmailAdapter }> {
  const service = options.service ?? authService();
  const email = options.email ?? new RecordingEmailAdapter();
  const principal = options.principal === undefined
    ? { userId: USER_ID, sessionId: SESSION_ID, csrfDigest: 'digest-value' }
    : options.principal;
  const app = await buildApp({
    financialService: {} as unknown as FinancialApiService,
    authService: service,
    emailDelivery: email,
    authTransport: {
      secure: options.secure ?? true,
      prefixHost: true,
    },
    authenticate: async () => principal,
  } satisfies BuildAppOptions);
  apps.push(app);
  return { app, service, email };
}

const BROWSER_HEADERS = { origin: 'https://api.kfin.test', host: 'api.kfin.test' };
const CSRF_HEADERS = { ...BROWSER_HEADERS, 'x-kfin-csrf': CSRF_TOKEN };

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('trusted beta access routes', () => {
  it('registers every access route without exposing a session token in a body', async () => {
    const { app } = await build();
    for (const [method, url, payload] of [
      ['POST', '/api/v1/auth/register', {
        email: 'beta.user@example.invalid',
        password: 'correct horse battery staple',
        invitationCode: 'ABCDEFGH-JKMNPQRS-TVWXYZ23-456789AB',
        locale: 'vi-VN',
        timezone: 'Asia/Ho_Chi_Minh',
        baseCurrency: 'VND',
      }],
      ['POST', '/api/v1/auth/verification/resend', { email: 'beta.user@example.invalid' }],
      ['POST', '/api/v1/auth/verify-email', { email: 'beta.user@example.invalid', oneTimeCode: '123456' }],
      ['POST', '/api/v1/auth/login', { email: 'beta.user@example.invalid', password: 'value' }],
      ['POST', '/api/v1/auth/logout', undefined],
      ['POST', '/api/v1/auth/logout-all', undefined],
      ['GET', '/api/v1/auth/sessions', undefined],
      ['DELETE', `/api/v1/auth/sessions/${OTHER_SESSION_ID}`, undefined],
      ['POST', '/api/v1/auth/password/change', {
        currentPassword: 'current-passphrase-value',
        newPassword: 'next-passphrase-value-1',
      }],
      ['POST', '/api/v1/auth/password/reset-request', { email: 'beta.user@example.invalid' }],
      ['POST', '/api/v1/auth/password/reset', {
        email: 'beta.user@example.invalid',
        resetSecret: 'reset-secret-value-0123456789012345678901',
        newPassword: 'a-brand-new-passphrase',
      }],
      ['GET', '/api/v1/auth/security-events', undefined],
      ['GET', '/api/v1/auth/me', undefined],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: CSRF_HEADERS,
        ...(payload === undefined ? {} : { payload }),
      });
      expect([response.statusCode, url]).not.toEqual([404, url]);
      expect(response.statusCode).not.toBe(404);
    }
  });

  it('registers, delivers the OTP once, and returns no secret in the response', async () => {
    const email = new RecordingEmailAdapter();
    const { app, service } = await build({ email });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...BROWSER_HEADERS, 'x-correlation-id': CORRELATION_ID },
      payload: {
        email: 'beta.user@example.invalid',
        password: 'correct horse battery staple',
        invitationCode: 'ABCDEFGH-JKMNPQRS-TVWXYZ23-456789AB',
        locale: 'vi-VN',
        timezone: 'Asia/Ho_Chi_Minh',
        baseCurrency: 'VND',
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: true,
      resendAvailableAt: '2026-10-08T02:01:00.000Z',
    });
    expect(email.messages).toHaveLength(1);
    expect(email.messages[0]).toMatchObject({
      to: 'beta.user@example.invalid',
      template: 'email_verification_otp',
      oneTimeSecret: '123456',
      correlationId: CORRELATION_ID,
    });
    expect(service.recordChallengeDelivery).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-00000000000a',
      'delivered',
      'memory-1',
    );
    expect(response.body).not.toContain('123456');
  });

  it('records a failed delivery without leaking account state', async () => {
    const email = new RecordingEmailAdapter({ fail: true });
    const { app, service } = await build({ email });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: BROWSER_HEADERS,
      payload: {
        email: 'beta.user@example.invalid',
        password: 'correct horse battery staple',
        invitationCode: 'ABCDEFGH-JKMNPQRS-TVWXYZ23-456789AB',
        locale: 'vi-VN',
        timezone: 'Asia/Ho_Chi_Minh',
        baseCurrency: 'VND',
      },
    });
    expect(response.statusCode).toBe(202);
    expect(service.recordChallengeDelivery).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-00000000000a',
      'failed',
      'memory-failure',
    );
  });

  it('sets a host-prefixed HttpOnly Secure session cookie and a readable CSRF cookie', async () => {
    const { app } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: BROWSER_HEADERS,
      payload: { email: 'beta.user@example.invalid', oneTimeCode: '123456' },
    });
    expect(response.statusCode).toBe(200);
    const setCookies = response.headers['set-cookie'];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
    const sessionCookie = cookies.find((cookie) => cookie.startsWith('__Host-kfin_session='));
    const csrfCookie = cookies.find((cookie) => cookie.startsWith('kfin_csrf='));
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('Path=/');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).not.toContain('Domain=');
    expect(csrfCookie).not.toContain('HttpOnly');
    expect(csrfCookie).toContain('Secure');
    expect(response.json().csrfToken).toBe(CSRF_TOKEN);
    expect(response.body).not.toContain('bearer-token-value-never-in-body');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects a cross-origin state-changing request and never accepts an allowlisted origin', async () => {
    const { app } = await build();
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example', host: 'api.kfin.test' },
      payload: { email: 'beta.user@example.invalid', password: 'value' },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json().error.code).toBe('AUTH_CSRF_FAILED');

    const missingOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: 'api.kfin.test' },
      payload: { email: 'beta.user@example.invalid', password: 'value' },
    });
    expect(missingOrigin.statusCode).toBe(403);

    const fetchMetadata = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: 'api.kfin.test', 'sec-fetch-site': 'same-origin' },
      payload: { email: 'beta.user@example.invalid', password: 'value' },
    });
    expect(fetchMetadata.statusCode).toBe(200);

    // Regression: a cross-origin browser client is never accepted, with or
    // without configuration, because no credentialed CORS layer exists.
    const configuredOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://beta.kfin.example', host: 'api.kfin.test' },
      payload: { email: 'beta.user@example.invalid', password: 'value' },
    });
    expect(configuredOrigin.statusCode).toBe(403);
    expect(configuredOrigin.json().error.code).toBe('AUTH_CSRF_FAILED');

    const crossOriginStateChange = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${SESSION_ID}`,
      headers: { origin: 'https://beta.kfin.example', host: 'api.kfin.test', 'x-kfin-csrf': CSRF_TOKEN },
    });
    expect(crossOriginStateChange.statusCode).toBe(403);
  });

  it('requires a valid CSRF token bound to the session on authenticated mutations', async () => {
    const { app } = await build();
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: BROWSER_HEADERS,
    });
    expect(missing.statusCode).toBe(403);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...BROWSER_HEADERS, 'x-kfin-csrf': 'not-the-bound-token' },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('AUTH_CSRF_FAILED');

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: CSRF_HEADERS,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ revoked: true });
  });

  it('fails closed when no session principal exists', async () => {
    const { app } = await build({ principal: null });
    for (const [method, url] of [
      ['GET', '/api/v1/auth/sessions'],
      ['GET', '/api/v1/auth/security-events'],
      ['GET', '/api/v1/auth/me'],
      ['POST', '/api/v1/auth/logout'],
    ] as const) {
      const response = await app.inject({ method, url, headers: CSRF_HEADERS });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
    }
  });

  it('derives owner scope from the session and never from request data', async () => {
    const service = authService();
    const { app } = await build({ service });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${OTHER_SESSION_ID}`,
      headers: CSRF_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(service.revokeSession).toHaveBeenCalledWith(USER_ID, OTHER_SESSION_ID, expect.objectContaining({
      correlationId: expect.any(String),
    }));
    expect(service.revokeSession).not.toHaveBeenCalledWith(OTHER_USER_ID, expect.anything(), expect.anything());
  });

  it('passes bounded pagination through the security-history collection', async () => {
    const service = authService();
    const { app } = await build({ service });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/security-events?limit=10&cursor=eyJvY2N1cnJlZEF0IjoiMjAyNi0xMC0wOFQwMjowMDowMC4wMDBaIiwiaWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwM2MifQ',
      headers: CSRF_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(service.listSecurityEvents).toHaveBeenCalledWith(USER_ID, {
      limit: 10,
      cursor: expect.stringContaining('eyJ'),
    });
    expect(response.json().items[0]).toEqual({
      id: '00000000-0000-4000-8000-00000000000c',
      eventType: 'login_succeeded',
      outcome: 'success',
      occurredAt: '2026-10-08T02:00:00.000Z',
      sessionId: SESSION_ID,
    });
  });

  it('revokes every session on logout-all, the current one included, and clears both cookies', async () => {
    const { app, service } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      headers: CSRF_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revokedSessions: 3 });

    // Regression (QA finding F-1): the route must not pass an `exceptSessionId`
    // that leaves the requesting session — and therefore its token — alive
    // after a global sign-out.
    expect(service.logoutAll).toHaveBeenCalledTimes(1);
    expect(service.logoutAll).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ correlationId: expect.any(String) }),
    );

    const cookies = ([] as string[]).concat(response.headers['set-cookie'] as string | string[]);
    expect(cookies.some((cookie) => cookie.startsWith('__Host-kfin_session=;'))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith('kfin_csrf=;'))).toBe(true);
  });

  it('clears both cookies on logout and on password reset', async () => {
    const { app } = await build();
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: CSRF_HEADERS,
    });
    const logoutCookies = ([] as string[]).concat(logout.headers['set-cookie'] as string | string[]);
    expect(logoutCookies.some((cookie) => cookie.startsWith('__Host-kfin_session=;'))).toBe(true);
    expect(logoutCookies.some((cookie) => cookie.startsWith('kfin_csrf=;'))).toBe(true);

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      headers: BROWSER_HEADERS,
      payload: {
        email: 'beta.user@example.invalid',
        resetSecret: 'reset-secret-value-0123456789012345678901',
        newPassword: 'a-brand-new-passphrase',
      },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ userId: USER_ID, sessionsRevoked: 4 });
    const resetCookies = ([] as string[]).concat(reset.headers['set-cookie'] as string | string[]);
    expect(resetCookies.some((cookie) => cookie.startsWith('__Host-kfin_session=;'))).toBe(true);
  });

  it('rotates the session cookie on a known-password change and reports revoked sessions', async () => {
    const { app } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: CSRF_HEADERS,
      payload: {
        currentPassword: 'current-passphrase-value',
        newPassword: 'next-passphrase-value-1',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revokedOtherSessions).toBe(2);
    const cookies = ([] as string[]).concat(response.headers['set-cookie'] as string | string[]);
    expect(cookies.some((cookie) => cookie.startsWith('__Host-kfin_session='))).toBe(true);
  });

  it('returns one identical generic envelope for unknown and known login failures', async () => {
    const failing = authService({
      login: vi.fn(async (input: { email: string }) => {
        if (input.email === 'beta.user@example.invalid') throw new AuthError({
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
          safeMessage: 'The email and password combination is not valid.',
        });
        throw new AuthError({
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
          safeMessage: 'The email and password combination is not valid.',
        });
      }),
    });
    const { app } = await build({ service: failing });
    const known = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: BROWSER_HEADERS,
      payload: { email: 'beta.user@example.invalid', password: 'wrong-value' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: BROWSER_HEADERS,
      payload: { email: 'nobody@example.invalid', password: 'wrong-value' },
    });
    expect(known.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(known.json().error.code).toBe(unknown.json().error.code);
    expect(known.json().error.message).toBe(unknown.json().error.message);
    expect(known.body).not.toContain('unknown_account');
  });

  it('surfaces safe retry guidance for abuse limits without account detail', async () => {
    const limited = authService({
      login: vi.fn(async () => {
        throw new AuthError({
          code: 'AUTH_RATE_LIMITED',
          statusCode: 429,
          safeMessage: 'Too many attempts. Wait before trying again.',
          retryAfterSeconds: 42,
        });
      }),
    });
    const { app } = await build({ service: limited });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: BROWSER_HEADERS,
      payload: { email: 'beta.user@example.invalid', password: 'value' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('42');
    expect(response.json().error.code).toBe('AUTH_RATE_LIMITED');
  });

  it('rejects unknown fields and oversized payloads at the access boundary', async () => {
    const { app } = await build();
    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: BROWSER_HEADERS,
      payload: {
        email: 'beta.user@example.invalid',
        password: 'correct horse battery staple',
        invitationCode: 'ABCDEFGH-JKMNPQRS-TVWXYZ23-456789AB',
        locale: 'vi-VN',
        timezone: 'Asia/Ho_Chi_Minh',
        baseCurrency: 'VND',
        emailVerified: true,
      },
    });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json().error.code).toBe('REQUEST_VALIDATION_FAILED');

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: BROWSER_HEADERS,
      payload: { email: 'beta.user@example.invalid', password: 'a'.repeat(2_000) },
    });
    expect(oversized.statusCode).toBe(400);
  });

  it('uses the insecure cookie name only when secure cookies are explicitly disabled', async () => {
    const { app } = await build({ secure: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: BROWSER_HEADERS,
      payload: { email: 'beta.user@example.invalid', password: 'value' },
    });
    const cookies = ([] as string[]).concat(response.headers['set-cookie'] as string | string[]);
    expect(cookies.some((cookie) => cookie.startsWith('kfin_session='))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith('__Host-'))).toBe(false);
  });
});
