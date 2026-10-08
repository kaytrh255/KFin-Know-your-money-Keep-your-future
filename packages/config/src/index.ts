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
