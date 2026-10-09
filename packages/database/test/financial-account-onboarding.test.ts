import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { parseOpeningBalance, PostgresFinancialRepository } from '../src/financial-repository.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-09T03:00:00.000Z');

function repositoryWithSpyPool() {
  const pool = {
    connect: vi.fn(async () => {
      throw new Error('validation must happen before any database checkout');
    }),
    query: vi.fn(async () => {
      throw new Error('validation must happen before any database query');
    }),
  };
  const repository = new PostgresFinancialRepository(
    pool as unknown as Pool,
    86_400_000,
    'ab'.repeat(32),
    () => NOW,
  );
  return { repository, pool };
}

describe('financial-account onboarding validation', () => {
  it.each([
    ['empty', ''],
    ['leading zero', '01'],
    ['negative zero', '-0'],
    ['plus sign', '+1'],
    ['decimal', '1.5'],
    ['exponent', '1e6'],
    ['whitespace', ' 100'],
    ['thousands separator', '1,000'],
    ['non-numeric', 'abc'],
    ['above bigint maximum', '9223372036854775808'],
    ['below bigint minimum', '-9223372036854775809'],
    ['twenty digits', '10000000000000000000'],
  ])('rejects a %s opening balance with 422 before touching the database', async (_label, value) => {
    const { repository, pool } = repositoryWithSpyPool();
    await expect(repository.openFinancialAccount(OWNER_ID, {
      openingBalanceMinor: value,
      effectiveAt: '2026-10-08T00:00:00.000Z',
    }, 'key', 'correlation')).rejects.toMatchObject({
      code: 'FIN_OPENING_BALANCE_INVALID',
      statusCode: 422,
    });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([
    ['future instant', '2026-10-09T03:00:00.001Z'],
    ['unparseable instant', 'not-a-date'],
  ])('rejects a %s with 422 before touching the database', async (_label, effectiveAt) => {
    const { repository, pool } = repositoryWithSpyPool();
    await expect(repository.openFinancialAccount(OWNER_ID, {
      openingBalanceMinor: '1000',
      effectiveAt,
    }, 'key', 'correlation')).rejects.toMatchObject({
      code: 'FIN_OPENING_BALANCE_INVALID',
      statusCode: 422,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', '0', 0n],
    ['negative (overdrawn)', '-250000', -250000n],
    ['bigint maximum', '9223372036854775807', 9223372036854775807n],
    ['bigint minimum', '-9223372036854775808', -9223372036854775808n],
  ])('accepts a %s opening balance', (_label, value, expected) => {
    const parsed = parseOpeningBalance({ openingBalanceMinor: value, effectiveAt: NOW.toISOString() }, NOW);
    expect(parsed.amount).toBe(expected);
    expect(parsed.effectiveAt.toISOString()).toBe(NOW.toISOString());
  });

  it('normalizes an offset instant to the same UTC moment', () => {
    const parsed = parseOpeningBalance({
      openingBalanceMinor: '1',
      effectiveAt: '2026-10-09T09:00:00.000+07:00',
    }, NOW);
    expect(parsed.effectiveAt.toISOString()).toBe('2026-10-09T02:00:00.000Z');
  });
});
