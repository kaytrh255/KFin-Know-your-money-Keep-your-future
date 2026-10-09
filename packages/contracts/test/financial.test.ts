import { describe, expect, it } from 'vitest';
import {
  correctionCommitBodySchema,
  correctionPreviewBodySchema,
  createSnapshotBodySchema,
  createTransactionBodySchema,
  financialAccountListResponseSchema,
  openFinancialAccountBodySchema,
  transactionCorrectionHistoryQuerySchema,
  transactionListQuerySchema,
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
      reviewedUserTimezone: 'Asia/Ho_Chi_Minh',
      reviewedUserVersion: '1',
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

  it('bounds transaction and correction-history collections with opaque cursors', () => {
    expect(transactionListQuerySchema.parse({
      limit: '25',
      cursor: 'opaque-page',
      month: '0001-01',
      categoryCode: 'food',
      kind: 'expense',
      balanceEffect: 'historical',
    })).toMatchObject({ limit: 25, cursor: 'opaque-page', month: '0001-01' });
    expect(transactionCorrectionHistoryQuerySchema.parse({ limit: '1', cursor: 'next' }))
      .toEqual({ limit: 1, cursor: 'next' });
    expect(transactionListQuerySchema.safeParse({ month: '0000-01' }).success).toBe(false);
    expect(transactionCorrectionHistoryQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });


  it('accepts only the opening balance and instant for account onboarding', () => {
    const valid = { openingBalanceMinor: '-250000', effectiveAt: '2026-10-08T08:00:00.000+07:00' };
    expect(openFinancialAccountBodySchema.safeParse(valid).success).toBe(true);
    for (const extra of ['ownerId', 'userId', 'accountId', 'currency', 'financialStateVersion']) {
      expect(openFinancialAccountBodySchema.safeParse({ ...valid, [extra]: 'x' }).success).toBe(false);
    }
    expect(openFinancialAccountBodySchema.safeParse({ ...valid, openingBalanceMinor: 1000 }).success).toBe(false);
    expect(openFinancialAccountBodySchema.safeParse({ openingBalanceMinor: '1' }).success).toBe(false);
    expect(openFinancialAccountBodySchema.safeParse({ ...valid, openingBalanceMinor: '1'.repeat(65) }).success).toBe(false);
  });

  it('bounds the financial-account list response', () => {
    expect(financialAccountListResponseSchema.safeParse({ items: [] }).success).toBe(true);
    expect(financialAccountListResponseSchema.safeParse({ items: [], ownerId: 'x' }).success).toBe(false);
  });
});
