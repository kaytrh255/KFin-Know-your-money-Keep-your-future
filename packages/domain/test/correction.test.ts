import { describe, expect, it } from 'vitest';
import {
  applyCorrectionDelta,
  correctionCurrentBalanceDelta,
  validateCorrectionOccurrenceDate,
} from '../src/index.js';

const currentSource = {
  kind: 'expense' as const,
  amountMinor: 300_000n,
  occurredOn: '2026-10-10',
  balanceEffect: 'current' as const,
  alreadyIncludedInSnapshot: false,
  balanceSnapshotId: 'snapshot-a',
  latestSnapshotId: 'snapshot-a',
  snapshotEffectiveLocalDate: '2026-10-08',
  nextSnapshotEffectiveLocalDate: null,
  currentLocalDate: '2026-10-12',
};

describe('snapshot correction invariants', () => {
  it('applies replacement minus source exactly once for a latest current expense', () => {
    const delta = correctionCurrentBalanceDelta(currentSource, 250_000n);
    expect(delta).toBe(50_000n);
    expect(applyCorrectionDelta(700_000n, delta)).toBe(750_000n);
  });

  it('reverses a standalone latest-current void and leaves closed/history changes at zero', () => {
    expect(correctionCurrentBalanceDelta(currentSource, null)).toBe(300_000n);
    expect(correctionCurrentBalanceDelta({
      ...currentSource,
      latestSnapshotId: 'snapshot-b',
    }, 250_000n)).toBe(0n);
    expect(correctionCurrentBalanceDelta({
      ...currentSource,
      balanceEffect: 'historical',
    }, 250_000n)).toBe(0n);
  });

  it('accepts dates that preserve the original segment and effect', () => {
    expect(validateCorrectionOccurrenceDate(currentSource, '2026-10-09')).toBe('2026-10-09');
    expect(validateCorrectionOccurrenceDate({
      ...currentSource,
      alreadyIncludedInSnapshot: true,
      balanceEffect: 'historical',
      occurredOn: '2026-10-07',
    }, '2026-10-06')).toBe('2026-10-06');
  });

  it('rejects cross-anchor, effect-changing, and ambiguous moved dates', () => {
    expect(() => validateCorrectionOccurrenceDate(currentSource, '2026-10-07')).toThrowError(
      expect.objectContaining({ code: 'FIN_CORRECTION_CROSS_SEGMENT_UNSUPPORTED' }),
    );
    expect(() => validateCorrectionOccurrenceDate({
      ...currentSource,
      latestSnapshotId: 'snapshot-b',
      nextSnapshotEffectiveLocalDate: '2026-10-11',
    }, '2026-10-11')).toThrowError(
      expect.objectContaining({ code: 'FIN_CORRECTION_CROSS_SEGMENT_UNSUPPORTED' }),
    );
  });

  it('allows an unchanged source date when a later snapshot shares that local date', () => {
    expect(validateCorrectionOccurrenceDate({
      ...currentSource,
      latestSnapshotId: 'snapshot-b',
      nextSnapshotEffectiveLocalDate: currentSource.occurredOn,
    }, currentSource.occurredOn)).toBe(currentSource.occurredOn);
  });
});
