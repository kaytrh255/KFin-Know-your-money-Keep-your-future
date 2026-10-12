import type {
  FastifyBaseLogger,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  authResponses,
  changePasswordBodySchema,
  changePasswordResponseSchema,
  loginBodySchema,
  loginResponseSchema,
  logoutAllResponseSchema,
  logoutResponseSchema,
  meResponseSchema,
  passwordResetBodySchema,
  passwordResetRequestBodySchema,
  passwordResetRequestResponseSchema,
  passwordResetResponseSchema,
  registerBodySchema,
  registerResponseSchema,
  revokeSessionResponseSchema,
  securityEventListQuerySchema,
  securityEventListResponseSchema,
  sessionListQuerySchema,
  sessionListResponseSchema,
  sessionPathSchema,
} from '@kfin/contracts';
import type {
  AccessPrincipal,
  AuthSessionView,
  ChangePasswordResult,
  LoginResult,
  ProfileView,
  RegisterResult,
  RequestPasswordResetResult,
  ResetPasswordResult,
  SecurityEventPage,
  SessionPage,
} from '@kfin/database';
import { AuthError, csrfFailedError } from '@kfin/domain';
import type { AuthenticateRequest } from './types.js';
import type { EmailDeliveryAdapter } from './email-delivery.js';
import {
  CSRF_HEADER_NAME,
  clearedCsrfCookie,
  clearedSessionCookie,
  isBrowserSafeRequest,
  serializeCsrfCookie,
  serializeSessionCookie,
  type SessionTransportOptions,
} from './session-transport.js';

/**
 * Trusted Private Beta access routes.
 *
 * Trace: PRD-AUTH-01..08, SEC-AUTH-01..16, SEC-SES-01..10, SEC-APP-01/07/09/10,
 * ADR-002, ADR-004, ADR-008.
 *
 * Ownership always comes from the authenticated session; no route accepts a user
 * identifier in a body, path, or query (SEC-APP-15 ownership rule applied to the
 * access boundary). Unauthenticated outcomes are generic.
 */

