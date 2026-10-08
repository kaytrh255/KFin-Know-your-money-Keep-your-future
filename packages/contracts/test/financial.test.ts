import { describe, expect, it } from 'vitest';
import {
  correctionCommitBodySchema,
  correctionPreviewBodySchema,
  createSnapshotBodySchema,
  createTransactionBodySchema,
  voidCommitBodySchema,
} from '../src/index.js';

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

  it('requires a bounded reason and a complete replacement for correction preview', () => {
    expect(correctionPreviewBodySchema.safeParse({
      reason: 'Fix entered amount',
      replacement: {
        amountMinor: '900',
        occurredOn: '2026-10-08',
        categoryCode: 'food',
        expenseClass: 'daily',
        isUnexpected: false,
      },
    }).success).toBe(true);
    expect(correctionPreviewBodySchema.safeParse({
      replacement: {
        amountMinor: '900',
        occurredOn: '2026-10-08',
        categoryCode: 'food',
        expenseClass: 'daily',
        isUnexpected: false,
      },
    }).success).toBe(false);
  });

  it('accepts only reviewed authority context and rejects owner/account mass assignment', () => {
    const context = {
      ...financialState,
      reviewedSourceVersion: '1',
      reviewedSourceSnapshotId: financialState.reviewedLatestSnapshotId,
      reviewedSourceBalanceEffect: 'current',
      reviewedSourceAlreadyIncludedInSnapshot: false,
      reviewedSourceKind: 'expense',
      reviewedSourceCurrency: 'VND',
      reviewedOwningDomain: {
        type: 'none',
        scheduleOccurrenceId: null,
        scheduleOccurrenceVersion: null,
      },
      reviewedPreviewDigest: 'a'.repeat(64),
    };
    const replacement = {
      amountMinor: '900',
      occurredOn: '2026-10-08',
      categoryCode: 'food',
      expenseClass: 'daily',
      isUnexpected: false,
    };
    expect(correctionCommitBodySchema.safeParse({
      reason: 'Fix entered amount',
      replacement,
      context,
    }).success).toBe(true);
    const { reviewedOwningDomain: _omitted, ...incompleteContext } = context;
    expect(correctionCommitBodySchema.safeParse({
      reason: 'Fix entered amount',
      replacement,
      context: incompleteContext,
    }).success).toBe(false);
    expect(voidCommitBodySchema.safeParse({
      reason: 'Duplicate entry',
      context,
      accountId: '00000000-0000-4000-8000-000000000099',
    }).success).toBe(false);
  });
});
