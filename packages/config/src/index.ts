import { z } from 'zod';

const MAX_SAFE_RETENTION_HOURS = Math.floor(Number.MAX_SAFE_INTEGER / (60 * 60 * 1_000));

export const financialPolicy = Object.freeze({
  id: 'account_financial_serialization.v1',
  isolationLevel: 'READ COMMITTED',
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000,
  databaseBudgetMs: 8_000,
  maximumAttempts: 2,
  retryJitterMinimumMs: 25,
  retryJitterMaximumMs: 75,
  commitRecoveryBudgetMs: 2_000,
  retryableSqlstates: Object.freeze(['55P03', '40P01', '40001'] as const),
});

/**
 * Candidate Trusted Private Beta access bounds.
 *
 * Every value below is an *unapproved candidate* recorded for implementation and
 * test determinism only. `SPEC-AUTH-02` (Security + Product) must approve each
 * invitation/password/OTP/reset/login-abuse/lifetime/rotation value before any of
 * them is treated as policy. No framework default is hidden here.
 */
export const authPolicy = Object.freeze({
  id: 'trusted_beta_access.v1',
  password: Object.freeze({
    minimumLength: 12,
    maximumLength: 128,
    hashPolicyVersion: 1,
    argon2: Object.freeze({
      algorithm: 'argon2id',
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
  }),
  invitation: Object.freeze({
    codeEntropyBytes: 20,
    codeGroupLength: 8,
    defaultLifetimeMs: 14 * 24 * 60 * 60 * 1_000,
  }),
  challenge: Object.freeze({
    otpDigits: 6,
    otpLifetimeMs: 10 * 60 * 1_000,
    maximumAttempts: 5,
    resendCooldownMs: 60 * 1_000,
    resetSecretEntropyBytes: 32,
    resetLifetimeMs: 30 * 60 * 1_000,
    hourlyIssuanceCap: 5,
    dailyIssuanceCap: 12,
  }),
  session: Object.freeze({
    tokenEntropyBytes: 32,
    csrfEntropyBytes: 32,
    idleLifetimeMs: 30 * 24 * 60 * 60 * 1_000,
    absoluteLifetimeMs: 90 * 24 * 60 * 60 * 1_000,
    rotationGraceMs: 30 * 1_000,
    lastSeenThrottleMs: 60 * 1_000,
    cookieName: 'kfin_session',
    cookiePrefixHost: true,
  }),
  abuse: Object.freeze({
    windowMs: 15 * 60 * 1_000,
    loginMaximumFailures: 10,
    verificationMaximumAttempts: 20,
    resetMaximumRequests: 10,
    registrationMaximumPerWindow: 20,
    retentionWindows: 8,
  }),
});

export type AuthPolicy = typeof authPolicy;

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  DATABASE_URL: z.string().trim().min(1).refine(isPostgresUrl, {
    message: 'must be a postgres:// or postgresql:// URL',
  }),
  DATABASE_SSL_MODE: z.enum(['disable', 'verify-full']).default('verify-full'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  IDEMPOTENCY_RETENTION_HOURS: z.coerce.number().int().positive().max(MAX_SAFE_RETENTION_HOURS),
  FINANCIAL_PREVIEW_SIGNING_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, {
    message: 'must be exactly 32 bytes encoded as 64 hexadecimal characters',
  }),
  // Server secret for keyed auth digests (invitation codes, OTP/reset secrets,
  // session tokens, CSRF tokens, abuse counters). Never shares the financial
  // preview key and never becomes a client-visible value.
  AUTH_SECRET: z.string().regex(/^[a-fA-F0-9]{64}$/, {
    message: 'must be exactly 32 bytes encoded as 64 hexadecimal characters',
  }),
  // Same-origin is enforced from the request Host. Add exact origins only when a
  // reviewed deployment requires them; a credentialed wildcard is never allowed.
  AUTH_ALLOWED_ORIGINS: z.string().default(''),
  // Production deployments MUST keep this enabled. Local HTTP development may
  // disable it explicitly; the cookie then loses the `__Host-` prefix.
  AUTH_COOKIE_SECURE: z
    .string()
    .default('true')
    .transform((value) => value === 'true')
    .pipe(z.boolean()),
  // Provider selection remains Phase 6 (OQ-17). Only vendor-neutral adapters exist.
  EMAIL_DELIVERY_ADAPTER: z.enum(['memory', 'none']).default('none'),
});

export interface ApiConfig {
  readonly environment: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly database: {
    readonly url: string;
    readonly sslMode: 'disable' | 'verify-full';
    readonly poolMaximum: number;
  };
  readonly idempotencyRetentionMs: number;
  readonly financialPreviewSigningKey: string;
  readonly authSecret: string;
  readonly authAllowedOrigins: readonly string[];
  readonly authCookieSecure: boolean;
  readonly emailDeliveryAdapter: 'memory' | 'none';
}

export function loadApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid KFin configuration (${fields})`);
  }

  return Object.freeze({
    environment: parsed.data.NODE_ENV,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    database: Object.freeze({
      url: parsed.data.DATABASE_URL,
      sslMode: parsed.data.DATABASE_SSL_MODE,
      poolMaximum: parsed.data.DATABASE_POOL_MAX,
    }),
    idempotencyRetentionMs: parsed.data.IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1_000,
    financialPreviewSigningKey: parsed.data.FINANCIAL_PREVIEW_SIGNING_KEY,
    authSecret: parsed.data.AUTH_SECRET,
    authAllowedOrigins: Object.freeze(
      parsed.data.AUTH_ALLOWED_ORIGINS
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
    authCookieSecure: parsed.data.AUTH_COOKIE_SECURE,
    emailDeliveryAdapter: parsed.data.EMAIL_DELIVERY_ADAPTER,
  });
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:')
      && Boolean(url.hostname)
      && Boolean(url.pathname.slice(1));
  } catch {
    return false;
  }
}
