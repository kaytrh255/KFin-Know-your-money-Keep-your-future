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
      EMAIL_DELIVERY_ADAPTER: 'resend',
      EMAIL_FROM_ADDRESS: 'KFin <no-reply@kfin.example>',
      RESEND_API_KEY: 're_test_key_0123456789',
    });
    expect(config.authCookieSecure).toBe(true);
  });

  it('refuses a production configuration that cannot deliver email', () => {
    expect(() => loadApiConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
    })).toThrow(/EMAIL_DELIVERY_ADAPTER/);
  });

  it('requires both provider credentials when the resend adapter is selected', () => {
    const base = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      DATABASE_SSL_MODE: 'disable',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      EMAIL_DELIVERY_ADAPTER: 'resend',
    } as const;
    expect(() => loadApiConfig({ ...base })).toThrow(/RESEND_API_KEY/);
    expect(() => loadApiConfig({ ...base, RESEND_API_KEY: 're_test_key_0123456789' }))
      .toThrow(/EMAIL_FROM_ADDRESS/);
  });

  it('loads resend configuration without exposing it in derived values', () => {
    const config = loadApiConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      EMAIL_DELIVERY_ADAPTER: 'resend',
      EMAIL_FROM_ADDRESS: 'KFin <no-reply@kfin.example>',
      EMAIL_REPLY_TO: 'support@kfin.example',
      RESEND_API_KEY: 're_test_key_0123456789',
      EMAIL_PROVIDER_BASE_URL: 'https://api.resend.com',
      EMAIL_PROVIDER_TIMEOUT_MS: '7500',
    });
    expect(config.emailDeliveryAdapter).toBe('resend');
    expect(config.emailFromAddress).toBe('KFin <no-reply@kfin.example>');
    expect(config.emailReplyTo).toBe('support@kfin.example');
    expect(config.emailProviderBaseUrl).toBe('https://api.resend.com');
    expect(config.emailProviderTimeoutMs).toBe(7_500);
    expect(config.resendApiKey).toBe('re_test_key_0123456789');
  });

  it('accepts the local file email sink in development when a directory is given', () => {
    const config = loadApiConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      DATABASE_SSL_MODE: 'disable',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      EMAIL_DELIVERY_ADAPTER: 'file',
      EMAIL_OUTBOX_DIR: '/tmp/kfin-outbox',
    });
    expect(config.emailDeliveryAdapter).toBe('file');
    expect(config.emailOutboxDir).toBe('/tmp/kfin-outbox');
  });

  it('requires a directory when the file email sink is selected', () => {
    expect(() => loadApiConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      DATABASE_SSL_MODE: 'disable',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      EMAIL_DELIVERY_ADAPTER: 'file',
    })).toThrow(/EMAIL_OUTBOX_DIR/);
  });

  it('refuses the file email sink in production because it writes one-time secrets to disk', () => {
    expect(() => loadApiConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      DATABASE_SSL_MODE: 'verify-full',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      EMAIL_DELIVERY_ADAPTER: 'file',
      EMAIL_OUTBOX_DIR: '/tmp/kfin-outbox',
    })).toThrow(/EMAIL_DELIVERY_ADAPTER/);
  });

  it('refuses a mail-less production boot unless staging mode is explicit', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      EMAIL_DELIVERY_ADAPTER: 'none',
    } as const;
    expect(() => loadApiConfig({ ...base })).toThrow(/EMAIL_DELIVERY_ADAPTER/);

    const staging = loadApiConfig({ ...base, STAGING_MODE: 'true' });
    expect(staging.stagingMode).toBe(true);
    expect(staging.emailDeliveryAdapter).toBe('none');
    // The exception is scoped to mail: every other production guard still holds.
    expect(() => loadApiConfig({ ...base, STAGING_MODE: 'true', AUTH_COOKIE_SECURE: 'false' }))
      .toThrow(/AUTH_COOKIE_SECURE/);
    expect(() => loadApiConfig({ ...base, STAGING_MODE: 'true', AUTH_ALLOWED_ORIGINS: 'https://x.example' }))
      .toThrow(/AUTH_ALLOWED_ORIGINS/);
  });

  it('does not enable staging mode by default', () => {
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
    });
    expect(config.stagingMode).toBe(false);
  });

  it('trusts no proxy unless one is named explicitly', () => {
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
    });
    expect(config.trustedProxies).toEqual([]);
    expect(config.hstsMaxAgeSeconds).toBe(31_536_000);
  });

  it('accepts explicit proxy addresses and CIDR blocks', () => {
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      TRUST_PROXY: ' 127.0.0.1 , 10.0.0.0/8 ,::1',
    });
    expect(config.trustedProxies).toEqual(['127.0.0.1', '10.0.0.0/8', '::1']);
  });

  it.each(['*', 'true', 'proxy.internal', '10.0.0.300', '127.0.0.1; DROP TABLE users'])(
    'refuses an untrusted proxy value %s instead of trusting every peer',
    (value) => {
      expect(() => loadApiConfig({
        DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
        IDEMPOTENCY_RETENTION_HOURS: '24',
        FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
        AUTH_SECRET,
        TRUST_PROXY: value,
      })).toThrow(/TRUST_PROXY/);
    },
  );

  it('accepts disabling HSTS on a host that is not yet behind TLS', () => {
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
      HSTS_MAX_AGE_SECONDS: '0',
    });
    expect(config.hstsMaxAgeSeconds).toBe(0);
  });

  it('leaves the outbox unset for the provider-less default', () => {
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      IDEMPOTENCY_RETENTION_HOURS: '24',
      FINANCIAL_PREVIEW_SIGNING_KEY: 'ab'.repeat(32),
      AUTH_SECRET,
    });
    expect(config.emailDeliveryAdapter).toBe('none');
    expect(config.emailOutboxDir).toBeNull();
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
      hourlyIssuanceCap: 3,
      dailyIssuanceCap: 6,
      verifyCumulativeMaximum: 10,
      verifyCumulativeWindowMs: 3_600_000,
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
    expect(authPolicy.session.csrfEntropyBytes).toBeGreaterThanOrEqual(16);
    expect(authPolicy.invitation.codeEntropyBytes).toBeGreaterThanOrEqual(16);
  });

  it('reserves the emailed OTP for password reset and bounds it (OQ-20)', () => {
    // A six-digit code is only defensible while issuance and verification are both
    // capped: 3 per hour, 6 per day, and one cumulative failure budget per account
    // that a resend cannot reset (SEC-AUTH-20, TM-03).
    expect(authPolicy.challenge.otpDigits).toBe(6);
    expect(authPolicy.challenge.hourlyIssuanceCap).toBe(3);
    expect(authPolicy.challenge.dailyIssuanceCap).toBe(6);
    expect(authPolicy.challenge.verifyCumulativeMaximum).toBeGreaterThanOrEqual(5);
    expect(authPolicy.challenge.verifyCumulativeMaximum).toBeLessThanOrEqual(20);
    expect(authPolicy.challenge.verifyCumulativeWindowMs).toBe(60 * 60 * 1_000);
    expect(authPolicy.challenge.maximumAttempts).toBeLessThanOrEqual(
      authPolicy.challenge.verifyCumulativeMaximum,
    );
    // No verification-flow knob may survive: registration issues no challenge.
    expect('verificationMaximumAttempts' in authPolicy.abuse).toBe(false);
    expect(Object.keys(authPolicy.challenge).sort()).toEqual([
      'dailyIssuanceCap',
      'hourlyIssuanceCap',
      'maximumAttempts',
      'otpDigits',
      'otpLifetimeMs',
      'resendCooldownMs',
      'verifyCumulativeMaximum',
      'verifyCumulativeWindowMs',
    ]);
  });
});
