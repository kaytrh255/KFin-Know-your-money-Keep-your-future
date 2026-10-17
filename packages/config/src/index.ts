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
  // OQ-20 (2026-10-12): the only emailed OTP is the password-reset OTP.
  // Registration issues no challenge at all, so there is no verification lifetime
  // or verification issuance cap here — only the reset-challenge bounds.
  challenge: Object.freeze({
    otpDigits: 6,
    otpLifetimeMs: 10 * 60 * 1_000,
    maximumAttempts: 5,
    resendCooldownMs: 60 * 1_000,
    hourlyIssuanceCap: 3,
    dailyIssuanceCap: 6,
    /**
     * Cumulative failed-verification budget across superseded challenges: a
     * resend may never restore it (SEC-AUTH-20). The verifier records every
     * attempt against this window *before* it looks at any challenge, so an
     * address with no account is throttled exactly like one with an account and
     * the limit cannot become an existence oracle (SEC-AUTH-04, TM-03).
     */
    verifyCumulativeMaximum: 10,
    verifyCumulativeWindowMs: 60 * 60 * 1_000,
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
  // UNSUPPORTED: cross-origin credentialed browser access is not implemented.
  // No CORS layer exists and no `Access-Control-Allow-Credentials` response is
  // ever emitted, so an allowlisted origin would widen the CSRF origin check
  // without a browser being able to complete the request. The variable is kept
  // only to fail fast on a deployment that still sets it.
  AUTH_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .refine((value) => value.trim().length === 0, {
      message: 'is unsupported: no credentialed CORS layer exists, so the browser client must be served same-origin; remove every configured origin',
    }),
  // Production deployments MUST keep this enabled. Local HTTP development may
  // disable it explicitly; the cookie then loses the `__Host-` prefix.
  AUTH_COOKIE_SECURE: z
    .string()
    .default('true')
    .transform((value) => value === 'true')
    .pipe(z.boolean()),
  // `resend` is the Private Beta provider (ADR-002/OQ-17 implementation). The
  // other kinds stay for tests and local development; production refuses them.
  EMAIL_DELIVERY_ADAPTER: z.enum(['memory', 'none', 'file', 'resend']).default('none'),
  // Provider configuration is read from the environment only; no credential is
  // ever committed. `from` may use the `Name <address>` form the provider accepts.
  EMAIL_FROM_ADDRESS: z.string().trim().min(3).max(320).refine(
    (value) => value.includes('@') && !/[\r\n]/.test(value),
    { message: 'must contain an email address and no line break' },
  ).optional(),
  EMAIL_REPLY_TO: z.string().trim().min(3).max(320).refine(
    (value) => value.includes('@') && !/[\r\n]/.test(value),
    { message: 'must contain an email address and no line break' },
  ).optional(),
  RESEND_API_KEY: z.string().trim().min(8).max(512).optional(),
  EMAIL_PROVIDER_BASE_URL: z.string().trim().url().default('https://api.resend.com'),
  EMAIL_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  // Local-development sink only: the `file` adapter writes each security message
  // into this directory so a developer can complete registration and recovery
  // without an email provider. Refused in production below, because it puts an
  // OTP/reset secret on the filesystem where the design never persists one.
  EMAIL_OUTBOX_DIR: z.string().trim().min(1).max(4_096).optional(),
  // Production serving topology: the compiled client directory. Defaults to
  // `apps/api/dist/web` next to the running bundle.
  WEB_CLIENT_ROOT: z.string().trim().min(1).max(4_096).optional(),
}).superRefine((value, ctx) => {
  if (value.EMAIL_DELIVERY_ADAPTER === 'file') {
    if (value.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_DELIVERY_ADAPTER'],
        message: 'must not be "file" when NODE_ENV=production: the local development sink writes one-time secrets to the filesystem',
      });
    }
    if (!value.EMAIL_OUTBOX_DIR) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_OUTBOX_DIR'],
        message: 'is required when EMAIL_DELIVERY_ADAPTER=file',
      });
    }
  }
  if (value.EMAIL_DELIVERY_ADAPTER === 'resend') {
    if (!value.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'is required when EMAIL_DELIVERY_ADAPTER=resend',
      });
    }
    if (!value.EMAIL_FROM_ADDRESS) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_FROM_ADDRESS'],
        message: 'is required when EMAIL_DELIVERY_ADAPTER=resend',
      });
    }
  }
  // A production deployment that cannot deliver mail cannot run the Private Beta:
  // invitation, reset and security notices all depend on it. Refusing the boot is
  // the only way this gap cannot silently return.
  if (value.NODE_ENV === 'production' && value.EMAIL_DELIVERY_ADAPTER !== 'resend') {
    ctx.addIssue({
      code: 'custom',
      path: ['EMAIL_DELIVERY_ADAPTER'],
      message: 'must be "resend" when NODE_ENV=production: the beta requires real email delivery',
    });
  }
  // A clear-cookie session flag in production would put the bearer token on the
  // network in plaintext; refuse to boot instead of degrading silently
  // (SEC-SES-01/02).
  if (value.NODE_ENV === 'production' && value.AUTH_COOKIE_SECURE !== true) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_COOKIE_SECURE'],
      message: 'must be "true" when NODE_ENV=production: session cookies may not be sent over plaintext HTTP',
    });
  }
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
  readonly authCookieSecure: boolean;
  readonly emailDeliveryAdapter: 'memory' | 'none' | 'file' | 'resend';
  /** Absolute or relative directory for the local-development email sink. */
  readonly emailOutboxDir: string | null;
  readonly emailFromAddress: string | null;
  readonly emailReplyTo: string | null;
  readonly resendApiKey: string | null;
  readonly emailProviderBaseUrl: string;
  readonly emailProviderTimeoutMs: number;
  /** Static client directory for the single-origin production topology. */
  readonly webClientRoot: string | null;
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
    authCookieSecure: parsed.data.AUTH_COOKIE_SECURE,
    emailDeliveryAdapter: parsed.data.EMAIL_DELIVERY_ADAPTER,
    emailOutboxDir: parsed.data.EMAIL_OUTBOX_DIR ?? null,
    emailFromAddress: parsed.data.EMAIL_FROM_ADDRESS ?? null,
    emailReplyTo: parsed.data.EMAIL_REPLY_TO ?? null,
    resendApiKey: parsed.data.RESEND_API_KEY ?? null,
    emailProviderBaseUrl: parsed.data.EMAIL_PROVIDER_BASE_URL,
    emailProviderTimeoutMs: parsed.data.EMAIL_PROVIDER_TIMEOUT_MS,
    webClientRoot: parsed.data.WEB_CLIENT_ROOT ?? null,
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