export interface AuthApiService {
  register(input: {
    email: string;
    password: string;
    invitationCode: string;
    displayName?: string;
    locale: string;
    timezone: string;
    baseCurrency: string;
    correlationId: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<RegisterResult>;
  login(input: {
    email: string;
    password: string;
    correlationId: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<LoginResult>;
  logout(sessionId: string, input: { correlationId: string; ipAddress: string | null; userAgent: string | null }): Promise<boolean>;
  /** Revokes every session of the user, including the requesting one. */
  logoutAll(
    userId: string,
    input: { correlationId: string; ipAddress: string | null; userAgent: string | null },
  ): Promise<number>;
  listSessions(
    userId: string,
    options: { limit: number; cursor?: string; currentSessionId: string },
  ): Promise<SessionPage>;
  revokeSession(
    userId: string,
    sessionId: string,
    input: { correlationId: string; ipAddress: string | null; userAgent: string | null },
  ): Promise<boolean>;
  changePassword(input: {
    userId: string;
    sessionId: string;
    currentPassword: string;
    newPassword: string;
    correlationId: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<ChangePasswordResult>;
  requestPasswordReset(input: {
    email: string;
    correlationId: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<RequestPasswordResetResult>;
  resetPassword(input: {
    email: string;
    oneTimeCode: string;
    newPassword: string;
    correlationId: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<ResetPasswordResult>;
  listSecurityEvents(userId: string, options: { limit: number; cursor?: string }): Promise<SecurityEventPage>;
  getProfile(userId: string): Promise<ProfileView | null>;
  verifyCsrfToken(presented: string | null | undefined, expectedDigest: string): boolean;
  recordChallengeDelivery(
    challengeId: string,
    status: 'delivered' | 'failed',
    reference?: string,
  ): Promise<void>;
}

/** Fastify instance already bound to the Zod type provider in `buildApp`. */
export type ZodFastifyInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface RegisterAuthRoutesOptions {
  readonly app: ZodFastifyInstance;
  readonly authenticate: AuthenticateRequest;
  readonly authService: AuthApiService;
  readonly emailDelivery: EmailDeliveryAdapter;
  readonly transport: SessionTransportOptions;
  readonly absoluteLifetimeSeconds: number;
}

/**
 * Milestone 10 (E-5) — the methods that carry no state change: RFC 9110 §9.2.1,
 * and exactly the set `isBrowserSafeRequest` short-circuits on. A read stays
 * session-only; the browser state-change defense applies to every other method.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function registerAuthRoutes(options: RegisterAuthRoutesOptions): Promise<void> {
  const { app, authService, emailDelivery, transport, absoluteLifetimeSeconds, authenticate } = options;

  const requireAccess = async (request: FastifyRequest): Promise<AccessPrincipal> => {
    const resolved = await authenticate(request);
    const principal = resolved as (AccessPrincipal & { userId: string }) | null;
    if (resolved) request.principal = resolved;
    if (!principal?.userId) {
      throw new AuthError({
        code: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
        safeMessage: 'Authentication is required.',
      });
    }
    if (SAFE_METHODS.has(request.method.toUpperCase())) return principal;
    if (!isBrowserSafeRequest(request)) throw csrfFailedError();
    if (typeof principal.csrfDigest !== 'string') throw csrfFailedError();
    if (!authService.verifyCsrfToken(csrfHeaderOf(request), principal.csrfDigest)) {
      throw csrfFailedError();
    }
    return principal;
  };

  /**
   * Milestone 10 (E-5): the same-origin / Fetch Metadata half of the Milestone 04
   * defense, for the pre-session write routes. No session exists yet, so the
   * session-bound double-submit token cannot apply. It runs at `onRequest` —
   * before content-type parsing and body validation — like every other mutation
   * in the API, so a cross-site request is rejected `403` without its body ever
   * being parsed or validated.
   */
  const requireBrowserSafeWrite = async (request: FastifyRequest): Promise<void> => {
    if (!isBrowserSafeRequest(request)) throw csrfFailedError();
  };

  /**
   * Milestone 10 (E-5): the session-bound write routes now resolve the principal
   * in their `onRequest` guard, so the handler only narrows what that guard
   * already stored. It cannot return `null`: the guard throws first.
   */
  const requirePrincipal = (request: FastifyRequest): AccessPrincipal & { userId: string } => {
    const principal = request.principal as (AccessPrincipal & { userId: string }) | null;
    if (!principal?.userId) {
      throw new AuthError({
        code: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
        safeMessage: 'Authentication is required.',
      });
    }
    return principal;
  };

  const requestContext = (request: FastifyRequest) => ({
    correlationId: request.id,
    ipAddress: request.ip ?? null,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  const issueSessionCookies = (
    reply: FastifyReply,
    session: { session: AuthSessionView; sessionToken: string; csrfToken: string },
  ): void => {
    reply.header('Set-Cookie', [
      serializeSessionCookie(session.sessionToken, transport, absoluteLifetimeSeconds),
      serializeCsrfCookie(session.csrfToken, transport, absoluteLifetimeSeconds),
    ]);
  };

  const clearSessionCookies = (reply: FastifyReply): void => {
    reply.header('Set-Cookie', [
      clearedSessionCookie(transport),
      clearedCsrfCookie(transport),
    ]);
  };

  const deliver = async (
    request: FastifyRequest,
    input: { to: string; template: 'password_reset'; challengeId: string; secret: string },
  ): Promise<void> => {
    try {
      const result = await emailDelivery.send({
        to: input.to,
        template: input.template,
        correlationId: request.id,
        oneTimeSecret: input.secret,
      });
      await authService.recordChallengeDelivery(
        input.challengeId,
        result.status,
        result.reference,
      );
      if (result.status === 'failed') {
        request.log.warn(
          { template: input.template, correlationId: request.id },
          'Security email delivery failed; the user must request a new code',
        );
      }
    } catch (error) {
      // A provider failure never reveals account state: the challenge remains and
      // a controlled resend can supersede it (ADR-002).
      request.log.error(
        { errorName: error instanceof Error ? error.name : 'UnknownError', correlationId: request.id },
        'Security email delivery adapter error',
      );
    }
  };

  app.post('/api/v1/auth/register', {
    onRequest: requireBrowserSafeWrite,
    schema: {
      tags: ['trusted-beta-access'],
      body: registerBodySchema,
      response: authResponses(202, registerResponseSchema),
    },
  }, async (request, reply) => {
    const body = request.body;
    // OQ-20 (2026-10-12): registration admits the account and nothing else. It issues
    // no challenge and sends no email, so the route has no delivery to make and no
    // resend window to publish — the 202 body is identical for a fresh address, an
    // address that already exists, and a rejected invitation (SEC-AUTH-04).
    await authService.register({
      email: body.email,
      password: body.password,
      invitationCode: body.invitationCode,
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      locale: body.locale,
      timezone: body.timezone,
      baseCurrency: body.baseCurrency,
      ...requestContext(request),
    });
    return reply.code(202).send({ accepted: true });
  });

  app.post('/api/v1/auth/login', {
    onRequest: requireBrowserSafeWrite,
    schema: {
      tags: ['trusted-beta-access'],
      body: loginBodySchema,
      response: authResponses(200, loginResponseSchema),
    },
  }, async (request, reply) => {
    const body = request.body;
    const result = await authService.login({
      email: body.email,
      password: body.password,
      ...requestContext(request),
    });
    issueSessionCookies(reply, result.session);
    return {
      userId: result.userId,
      session: result.session.session,
      csrfToken: result.session.csrfToken,
    };
  });

  app.post('/api/v1/auth/logout', {
    onRequest: requireAccess,
    schema: {
      tags: ['trusted-beta-access'],
      response: authResponses(200, logoutResponseSchema),
    },
  }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const revoked = await authService.logout(principal.sessionId, requestContext(request));
    clearSessionCookies(reply);
    return { revoked: revoked as true };
  });

  app.post('/api/v1/auth/logout-all', {
    onRequest: requireAccess,
    schema: {
      tags: ['trusted-beta-access'],
      response: authResponses(200, logoutAllResponseSchema),
    },
  }, async (request, reply) => {
    const principal = requirePrincipal(request);
    // Every session is revoked, the requesting one included; the cookies are
    // cleared so the browser cannot keep presenting a dead token.
    const revokedSessions = await authService.logoutAll(
      principal.userId,
      requestContext(request),
    );
    clearSessionCookies(reply);
    return { revokedSessions };
  });

  app.get('/api/v1/auth/sessions', {
    schema: {
      tags: ['trusted-beta-access'],
      querystring: sessionListQuerySchema,
      response: authResponses(200, sessionListResponseSchema),
    },
  }, async (request) => {
    const principal = await requireAccess(request);
    return authService.listSessions(principal.userId, {
      limit: request.query.limit,
      ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      currentSessionId: principal.sessionId,
    });
  });

  app.delete('/api/v1/auth/sessions/:id', {
    onRequest: requireAccess,
    schema: {
      tags: ['trusted-beta-access'],
      params: sessionPathSchema,
      response: authResponses(200, revokeSessionResponseSchema),
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    const revoked = await authService.revokeSession(
      principal.userId,
      request.params.id,
      requestContext(request),
    );
    if (!revoked) {
      throw new AuthError({
        code: 'AUTH_SESSION_REVOKED',
        statusCode: 404,
        safeMessage: 'The session is unavailable.',
      });
    }
    return { revoked: true };
  });

  app.post('/api/v1/auth/password/change', {
    onRequest: requireAccess,
    schema: {
      tags: ['trusted-beta-access'],
      body: changePasswordBodySchema,
      response: authResponses(200, changePasswordResponseSchema),
    },
  }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = request.body;
    const result = await authService.changePassword({
      userId: principal.userId,
      sessionId: principal.sessionId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      ...requestContext(request),
    });
    // Rotation issues a new token and CSRF value; the old token keeps a bounded
    // grace window for concurrent tabs (SEC-SES-05).
    issueSessionCookies(reply, result.session);
    return {
      session: result.session.session,
      csrfToken: result.session.csrfToken,
      revokedOtherSessions: result.revokedOtherSessions,
    };
  });

  app.post('/api/v1/auth/password/reset-request', {
    onRequest: requireBrowserSafeWrite,
    schema: {
      tags: ['trusted-beta-access'],
      body: passwordResetRequestBodySchema,
      response: authResponses(200, passwordResetRequestResponseSchema),
    },
  }, async (request) => {
    const body = request.body;
    const result = await authService.requestPasswordReset({
      email: body.email,
      ...requestContext(request),
    });
    if (result.delivery) {
      await deliver(request, {
        to: body.email,
        template: 'password_reset',
        challengeId: result.delivery.challengeId,
        secret: result.delivery.oneTimeCode,
      });
    }
    return { accepted: true };
  });

  app.post('/api/v1/auth/password/reset', {
    onRequest: requireBrowserSafeWrite,
    schema: {
      tags: ['trusted-beta-access'],
      body: passwordResetBodySchema,
      response: authResponses(200, passwordResetResponseSchema),
    },
  }, async (request, reply) => {
    const body = request.body;
    const result = await authService.resetPassword({
      email: body.email,
      oneTimeCode: body.oneTimeCode,
      newPassword: body.newPassword,
      ...requestContext(request),
    });
    // Every session was revoked; no new session is issued until sign-in.
    clearSessionCookies(reply);
    return { userId: result.userId, sessionsRevoked: result.sessionsRevoked };
  });

  app.get('/api/v1/auth/security-events', {
    schema: {
      tags: ['trusted-beta-access'],
      querystring: securityEventListQuerySchema,
      response: authResponses(200, securityEventListResponseSchema),
    },
  }, async (request) => {
    const principal = await requireAccess(request);
    return authService.listSecurityEvents(principal.userId, {
      limit: request.query.limit,
      ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
    });
  });

  app.get('/api/v1/auth/me', {
    schema: {
      tags: ['trusted-beta-access'],
      response: authResponses(200, meResponseSchema),
    },
  }, async (request) => {
    const principal = await requireAccess(request);
    const profile = await authService.getProfile(principal.userId);
    if (!profile) {
      throw new AuthError({
        code: 'AUTH_ACCOUNT_UNAVAILABLE',
        statusCode: 403,
        safeMessage: 'This account cannot be used right now.',
      });
    }
    const sessions = await authService.listSessions(principal.userId, {
      limit: 50,
      currentSessionId: principal.sessionId,
    });
    const current = sessions.items.find((session) => session.id === principal.sessionId);
    return {
      userId: profile.userId,
      email: profile.email,
      status: profile.status,
      emailVerifiedAt: profile.emailVerifiedAt,
      displayName: profile.displayName,
      locale: profile.locale,
      timezone: profile.timezone,
      baseCurrency: profile.baseCurrency,
      session: current ?? {
        id: principal.sessionId,
        clientType: 'web' as const,
        createdAt: new Date(0).toISOString(),
        lastSeenAt: new Date(0).toISOString(),
        idleExpiresAt: new Date(0).toISOString(),
        absoluteExpiresAt: new Date(0).toISOString(),
        deviceLabel: null,
        current: true,
      },
    };
  });
}

function csrfHeaderOf(request: FastifyRequest): string | null {
  const value = request.headers[CSRF_HEADER_NAME];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}
