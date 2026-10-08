import { assertLocalDate } from './dates.js';
import { FinancialError } from './errors.js';
import { classifyTransaction, type BalanceEffect, type TransactionKind } from './financial.js';
import { checkedAdd, checkedSubtract } from './money.js';

export interface CorrectionSourceFinancialFacts {
  readonly kind: TransactionKind;
  readonly amountMinor: bigint;
  readonly occurredOn: string;
  readonly balanceEffect: BalanceEffect;
  readonly alreadyIncludedInSnapshot: boolean;
  readonly balanceSnapshotId: string;
  readonly latestSnapshotId: string;
  readonly snapshotEffectiveLocalDate: string;
  readonly nextSnapshotEffectiveLocalDate: string | null;
  readonly currentLocalDate: string;
}

export function validateCorrectionOccurrenceDate(
  source: CorrectionSourceFinancialFacts,
  proposedOccurredOn: string,
): string {
  const occurredOn = assertLocalDate(proposedOccurredOn);
  const currentLocalDate = assertLocalDate(source.currentLocalDate);
  const snapshotDate = assertLocalDate(source.snapshotEffectiveLocalDate);
  const nextSnapshotDate = source.nextSnapshotEffectiveLocalDate === null
    ? null
    : assertLocalDate(source.nextSnapshotEffectiveLocalDate);

  if (occurredOn > currentLocalDate) throw crossSegmentError();

  let classification: ReturnType<typeof classifyTransaction>;
  try {
    classification = classifyTransaction({
      occurredOn,
      snapshotEffectiveLocalDate: snapshotDate,
      currentLocalDate,
      alreadyIncludedInSnapshot: source.alreadyIncludedInSnapshot,
    });
  } catch {
    throw crossSegmentError();
  }

  if (
    classification.balanceEffect !== source.balanceEffect
    || classification.alreadyIncludedInSnapshot !== source.alreadyIncludedInSnapshot
  ) {
    throw crossSegmentError();
  }

  // Date-only transaction facts cannot safely establish which side of a later
  // same-local-day snapshot instant a moved correction belongs to. An unchanged
  // date remains valid because it preserves the source's reviewed inclusion fact.
  if (
    source.balanceEffect === 'current'
    && nextSnapshotDate !== null
    && occurredOn !== source.occurredOn
    && occurredOn >= nextSnapshotDate
  ) {
    throw crossSegmentError();
  }

  return occurredOn;
}

export function correctionCurrentBalanceDelta(
  source: Pick<
    CorrectionSourceFinancialFacts,
    'amountMinor' | 'kind' | 'balanceEffect' | 'balanceSnapshotId' | 'latestSnapshotId'
  >,
  replacementAmountMinor: bigint | null,
): bigint {
  if (
    source.balanceSnapshotId !== source.latestSnapshotId
    || source.balanceEffect !== 'current'
  ) return 0n;

  const sourceSigned = signedAmount(source.kind, source.amountMinor);
  const replacementSigned = replacementAmountMinor === null
    ? 0n
    : signedAmount(source.kind, replacementAmountMinor);
  return checkedSubtract(replacementSigned, sourceSigned);
}

export function applyCorrectionDelta(currentBalanceMinor: bigint, deltaMinor: bigint): bigint {
  return checkedAdd(currentBalanceMinor, deltaMinor);
}

function signedAmount(kind: TransactionKind, amountMinor: bigint): bigint {
  return kind === 'income' ? amountMinor : -amountMinor;
}

function crossSegmentError(): FinancialError {
  return new FinancialError({
    code: 'FIN_CORRECTION_CROSS_SEGMENT_UNSUPPORTED',
    statusCode: 409,
    safeMessage: 'The correction must remain in the original snapshot segment and balance effect.',
  });
}
