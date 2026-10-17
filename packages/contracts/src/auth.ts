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
export const invitationCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toUpperCase().replace(/\s+/g, ''))
  .refine(
    (value) => value.split('-').length === 4 && value.split('-').every((part) => INVITATION_CODE_SEGMENT.test(part)),
    { message: 'must be the invitation code issued for this Private Beta account' },
  )
  // The rule above is a `.refine`, which OpenAPI cannot express as a `pattern`,
  // so without this description the published contract claimed only "1 to 64
  // characters" while the runtime required four groups of eight Crockford
  // characters. A caller reading the contract was told it sent the wrong thing
  // by a contract that never stated the rule (found by a live register attempt,
  // 2026-10-12). Descriptions survive schema transformation, so the requirement
  // is now published next to the field that enforces it.
  .describe(
    'Invitation code exactly as issued: four groups of eight characters separated by hyphens, '
    + 'for example XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX. Crockford base32 alphabet (digits and '
    + 'A-Z excluding I, L, O and U); case and surrounding whitespace are ignored.',
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
  // The transport bound and the enforced policy are different numbers, and only
  // the transport bound was published, so a caller reading the contract could be
  // refused by a rule the contract never stated (2026-10-12). The service policy
  // is described next to the field that is subject to it; other endpoints reuse
  // `passwordSchema` and are not, so the note stays on the register body only.
  password: passwordSchema.describe(
    'Transport bound only (1–200 characters). Registration additionally enforces the service '
    + 'password policy: at least 12 characters, at most 128, and a refusal for a password that is '
    + 'too common or too similar to the email address (400 AUTH_PASSWORD_POLICY_FAILED).',
  ),
  invitationCode: invitationCodeSchema,
  displayName: z.string().trim().min(1).max(120).optional(),
  locale: localeSchema,
  timezone: timezoneSchema,
  baseCurrency: currencySchema,
});

// Registration is intentionally generic: a new account and an existing email
// return the same accepted outcome so the endpoint is not an enumeration oracle
// (UF-AUTH-01, SEC-AUTH-04).
/**
 * OQ-20 (2026-10-12): registration issues no challenge and sends no email, so the
 * response carries no delivery and no resend window — a caller cannot infer from it
 * whether a verification email exists at all. Verification has no endpoint of its
 * own: the only emailed code is the reset OTP, submitted to `/auth/password/reset`.
 */
export const registerResponseSchema = z.strictObject({
  accepted: z.literal(true),
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
  oneTimeCode: otpSchema,
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
  status: z.enum(['active', 'locked', 'disabled', 'deletion_pending']),
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
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
export type PasswordResetBody = z.infer<typeof passwordResetBodySchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
