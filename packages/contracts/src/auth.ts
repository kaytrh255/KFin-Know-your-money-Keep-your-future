import { z } from 'zod';
import { errorResponseSchema, instantSchema, uuidSchema } from './common.js';

/**
 * Trusted Private Beta access contracts.
 *
 * Every schema is strict: unknown fields, state aliases, and client-supplied
 * authority are rejected rather than ignored (SEC-APP-01, SEC-APP-07). No schema
 * accepts or returns a session token, OTP, reset secret, or CSRF token in a JSON
 * body — those travel only in cookies or dedicated headers.
 */

// Crockford base32 groups, no ambiguous I/L/O/U characters.
const INVITATION_CODE_SEGMENT = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export const emailSchema = z.string().trim().min(3).max(320).email();
export const passwordSchema = z.string().min(1).max(200);
export const otpSchema = z.string().regex(/^[0-9]{6}$/);
export const resetSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
export const invitationCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toUpperCase().replace(/\s+/g, ''))
  .refine(
    (value) => value.split('-').length === 4 && value.split('-').every((part) => INVITATION_CODE_SEGMENT.test(part)),
    { message: 'must be the invitation code issued for this Private Beta account' },
  );

export const localeSchema = z.string().trim().min(2).max(35);
export const timezoneSchema = z.string().trim().min(1).max(100);
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);

export const authSessionSchema = z.strictObject({
  id: uuidSchema,
  clientType: z.enum(['web', 'pwa', 'native']),
  createdAt: instantSchema,
  lastSeenAt: instantSchema,
  idleExpiresAt: instantSchema,
  absoluteExpiresAt: instantSchema,
  deviceLabel: z.string().nullable(),
  current: z.boolean(),
});

export const registerBodySchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  invitationCode: invitationCodeSchema,
  displayName: z.string().trim().min(1).max(120).optional(),
  locale: localeSchema,
  timezone: timezoneSchema,
  baseCurrency: currencySchema,
});

// Registration is intentionally generic: a new account and an existing email
// return the same accepted outcome so the endpoint is not an enumeration oracle
// (UF-AUTH-01, SEC-AUTH-04).
export const registerResponseSchema = z.strictObject({
  accepted: z.literal(true),
  resendAvailableAt: instantSchema,
});

export const resendVerificationBodySchema = z.strictObject({
  email: emailSchema,
});

export const resendVerificationResponseSchema = z.strictObject({
  accepted: z.literal(true),
  resendAvailableAt: instantSchema,
});

export const verifyEmailBodySchema = z.strictObject({
  email: emailSchema,
  oneTimeCode: otpSchema,
});

export const verifyEmailResponseSchema = z.strictObject({
  userId: uuidSchema,
  status: z.literal('active'),
  session: authSessionSchema,
  csrfToken: z.string().min(16).max(256),
});

export const loginBodySchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
});

export const loginResponseSchema = z.strictObject({
  userId: uuidSchema,
  session: authSessionSchema,
  csrfToken: z.string().min(16).max(256),
});

export const logoutResponseSchema = z.strictObject({
  revoked: z.literal(true),
});

export const logoutAllResponseSchema = z.strictObject({
  revokedSessions: z.number().int().min(0).max(1_000),
});

export const sessionListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const sessionListResponseSchema = z.strictObject({
  items: z.array(authSessionSchema),
  nextCursor: z.string().nullable(),
});

export const sessionPathSchema = z.strictObject({ id: uuidSchema });

export const revokeSessionResponseSchema = z.strictObject({
  revoked: z.literal(true),
});

export const changePasswordBodySchema = z.strictObject({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

export const changePasswordResponseSchema = z.strictObject({
  session: authSessionSchema,
  csrfToken: z.string().min(16).max(256),
  revokedOtherSessions: z.number().int().min(0).max(1_000),
});

export const passwordResetRequestBodySchema = z.strictObject({
  email: emailSchema,
});

export const passwordResetRequestResponseSchema = z.strictObject({
  accepted: z.literal(true),
});

export const passwordResetBodySchema = z.strictObject({
  email: emailSchema,
  resetSecret: resetSecretSchema,
  newPassword: passwordSchema,
});

export const passwordResetResponseSchema = z.strictObject({
  userId: uuidSchema,
  sessionsRevoked: z.number().int().min(0).max(1_000),
});

export const securityEventTypeSchema = z.enum([
  'registration_requested',
  'verification_challenge_issued',
  'verification_challenge_failed',
  'email_verified',
  'login_succeeded',
  'login_failed',
  'logout',
  'logout_all',
  'session_revoked',
  'password_changed',
  'password_reset_requested',
  'password_reset_completed',
  'password_reset_failed',
  'session_token_rotated',
  'session_token_replay_detected',
  'session_expired',
  'access_denied_unverified',
]);

export const securityEventSchema = z.strictObject({
  id: uuidSchema,
  eventType: securityEventTypeSchema,
  outcome: z.enum(['success', 'failure', 'blocked']),
  occurredAt: instantSchema,
  sessionId: uuidSchema.nullable(),
});

export const securityEventListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const securityEventListResponseSchema = z.strictObject({
  items: z.array(securityEventSchema),
  nextCursor: z.string().nullable(),
});

export const meResponseSchema = z.strictObject({
  userId: uuidSchema,
  email: z.string().min(3).max(320),
  status: z.enum(['pending_verification', 'active', 'locked', 'disabled', 'deletion_pending']),
  emailVerifiedAt: instantSchema.nullable(),
  displayName: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
  baseCurrency: currencySchema,
  session: authSessionSchema,
});

// Browser requests carry transport headers beyond these two fields, so the
// header schemas stay open like the idempotency contract.
export const csrfHeadersSchema = z.object({
  'x-kfin-csrf': z.string().min(16).max(256),
});

export function authResponses(
  successStatus: 200 | 201 | 202,
  successSchema: unknown,
  extra: Readonly<Record<number, unknown>> = {},
): Record<number, unknown> {
  return {
    [successStatus]: successSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    503: errorResponseSchema,
    ...extra,
  };
}

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type VerifyEmailBody = z.infer<typeof verifyEmailBodySchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
export type PasswordResetBody = z.infer<typeof passwordResetBodySchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
