import { describe, expect, it } from 'vitest';
import {
  activeSavingsReserveMinor,
  assertAsOfNotFuture,
  assertContributionPlan,
  computeSavingsProgress,
  normalizeSavingsGoalName,
  normalizeSavingsReason,
  parseNonNegativeSavingsMinor,
  parsePositiveSavingsMinor,
} from '../src/index.js';

describe('savings progress (PRD-SAV-05/07)', () => {
  it('derives basis points, remaining, achieved, and over-target without capping', () => {
    expect(computeSavingsProgress(0n, 1_000n)).toEqual({
      percentBasisPoints: '0', achieved: false, overTarget: false, remainingMinor: '1000',
    });
    expect(computeSavingsProgress(333n, 1_000n).percentBasisPoints).toBe('3330');
    expect(computeSavingsProgress(1n, 3n).percentBasisPoints).toBe('3333');
    expect(computeSavingsProgress(1_000n, 1_000n)).toEqual({
      percentBasisPoints: '10000', achieved: true, overTarget: false, remainingMinor: '0',
    });
    expect(computeSavingsProgress(1_500n, 1_000n)).toEqual({
      percentBasisPoints: '15000', achieved: true, overTarget: true, remainingMinor: '0',
    });
  });

  it('stays exact at the BIGINT boundary', () => {
    const max = 9_223_372_036_854_775_807n;
    expect(computeSavingsProgress(max, max).percentBasisPoints).toBe('10000');
    expect(computeSavingsProgress(max, 1n).percentBasisPoints).toBe((max * 10_000n).toString());
  });

  it('rejects a non-positive target', () => {
    expect(() => computeSavingsProgress(0n, 0n)).toThrow();
  });
});

describe('active savings reserve (STS-09/10)', () => {
  it('sums only active goals', () => {
    const goals = [
      { status: 'active' as const, currentAmountMinor: 100_000n },
      { status: 'active' as const, currentAmountMinor: 150_000n },
      { status: 'archived' as const, currentAmountMinor: 900_000n },
    ];
    expect(1_000_000n - activeSavingsReserveMinor(goals)).toBe(750_000n);
    expect(activeSavingsReserveMinor([])).toBe(0n);
  });

  it('fails closed on BIGINT overflow', () => {
    expect(() => activeSavingsReserveMinor([
      { status: 'active', currentAmountMinor: 9_223_372_036_854_775_807n },
      { status: 'active', currentAmountMinor: 1n },
    ])).toThrow();
  });
});

describe('savings input rules', () => {
  it('parses non-negative and positive minor strings inside the BIGINT range', () => {
    expect(parseNonNegativeSavingsMinor('0', 'x')).toBe(0n);
    expect(parsePositiveSavingsMinor('9223372036854775807', 'x')).toBe(9_223_372_036_854_775_807n);
    for (const bad of ['-1', '01', '1.5', '', ' 1', '9223372036854775808']) {
      expect(() => parseNonNegativeSavingsMinor(bad, 'x')).toThrow(expect.objectContaining({ code: 'SAVINGS_GOAL_INVALID' }));
    }
    expect(() => parsePositiveSavingsMinor('0', 'x')).toThrow(expect.objectContaining({ statusCode: 422 }));
  });

  it('rejects an as-of date in the user-local future, using the user timezone', () => {
    // 2026-10-08T18:30Z is already 2026-10-09 in Asia/Ho_Chi_Minh (UTC+7).
    const now = new Date('2026-10-08T18:30:00Z');
    expect(assertAsOfNotFuture('2026-10-09', now, 'Asia/Ho_Chi_Minh')).toBe('2026-10-09');
    expect(() => assertAsOfNotFuture('2026-10-09', now, 'UTC')).toThrow(expect.objectContaining({ code: 'SAVINGS_GOAL_INVALID' }));
    expect(() => assertAsOfNotFuture('2026-02-30', now, 'UTC')).toThrow();
  });

  it('requires a contribution amount for a cadence', () => {
    expect(() => assertContributionPlan(null, 'monthly')).toThrow();
    expect(() => assertContributionPlan(1n, 'monthly')).not.toThrow();
    expect(() => assertContributionPlan(1n, null)).not.toThrow();
    expect(() => assertContributionPlan(null, null)).not.toThrow();
  });

  it('bounds names and reasons', () => {
    expect(normalizeSavingsGoalName('  Trip  ')).toBe('Trip');
    expect(() => normalizeSavingsGoalName('   ')).toThrow();
    expect(() => normalizeSavingsGoalName('x'.repeat(121))).toThrow();
    expect(normalizeSavingsReason(undefined)).toBeNull();
    expect(() => normalizeSavingsReason('x'.repeat(501))).toThrow();
  });

  it('rejects NUL characters in names and reasons as SAVINGS_GOAL_INVALID (QA F-1)', () => {
    // PostgreSQL answers a NUL-bearing parameter with SQLSTATE 22021; reject it here as invalid input (422) instead.
    for (const nulName of ['Trip\u0000fund', 'Trip\u0000', '\u0000Trip fund']) {
      expect(() => normalizeSavingsGoalName(nulName)).toThrow(
        expect.objectContaining({ code: 'SAVINGS_GOAL_INVALID', statusCode: 422 }),
      );
    }
    expect(() => normalizeSavingsReason('Bonus\u0000')).toThrow(
      expect.objectContaining({ code: 'SAVINGS_GOAL_INVALID', statusCode: 422 }),
    );
    // Control: ordinary text, including Vietnamese and CJK, stays valid.
    expect(normalizeSavingsGoalName('Quỹ khẩn cấp 基金')).toBe('Quỹ khẩn cấp 基金');
    expect(normalizeSavingsReason('Thưởng tết')).toBe('Thưởng tết');
  });
});
