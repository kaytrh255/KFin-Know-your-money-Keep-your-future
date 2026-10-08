import { describe, expect, it } from 'vitest';
import {
  calculateCurrentBalance,
  classifyTransaction,
  FinancialError,
  parsePositiveMinor,
  parseSignedMinor,
  POSTGRES_BIGINT_MAXIMUM,
  validateTransactionClassification,
} from '../src/index.js';

describe('integer money', () => {
  it('parses signed snapshots and positive transaction magnitudes without number conversion', () => {
    expect(parseSignedMinor('-9007199254740993')).toBe(-9_007_199_254_740_993n);
    expect(parsePositiveMinor(POSTGRES_BIGINT_MAXIMUM.toString())).toBe(POSTGRES_BIGINT_MAXIMUM);
  });

  it.each(['0', '-1', '01', '1.5', '9223372036854775808'])(
    'rejects invalid positive minor units: %s',
    (value) => expect(() => parsePositiveMinor(value)).toThrow(FinancialError),
  );
});

describe('snapshot-segment classification', () => {
  const common = {
    snapshotEffectiveLocalDate: '2026-10-08',
    currentLocalDate: '2026-10-10',
  } as const;

  it('classifies pre-anchor facts as historical and post-anchor facts as current', () => {
    expect(classifyTransaction({ ...common, occurredOn: '2026-10-07' })).toEqual({
      balanceEffect: 'historical',
      alreadyIncludedInSnapshot: true,
    });
    expect(classifyTransaction({ ...common, occurredOn: '2026-10-09' })).toEqual({
      balanceEffect: 'current',
      alreadyIncludedInSnapshot: false,
    });
  });

  it('requires an explicit same-day inclusion choice', () => {
    expect(() => classifyTransaction({ ...common, occurredOn: '2026-10-08' })).toThrow(
      /explicit snapshot-inclusion choice/,
    );
    expect(classifyTransaction({
      ...common,
      occurredOn: '2026-10-08',
      alreadyIncludedInSnapshot: true,
    }).balanceEffect).toBe('historical');
    expect(classifyTransaction({
      ...common,
      occurredOn: '2026-10-08',
      alreadyIncludedInSnapshot: false,
    }).balanceEffect).toBe('current');
  });

  it('rejects future facts and contradictory inclusion flags', () => {
    expect(() => classifyTransaction({ ...common, occurredOn: '2026-10-11' })).toThrow(/future/);
    expect(() => classifyTransaction({
      ...common,
      occurredOn: '2026-10-07',
      alreadyIncludedInSnapshot: false,
    })).toThrow(/already included/);
  });
});

describe('authoritative current balance', () => {
  it('uses only posted current facts attached to the latest snapshot', () => {
    const balance = calculateCurrentBalance('latest', 1_000_000n, [
      { amountMinor: 400_000n, kind: 'income', balanceEffect: 'current', status: 'posted', balanceSnapshotId: 'latest' },
      { amountMinor: 250_000n, kind: 'expense', balanceEffect: 'current', status: 'posted', balanceSnapshotId: 'latest' },
      { amountMinor: 900_000n, kind: 'income', balanceEffect: 'historical', status: 'posted', balanceSnapshotId: 'latest' },
      { amountMinor: 500_000n, kind: 'expense', balanceEffect: 'current', status: 'posted', balanceSnapshotId: 'old' },
      { amountMinor: 750_000n, kind: 'expense', balanceEffect: 'current', status: 'voided', balanceSnapshotId: 'latest' },
    ]);
    expect(balance).toBe(1_150_000n);
  });

  it('allows a negative current balance without clamping', () => {
    expect(calculateCurrentBalance('s', 100n, [
      { amountMinor: 250n, kind: 'expense', balanceEffect: 'current', status: 'posted', balanceSnapshotId: 's' },
    ])).toBe(-150n);
  });
});

describe('transaction classification fields', () => {
  it('keeps unexpected orthogonal to expense class and forbids it for income', () => {
    expect(validateTransactionClassification({
      kind: 'expense',
      expenseClass: 'essential_fixed',
      isUnexpected: true,
    })).toBe('essential_fixed');
    expect(() => validateTransactionClassification({ kind: 'income', isUnexpected: true })).toThrow(
      /Income cannot/,
    );
  });
});
