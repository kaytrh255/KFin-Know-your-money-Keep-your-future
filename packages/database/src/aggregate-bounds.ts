import type { Pool, QueryResult, QueryResultRow } from 'pg';
import {
  assertMoneyRange,
  checkedAdd,
  checkedSubtract,
  monthBounds,
  parseDatabaseBigint,
  type BalanceEffect,
  type TransactionKind,
} from '@kfin/domain';
import type { BoundedTransaction } from './serialization.js';

type AggregateQueryable = Pick<Pool, 'query'> | BoundedTransaction;

interface CurrentAggregateRow extends QueryResultRow {
  snapshot_amount_minor: string;
  posted_current_income_minor: string;
  posted_current_expense_minor: string;
  current_balance_minor: string;
}

interface MonthlyAggregateRow extends QueryResultRow {
  kind: TransactionKind;
  amount_minor: string;
}

export interface CurrentAggregateState {
  snapshotAmount: bigint;
  income: bigint;
  expense: bigint;
  balance: bigint;
}

interface MonthlyAggregateState {
  income: bigint;
  expense: bigint;
}

export interface CorrectionAggregateProjection {
  readonly source: {
    readonly kind: TransactionKind;
    readonly amount: bigint;
    readonly occurredOn: string;
    readonly balanceEffect: BalanceEffect;
    readonly balanceSnapshotId: string;
  };
  readonly latestSnapshotId: string;
  readonly replacement: {
    readonly amount: bigint;
    readonly occurredOn: string;
  } | null;
}

export async function loadCurrentAggregateState(
  queryable: AggregateQueryable,
  ownerUserId: string,
  accountId: string,
): Promise<CurrentAggregateState> {
  const result = await run<CurrentAggregateRow>(queryable, `
    SELECT snapshot_amount_minor, posted_current_income_minor,
           posted_current_expense_minor, current_balance_minor
    FROM financial_current_balances
    WHERE user_id = $1 AND account_id = $2
  `, [ownerUserId, accountId]);
  const row = result.rows[0];
  if (!row) {
    throw new Error('Locked financial account has no current-balance aggregate.');
  }
  return assertCurrentState({
    snapshotAmount: parseDatabaseBigint(row.snapshot_amount_minor),
    income: parseDatabaseBigint(row.posted_current_income_minor),
    expense: parseDatabaseBigint(row.posted_current_expense_minor),
    balance: parseDatabaseBigint(row.current_balance_minor),
  });
}

export async function assertFinancialAggregateBounds(
  queryable: AggregateQueryable,
  ownerUserId: string,
  accountId: string,
  months: readonly string[],
): Promise<void> {
  await loadCurrentAggregateState(queryable, ownerUserId, accountId);
  for (const month of new Set(months)) {
    assertMonthlyState(await loadMonthlyState(queryable, ownerUserId, accountId, month));
  }
}

export async function assertCorrectionAggregateProjection(
  queryable: AggregateQueryable,
  ownerUserId: string,
  accountId: string,
  projection: CorrectionAggregateProjection,
): Promise<CurrentAggregateState> {
  const current = await loadCurrentAggregateState(queryable, ownerUserId, accountId);
  if (
    projection.source.balanceEffect === 'current'
    && projection.source.balanceSnapshotId === projection.latestSnapshotId
  ) {
    if (projection.source.kind === 'income') {
      current.income = checkedSubtract(current.income, projection.source.amount);
    } else {
      current.expense = checkedSubtract(current.expense, projection.source.amount);
    }
    if (projection.replacement) {
      if (projection.source.kind === 'income') {
        current.income = checkedAdd(current.income, projection.replacement.amount);
      } else {
        current.expense = checkedAdd(current.expense, projection.replacement.amount);
      }
    }
    assertCurrentState(current);
  }

  const sourceMonth = projection.source.occurredOn.slice(0, 7);
  const replacementMonth = projection.replacement?.occurredOn.slice(0, 7);
  const months = [...new Set([sourceMonth, replacementMonth].filter((value): value is string => Boolean(value)))];
  for (const month of months) {
    const state = await loadMonthlyState(queryable, ownerUserId, accountId, month);
    if (month === sourceMonth) {
      if (projection.source.kind === 'income') {
        state.income = checkedSubtract(state.income, projection.source.amount);
      } else {
        state.expense = checkedSubtract(state.expense, projection.source.amount);
      }
    }
    if (projection.replacement && month === replacementMonth) {
      if (projection.source.kind === 'income') {
        state.income = checkedAdd(state.income, projection.replacement.amount);
      } else {
        state.expense = checkedAdd(state.expense, projection.replacement.amount);
      }
    }
    assertMonthlyState(state);
  }
  return assertCurrentState(current);
}

async function loadMonthlyState(
  queryable: AggregateQueryable,
  ownerUserId: string,
  accountId: string,
  month: string,
): Promise<MonthlyAggregateState> {
  const bounds = monthBounds(month);
  const result = await run<MonthlyAggregateRow>(queryable, `
    SELECT kind, COALESCE(SUM(amount_minor), 0)::text AS amount_minor
    FROM transactions
    WHERE user_id = $1 AND account_id = $2 AND status = 'posted'
      AND occurred_on >= $3::date AND occurred_on < $4::date
    GROUP BY kind
  `, [ownerUserId, accountId, bounds.start, bounds.end]);
  const state: MonthlyAggregateState = { income: 0n, expense: 0n };
  for (const row of result.rows) state[row.kind] = parseDatabaseBigint(row.amount_minor);
  return state;
}

function assertCurrentState(state: CurrentAggregateState): CurrentAggregateState {
  assertMoneyRange(state.snapshotAmount);
  assertMoneyRange(state.income);
  assertMoneyRange(state.expense);
  assertMoneyRange(state.balance);
  assertMoneyRange(checkedSubtract(checkedAdd(state.snapshotAmount, state.income), state.expense));
  return state;
}

function assertMonthlyState(state: MonthlyAggregateState): void {
  assertMoneyRange(state.income);
  assertMoneyRange(state.expense);
  assertMoneyRange(checkedSubtract(state.income, state.expense));
}

async function run<Row extends QueryResultRow>(
  queryable: AggregateQueryable,
  text: string,
  values: readonly unknown[],
): Promise<QueryResult<Row>> {
  if ('remainingMs' in queryable) return queryable.query<Row>(text, values);
  return queryable.query<Row>(text, [...values]);
}
