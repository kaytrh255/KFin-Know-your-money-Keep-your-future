import { describe, expect, it } from 'vitest';
import { authPolicy, financialPolicy, loadApiConfig } from '../src/index.js';

const AUTH_SECRET = 'cd'.repeat(32);

describe('configuration', () => {
  it('loads explicit database and retention configuration', () => {
    const config = loadApiConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      DATABASE_SSL_MODE: 'disable',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
    });
    expect(config.idempotencyRetentionMs).toBe(86_400_000);
    expect(config.financialPreviewSigningKey).toBe('ab'.repeat(32));
    expect(config.database.poolMaximum).toBe(5);
    expect(config.authSecret).toBe(AUTH_SECRET);
    expect(config.authCookieSecure).toBe(true);
    expect(config.emailDeliveryAdapter).toBe('none');
  });

  it('has no silent idempotency retention default', () => {
    expect(() => loadApiConfig({
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      AUTH_SECRET,
    })).toThrow(/IDEMPOTENCY_RETENTION_HOURS/);
  });

  it('requires an explicit auth secret instead of a default key', () => {
    expect(() => loadApiConfig({
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
    })).toThrow(/AUTH_SECRET/);
  });

  it('refuses an explicit production configuration with insecure cookies', () => {
    expect(() => loadApiConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      DATABASE_SSL_MODE: 'verify-full',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      AUTH_COOKIE_SECURE: 'false',
    })).toThrow(/AUTH_COOKIE_SECURE/);
  });

  it('still allows insecure cookies for local HTTP development', () => {
    const config = loadApiConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      DATABASE_SSL_MODE: 'disable',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      AUTH_COOKIE_SECURE: 'false',
    });
    expect(config.authCookieSecure).toBe(false);
  });

  it('keeps production secure cookies enabled by default', () => {
    const config = loadApiConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
    });
    expect(config.authCookieSecure).toBe(true);
  });

  it('rejects every configured origin because credentialed CORS is unsupported', () => {
    expect(() => loadApiConfig({
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      AUTH_ALLOWED_ORIGINS: ' https://app.kfin.example , https://beta.kfin.example ',
    })).toThrow(/AUTH_ALLOWED_ORIGINS/);

    expect(() => loadApiConfig({
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      AUTH_ALLOWED_ORIGINS: '*',
    })).toThrow(/AUTH_ALLOWED_ORIGINS/);
  });

  it('accepts an empty origin list, which is the only supported value', () => {
    expect(() => loadApiConfig({
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      AUTH_ALLOWED_ORIGINS: '   ',
    })).not.toThrow();
  });

  it('pins the frozen candidate concurrency bounds', () => {
    expect(financialPolicy).toMatchObject({
      lockTimeoutMs: 2_000,
      statementTimeoutMs: 5_000,
      databaseBudgetMs: 8_000,
      maximumAttempts: 2,
      commitRecoveryBudgetMs: 2_000,
      retryableSqlstates: ['55P03', '40P01', '40001'],
    });
  });

  it('pins the candidate Trusted Private Beta access bounds', () => {
    expect(authPolicy.id).toBe('trusted_beta_access.v1');
    expect(authPolicy.password).toMatchObject({
      minimumLength: 12,
      maximumLength: 128,
      hashPolicyVersion: 1,
    });
    expect(authPolicy.password.argon2).toMatchObject({
      algorithm: 'argon2id',
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    expect(authPolicy.challenge).toMatchObject({
      otpDigits: 6,
      otpLifetimeMs: 600_000,
      maximumAttempts: 5,
      resendCooldownMs: 60_000,
      resetLifetimeMs: 1_800_000,
    });
    expect(authPolicy.session).toMatchObject({
      tokenEntropyBytes: 32,
      csrfEntropyBytes: 32,
      idleLifetimeMs: 2_592_000_000,
      absoluteLifetimeMs: 7_776_000_000,
    });
  });

  it('keeps every access secret at least 128 bits of entropy', () => {
    expect(authPolicy.session.tokenEntropyBytes).toBeGreaterThanOrEqual(16);
    expect(authPolicy.invitation.codeEntropyBytes).toBeGreaterThanOrEqual(16);
    expect(authPolicy.challenge.resetSecretEntropyBytes).toBeGreaterThanOrEqual(16);
  });
});
