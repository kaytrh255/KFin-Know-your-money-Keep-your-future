import { assertLocalDate, localDateAt } from './dates.js';
import { FinancialError } from './errors.js';
import { assertMoneyRange } from './money.js';

/**
 * Savings goals (PRD-SAV-01..07, DATABASE §9). A goal's current amount is a
 * user-declared absolute reserve estimate, never a cash ledger: nothing here
 * reads or writes the account balance or monthly actuals.
 */

export const CONTRIBUTION_FREQUENCIES = ['weekly', 'monthly', 'yearly'] as const;
export type ContributionFrequency = (typeof CONTRIBUTION_FREQUENCIES)[number];
export type SavingsGoalStatus = 'active' | 'archived';

const NON_NEGATIVE_MINOR_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;
const POSITIVE_MINOR_PATTERN = /^[1-9][0-9]{0,18}$/;
export const SAVINGS_GOAL_NAME_MAX = 120;
export const SAVINGS_REASON_MAX = 500;

export function savingsGoalInvalid(message: string): FinancialError {
  return new FinancialError({ code: 'SAVINGS_GOAL_INVALID', statusCode: 422, safeMessage: message });
}

export function savingsGoalVersionConflict(): FinancialError {
  return new FinancialError({
    code: 'SAVINGS_GOAL_VERSION_CONFLICT',
    statusCode: 409,
    safeMessage: 'The savings goal changed since it was reviewed. Reload it and try again.',
  });
}

export function savingsGoalArchived(): FinancialError {
  return new FinancialError({
    code: 'SAVINGS_GOAL_ARCHIVED',
    statusCode: 409,
    safeMessage: 'The savings goal is archived and can no longer be changed.',
  });
}

/** `0` or a positive integer minor-unit string inside the PostgreSQL BIGINT range. */
export function parseNonNegativeSavingsMinor(value: string, field: string): bigint {
  if (!NON_NEGATIVE_MINOR_PATTERN.test(value)) {
    throw savingsGoalInvalid(`${field} must be a non-negative integer minor-unit string.`);
  }
  return assertSavingsRange(BigInt(value), field);
}

/** A strictly positive integer minor-unit string inside the PostgreSQL BIGINT range. */
export function parsePositiveSavingsMinor(value: string, field: string): bigint {
  if (!POSITIVE_MINOR_PATTERN.test(value)) {
    throw savingsGoalInvalid(`${field} must be a positive integer minor-unit string.`);
  }
  return assertSavingsRange(BigInt(value), field);
}

function assertSavingsRange(value: bigint, field: string): bigint {
  try {
    return assertMoneyRange(value);
  } catch {
    throw savingsGoalInvalid(`${field} is outside the supported range.`);
  }
}

export function normalizeSavingsGoalName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > SAVINGS_GOAL_NAME_MAX) {
    throw savingsGoalInvalid(`Goal name must be 1-${SAVINGS_GOAL_NAME_MAX} characters.`);
  }
  return assertSavingsTextStorable(name, 'Goal name');
}

export function normalizeSavingsReason(value: string | undefined): string | null {
  if (value === undefined) return null;
  const reason = value.trim();
  if (reason.length < 1 || reason.length > SAVINGS_REASON_MAX) {
    throw savingsGoalInvalid(`Reason must be 1-${SAVINGS_REASON_MAX} characters.`);
  }
  return assertSavingsTextStorable(reason, 'Reason');
}

/**
 * QA F-1: PostgreSQL TEXT cannot store the NUL character (U+0000) — the server
 * raises SQLSTATE 22021. Reject it here as invalid input (422) instead of
 * letting it surface as a database outage (503 FIN_DATABASE_UNAVAILABLE).
 */
function assertSavingsTextStorable(value: string, field: string): string {
  if (value.includes('\u0000')) {
    throw savingsGoalInvalid(`${field} must not contain NUL characters.`);
  }
  return value;
}

export function assertSavingsLocalDate(value: string, field: string): string {
  try {
    return assertLocalDate(value);
  } catch {
    throw savingsGoalInvalid(`${field} must be a real calendar date in YYYY-MM-DD form.`);
  }
}

/** PRD-SAV-02/03: the as-of date of a declared amount cannot be in the user's local future. */
export function assertAsOfNotFuture(asOf: string, now: Date, timezone: string): string {
  assertSavingsLocalDate(asOf, 'As-of date');
  if (asOf > localDateAt(now, timezone)) {
    throw savingsGoalInvalid('As-of date cannot be in the future.');
  }
  return asOf;
}

export function assertContributionPlan(
  plannedContributionMinor: bigint | null,
  frequency: ContributionFrequency | null,
): void {
  if (frequency !== null && plannedContributionMinor === null) {
    throw savingsGoalInvalid('A contribution cadence requires a planned contribution amount.');
  }
}

export interface SavingsProgress {
  /** floor(current × 10 000 ÷ target); may exceed 10 000 when over target. */
  readonly percentBasisPoints: string;
  readonly achieved: boolean;
  readonly overTarget: boolean;
  readonly remainingMinor: string;
}

/**
 * Derived, never stored (PRD-SAV-05). Achieving or exceeding the target does
 * not archive the goal (PRD-SAV-07).
 */
export function computeSavingsProgress(currentMinor: bigint, targetMinor: bigint): SavingsProgress {
  if (targetMinor <= 0n || currentMinor < 0n) {
    throw savingsGoalInvalid('Savings goal amounts are invalid.');
  }
  const remaining = targetMinor - currentMinor;
  return {
    percentBasisPoints: ((currentMinor * 10_000n) / targetMinor).toString(),
    achieved: currentMinor >= targetMinor,
    overTarget: currentMinor > targetMinor,
    remainingMinor: (remaining > 0n ? remaining : 0n).toString(),
  };
}

/**
 * The savings-reserve term of safe-to-spend (FORMULAS / TEST-STRATEGY
 * STS-09/10): the sum of current amounts of active goals only.
 */
export function activeSavingsReserveMinor(
  goals: readonly { readonly status: SavingsGoalStatus; readonly currentAmountMinor: bigint }[],
): bigint {
  let total = 0n;
  for (const goal of goals) {
    if (goal.status === 'active') total = assertMoneyRange(total + goal.currentAmountMinor);
  }
  return total;
}
