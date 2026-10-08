import { KfinServiceError } from './errors.js';

/**
 * Trusted Private Beta access error codes.
 *
 * Every message stays generic: an invitation, credential, challenge, or account
 * state must not be distinguishable by an unauthenticated caller
 * (PRD-AUTH-03, SEC-AUTH-04, SEC-AUTH-14/15, SEC-ABUSE-09).
 */
export type AuthErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTH_VALIDATION_FAILED'
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_INVITATION_INVALID'
  | 'AUTH_REGISTRATION_UNAVAILABLE'
  | 'AUTH_CHALLENGE_INVALID'
  | 'AUTH_CHALLENGE_EXPIRED'
  | 'AUTH_CHALLENGE_ATTEMPTS_EXHAUSTED'
  | 'AUTH_CHALLENGE_NOT_DELIVERED'
  | 'AUTH_ACCOUNT_UNAVAILABLE'
  | 'AUTH_SESSION_EXPIRED'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_PASSWORD_POLICY_FAILED'
  | 'AUTH_PASSWORD_REUSED'
  | 'AUTH_RATE_LIMITED'
  | 'AUTH_CSRF_FAILED'
  | 'AUTH_SERVICE_UNAVAILABLE';

export interface AuthErrorOptions {
  readonly code: AuthErrorCode;
  readonly statusCode: number;
  readonly safeMessage: string;
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

export class AuthError extends KfinServiceError {
  readonly code: AuthErrorCode;
  readonly statusCode: number;
  readonly safeMessage: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(options: AuthErrorOptions) {
    super(options.safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AuthError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.safeMessage = options.safeMessage;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function authValidationError(
  message = 'The request does not satisfy the access contract.',
): AuthError {
  return new AuthError({
    code: 'AUTH_VALIDATION_FAILED',
    statusCode: 400,
    safeMessage: message,
  });
}

/** Generic credential/account/challenge failure; never distinguishes a cause. */
export function invalidCredentialsError(): AuthError {
  return new AuthError({
    code: 'AUTH_INVALID_CREDENTIALS',
    statusCode: 401,
    safeMessage: 'The email and password combination is not valid.',
  });
}

export function invalidInvitationError(): AuthError {
  return new AuthError({
    code: 'AUTH_INVITATION_INVALID',
    statusCode: 400,
    safeMessage: 'The invitation code cannot be used for registration.',
  });
}

export function registrationUnavailableError(cause?: unknown): AuthError {
  return new AuthError({
    code: 'AUTH_REGISTRATION_UNAVAILABLE',
    statusCode: 409,
    safeMessage: 'The registration could not be completed with those details.',
    cause,
  });
}

export function invalidChallengeError(): AuthError {
  return new AuthError({
    code: 'AUTH_CHALLENGE_INVALID',
    statusCode: 400,
    safeMessage: 'The verification code cannot be used.',
  });
}

export function expiredChallengeError(): AuthError {
  return new AuthError({
    code: 'AUTH_CHALLENGE_EXPIRED',
    statusCode: 400,
    safeMessage: 'The verification code has expired. Request a new one.',
  });
}

export function challengeAttemptsExhaustedError(): AuthError {
  return new AuthError({
    code: 'AUTH_CHALLENGE_ATTEMPTS_EXHAUSTED',
    statusCode: 400,
    safeMessage: 'The verification code has too many failed attempts. Request a new one.',
  });
}

export function accountUnavailableError(): AuthError {
  return new AuthError({
    code: 'AUTH_ACCOUNT_UNAVAILABLE',
    statusCode: 403,
    safeMessage: 'This account cannot be used right now.',
  });
}

export function rateLimitedError(retryAfterSeconds: number): AuthError {
  return new AuthError({
    code: 'AUTH_RATE_LIMITED',
    statusCode: 429,
    safeMessage: 'Too many attempts. Wait before trying again.',
    retryAfterSeconds,
  });
}

export function csrfFailedError(): AuthError {
  return new AuthError({
    code: 'AUTH_CSRF_FAILED',
    statusCode: 403,
    safeMessage: 'The request origin or CSRF token was rejected.',
  });
}

export function authServiceUnavailableError(cause?: unknown): AuthError {
  return new AuthError({
    code: 'AUTH_SERVICE_UNAVAILABLE',
    statusCode: 503,
    safeMessage: 'Access is temporarily unavailable. Retry safely.',
    retryAfterSeconds: 1,
    cause,
  });
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
