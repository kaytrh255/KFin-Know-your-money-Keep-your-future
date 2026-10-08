import { describe, expect, it } from 'vitest';
import { financialPolicy, loadApiConfig } from '../src/index.js';

describe('configuration', () => {
  it('loads explicit database and retention configuration', () => {
    const config = loadApiConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
      DATABASE_SSL_MODE: 'disable',
      IDEMPOTENCY_RETENTION_HOURS: '24',
    });
    expect(config.idempotencyRetentionMs).toBe(86_400_000);
    expect(config.database.poolMaximum).toBe(5);
  });

  it('has no silent idempotency retention default', () => {
    expect(() => loadApiConfig({
      DATABASE_URL: 'postgresql://user:secret@database.invalid/kfin',
    })).toThrow(/IDEMPOTENCY_RETENTION_HOURS/);
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
});
