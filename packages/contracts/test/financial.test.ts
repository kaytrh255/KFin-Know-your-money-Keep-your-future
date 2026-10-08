import { describe, expect, it } from 'vitest';
import { createSnapshotBodySchema, createTransactionBodySchema } from '../src/index.js';

const financialState = {
  expectedFinancialStateVersion: '1',
  reviewedLatestSnapshotId: '00000000-0000-4000-8000-000000000001',
};

describe('financial request contracts', () => {
  it('rejects client-supplied ownership and authority fields', () => {
    const result = createTransactionBodySchema.safeParse({
      kind: 'expense',
      amountMinor: '1000',
      occurredOn: '2026-10-08',
      categoryCode: 'food',
      expenseClass: 'daily',
      isUnexpected: false,
      userId: '00000000-0000-4000-8000-000000000002',
      accountId: '00000000-0000-4000-8000-000000000003',
      balanceEffect: 'current',
      ...financialState,
    });
    expect(result.success).toBe(false);
  });

  it('accepts bigint-safe minor-unit strings and rejects JSON numbers', () => {
    expect(createSnapshotBodySchema.safeParse({
      amountMinor: '-9007199254740993',
      effectiveAt: '2026-10-08T08:00:00.000Z',
      ...financialState,
    }).success).toBe(true);
    expect(createSnapshotBodySchema.safeParse({
      amountMinor: 1000,
      effectiveAt: '2026-10-08T08:00:00.000Z',
      ...financialState,
    }).success).toBe(false);
  });
});
