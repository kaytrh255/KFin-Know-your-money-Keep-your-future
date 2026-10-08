import { validationError } from './errors.js';
import { assertLocalDate } from './dates.js';
import { checkedAdd, checkedSubtract } from './money.js';

export type TransactionKind = 'income' | 'expense';
export type BalanceEffect = 'current' | 'historical';
export type ExpenseClass = 'essential_fixed' | 'essential_variable' | 'daily';

export interface TransactionClassificationInput {
  readonly occurredOn: string;
  readonly snapshotEffectiveLocalDate: string;
  readonly currentLocalDate: string;
  readonly alreadyIncludedInSnapshot?: boolean;
}

export interface TransactionClassification {
  readonly balanceEffect: BalanceEffect;
  readonly alreadyIncludedInSnapshot: boolean;
}

export function classifyTransaction(
  input: TransactionClassificationInput,
): TransactionClassification {
  const occurredOn = assertLocalDate(input.occurredOn);
  const snapshotDate = assertLocalDate(input.snapshotEffectiveLocalDate);
  const currentDate = assertLocalDate(input.currentLocalDate);

  if (occurredOn > currentDate) {
    throw validationError('Posted transactions cannot have a future occurrence date.');
  }

  if (occurredOn < snapshotDate) {
    if (input.alreadyIncludedInSnapshot === false) {
      throw validationError('A pre-snapshot transaction must be recorded as already included.');
    }
    return { balanceEffect: 'historical', alreadyIncludedInSnapshot: true };
  }

  if (occurredOn > snapshotDate) {
    if (input.alreadyIncludedInSnapshot === true) {
      throw validationError('A post-snapshot transaction cannot be recorded as already included.');
    }
    return { balanceEffect: 'current', alreadyIncludedInSnapshot: false };
  }

  if (input.alreadyIncludedInSnapshot === undefined) {
    throw validationError('Same-day transactions require an explicit snapshot-inclusion choice.');
  }
  return input.alreadyIncludedInSnapshot
    ? { balanceEffect: 'historical', alreadyIncludedInSnapshot: true }
    : { balanceEffect: 'current', alreadyIncludedInSnapshot: false };
}

export interface TransactionBalanceFact {
  readonly amountMinor: bigint;
  readonly kind: TransactionKind;
  readonly balanceEffect: BalanceEffect;
  readonly status: 'posted' | 'voided';
  readonly balanceSnapshotId: string;
}

export function calculateCurrentBalance(
  snapshotId: string,
  anchorAmountMinor: bigint,
  transactions: readonly TransactionBalanceFact[],
): bigint {
  let result = anchorAmountMinor;
  for (const transaction of transactions) {
    if (
      transaction.balanceSnapshotId !== snapshotId
      || transaction.status !== 'posted'
      || transaction.balanceEffect !== 'current'
    ) continue;
    result = transaction.kind === 'income'
      ? checkedAdd(result, transaction.amountMinor)
      : checkedSubtract(result, transaction.amountMinor);
  }
  return result;
}

export function validateTransactionClassification(input: {
  readonly kind: TransactionKind;
  readonly expenseClass?: ExpenseClass;
  readonly isUnexpected: boolean;
}): ExpenseClass | null {
  if (input.kind === 'income') {
    if (input.expenseClass !== undefined || input.isUnexpected) {
      throw validationError('Income cannot carry expense classification or an unexpected flag.');
    }
    return null;
  }
  if (input.expenseClass === undefined) {
    throw validationError('Expense classification is required.');
  }
  return input.expenseClass;
}
