import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  assertLocalDate,
  assertMoneyRange,
  classifyTransaction,
  localDateAt,
  parseDatabaseBigint,
  parsePositiveMinor,
  parseSignedMinor,
  unavailableError,
  validateTransactionClassification,
  validationError,
  type ExpenseClass,
  type TransactionKind,
} from '@kfin/domain';
import { digestCanonicalRequest } from './canonical.js';
import { AccountFinancialSerializer } from './serialization.js';

export interface CurrentBalanceView {
  readonly accountId: string;
  readonly currency: string;
  readonly financialStateVersion: string;
  readonly snapshot: {
    readonly id: string;
    readonly amountMinor: string;
    readonly effectiveAt: string;
    readonly effectiveLocalDate: string;
  };
  readonly postedCurrentIncomeMinor: string;
  readonly postedCurrentExpenseMinor: string;
  readonly currentBalanceMinor: string;
}

export interface CreateSnapshotInput {
  readonly amountMinor: string;
  readonly effectiveAt: string;
  readonly note?: string;
  readonly expectedFinancialStateVersion: string;
  readonly reviewedLatestSnapshotId: string;
}

export interface CreateSnapshotResult {
  readonly snapshotId: string;
  readonly financialStateVersion: string;
}

export interface CreateTransactionInput {
  readonly kind: TransactionKind;
  readonly amountMinor: string;
  readonly occurredOn: string;
  readonly categoryCode: string;
  readonly expenseClass?: ExpenseClass;
  readonly isUnexpected: boolean;
  readonly alreadyIncludedInSnapshot?: boolean;
  readonly note?: string;
  readonly expectedFinancialStateVersion: string;
  readonly reviewedLatestSnapshotId: string;
}

export interface TransactionView {
  readonly id: string;
  readonly kind: TransactionKind;
  readonly amountMinor: string;
  readonly currency: string;
  readonly occurredOn: string;
  readonly balanceEffect: 'current' | 'historical';
  readonly alreadyIncludedInSnapshot: boolean;
  readonly categoryCode: string;
  readonly expenseClass: ExpenseClass | null;
  readonly isUnexpected: boolean;
  readonly note: string | null;
  readonly status: 'posted' | 'voided';
  readonly balanceSnapshotId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: string;
}

export interface CreateTransactionResult {
  readonly transactionId: string;
  readonly financialStateVersion: string;
}

export interface TransactionPage {
  readonly items: TransactionView[];
  readonly nextCursor: string | null;
}

interface BalanceRow extends QueryResultRow {
  account_id: string;
  currency: string;
  financial_state_version: string;
  snapshot_id: string;
  snapshot_amount_minor: string;
  snapshot_effective_at: Date;
  snapshot_effective_local_date: string;
  posted_current_income_minor: string;
  posted_current_expense_minor: string;
  current_balance_minor: string;
}

interface CategoryRow extends QueryResultRow {
  id: string;
}

interface TransactionRow extends QueryResultRow {
  id: string;
  kind: TransactionKind;
  amount_minor: string;
  currency: string;
  occurred_on: string;
  balance_effect: 'current' | 'historical';
  already_included_in_snapshot: boolean;
  category_code: string;
  expense_class: ExpenseClass | null;
  is_unexpected: boolean;
  note: string | null;
  status: 'posted' | 'voided';
  balance_snapshot_id: string;
  created_at: Date;
  updated_at: Date;
  version: string;
}

export class PostgresFinancialRepository {
  private readonly serializer: AccountFinancialSerializer;

  constructor(
    private readonly pool: Pool,
    private readonly idempotencyRetentionMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.serializer = new AccountFinancialSerializer(pool, () => this.now().getTime());
  }

  async getCurrentBalance(ownerUserId: string): Promise<CurrentBalanceView> {
    const result = await this.pool.query<BalanceRow>(`
      SELECT account_id, currency, financial_state_version, snapshot_id,
             snapshot_amount_minor, snapshot_effective_at, snapshot_effective_local_date,
             posted_current_income_minor, posted_current_expense_minor, current_balance_minor
      FROM financial_current_balances
      WHERE user_id = $1
    `, [ownerUserId]);
    const row = result.rows[0];
    if (!row) throw unavailableError();

    const snapshotAmount = assertMoneyRange(parseDatabaseBigint(row.snapshot_amount_minor));
    const income = assertMoneyRange(parseDatabaseBigint(row.posted_current_income_minor));
    const expense = assertMoneyRange(parseDatabaseBigint(row.posted_current_expense_minor));
    const balance = assertMoneyRange(parseDatabaseBigint(row.current_balance_minor));
    return {
      accountId: row.account_id,
      currency: row.currency.trim(),
      financialStateVersion: parseDatabaseBigint(row.financial_state_version).toString(),
      snapshot: {
        id: row.snapshot_id,
        amountMinor: snapshotAmount.toString(),
        effectiveAt: asDate(row.snapshot_effective_at).toISOString(),
        effectiveLocalDate: row.snapshot_effective_local_date,
      },
      postedCurrentIncomeMinor: income.toString(),
      postedCurrentExpenseMinor: expense.toString(),
      currentBalanceMinor: balance.toString(),
    };
  }

  async createSnapshot(
    ownerUserId: string,
    input: CreateSnapshotInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CreateSnapshotResult> {
    const accountId = await this.resolveOwnedAccountId(ownerUserId);
    const amount = parseSignedMinor(input.amountMinor);
    const effectiveAt = new Date(input.effectiveAt);
    if (Number.isNaN(effectiveAt.getTime())) throw validationError('Snapshot time is invalid.');
    if (effectiveAt.getTime() > this.now().getTime()) {
      throw validationError('Manual balance snapshots cannot be future-dated.');
    }
    const snapshotId = randomUUID();
    const requestDigest = digestCanonicalRequest({
      amountMinor: amount,
      effectiveAt: effectiveAt.toISOString(),
      note: input.note,
      expectedFinancialStateVersion: input.expectedFinancialStateVersion,
      reviewedLatestSnapshotId: input.reviewedLatestSnapshotId,
    });

    const result = await this.serializer.execute({
      ownerUserId,
      accountId,
      operation: 'financial.snapshot.create',
      idempotencyKey,
      requestDigest,
      expectedFinancialStateVersion: BigInt(input.expectedFinancialStateVersion),
      reviewedLatestSnapshotId: input.reviewedLatestSnapshotId,
      staleCode: 'FIN_SNAPSHOT_STALE_STATE',
      successStatus: 201,
      correlationId,
      idempotencyRetentionMs: this.idempotencyRetentionMs,
      work: async ({ transaction, account, latestSnapshot, committedFinancialStateVersion }) => {
        const now = this.now();
        if (effectiveAt.getTime() > now.getTime()) {
          throw validationError('Manual balance snapshots cannot be future-dated.');
        }
        if (effectiveAt.getTime() <= latestSnapshot.effectiveAt.getTime()) {
          throw validationError('Manual balance snapshots must be later than the latest snapshot.');
        }
        await transaction.query(`
          INSERT INTO balance_snapshots (
            id, user_id, account_id, amount_minor, currency, effective_at,
            effective_local_date, timezone, reason, note, created_by_user_id, correlation_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                    'manual_balance_update', $9, $2, $10)
        `, [
          snapshotId,
          ownerUserId,
          accountId,
          amount.toString(),
          account.currency,
          effectiveAt,
          localDateAt(effectiveAt, latestSnapshot.timezone),
          latestSnapshot.timezone,
          input.note ?? null,
          correlationId,
        ]);
        return {
          value: {
            snapshotId,
            financialStateVersion: committedFinancialStateVersion.toString(),
          },
          audit: {
            action: 'financial.snapshot.create',
            resourceType: 'balance_snapshot',
            resourceId: snapshotId,
            metadata: { reason: 'manual_balance_update', priorSnapshotId: latestSnapshot.id },
          },
        };
      },
    });
    return {
      snapshotId: String(result.value.snapshotId),
      financialStateVersion: result.financialStateVersion.toString(),
    };
  }

  async createTransaction(
    ownerUserId: string,
    input: CreateTransactionInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CreateTransactionResult> {
    const accountId = await this.resolveOwnedAccountId(ownerUserId);
    const amount = parsePositiveMinor(input.amountMinor);
    const occurredOn = assertLocalDate(input.occurredOn);
    const expenseClass = validateTransactionClassification({
      kind: input.kind,
      ...(input.expenseClass === undefined ? {} : { expenseClass: input.expenseClass }),
      isUnexpected: input.isUnexpected,
    });
    const transactionId = randomUUID();
    const requestDigest = digestCanonicalRequest({
      kind: input.kind,
      amountMinor: amount,
      occurredOn,
      categoryCode: input.categoryCode,
      expenseClass,
      isUnexpected: input.isUnexpected,
      alreadyIncludedInSnapshot: input.alreadyIncludedInSnapshot,
      note: input.note,
      expectedFinancialStateVersion: input.expectedFinancialStateVersion,
      reviewedLatestSnapshotId: input.reviewedLatestSnapshotId,
    });

    const result = await this.serializer.execute({
      ownerUserId,
      accountId,
      operation: 'financial.transaction.create',
      idempotencyKey,
      requestDigest,
      expectedFinancialStateVersion: BigInt(input.expectedFinancialStateVersion),
      reviewedLatestSnapshotId: input.reviewedLatestSnapshotId,
      staleCode: 'FINANCIAL_STATE_STALE',
      successStatus: 201,
      correlationId,
      idempotencyRetentionMs: this.idempotencyRetentionMs,
      work: async ({ transaction, account, latestSnapshot, committedFinancialStateVersion }) => {
        const classification = classifyTransaction({
          occurredOn,
          snapshotEffectiveLocalDate: latestSnapshot.effectiveLocalDate,
          currentLocalDate: localDateAt(this.now(), latestSnapshot.timezone),
          ...(input.alreadyIncludedInSnapshot === undefined
            ? {}
            : { alreadyIncludedInSnapshot: input.alreadyIncludedInSnapshot }),
        });
        const categoryResult = await transaction.query<CategoryRow>(`
          SELECT id
          FROM categories
          WHERE code = $1 AND transaction_kind = $2 AND active = TRUE
            AND (owner_user_id IS NULL OR owner_user_id = $3)
        `, [input.categoryCode, input.kind, ownerUserId]);
        const category = categoryResult.rows[0];
        if (!category) throw validationError('Transaction category is invalid for this transaction type.');

        await transaction.query(`
          INSERT INTO transactions (
            id, user_id, account_id, balance_snapshot_id, kind, amount_minor,
            currency, occurred_on, balance_effect, already_included_in_snapshot,
            category_id, expense_class, is_unexpected, note
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `, [
          transactionId,
          ownerUserId,
          accountId,
          latestSnapshot.id,
          input.kind,
          amount.toString(),
          account.currency,
          occurredOn,
          classification.balanceEffect,
          classification.alreadyIncludedInSnapshot,
          category.id,
          expenseClass,
          input.isUnexpected,
          input.note ?? null,
        ]);
        return {
          value: {
            transactionId,
            financialStateVersion: committedFinancialStateVersion.toString(),
          },
          audit: {
            action: 'financial.transaction.create',
            resourceType: 'transaction',
            resourceId: transactionId,
            metadata: {
              kind: input.kind,
              balanceEffect: classification.balanceEffect,
              snapshotId: latestSnapshot.id,
            },
          },
        };
      },
    });
    return {
      transactionId: String(result.value.transactionId),
      financialStateVersion: result.financialStateVersion.toString(),
    };
  }

  async getTransaction(ownerUserId: string, transactionId: string): Promise<TransactionView> {
    const result = await this.pool.query<TransactionRow>(`${transactionSelect}
      WHERE txn.user_id = $1 AND txn.id = $2
    `, [ownerUserId, transactionId]);
    const row = result.rows[0];
    if (!row) throw unavailableError();
    return mapTransaction(row);
  }

  async listTransactions(
    ownerUserId: string,
    options: { readonly limit: number; readonly cursor?: string },
  ): Promise<TransactionPage> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw validationError('Transaction page limit must be between 1 and 100.');
    }
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    const values: unknown[] = [ownerUserId];
    let cursorClause = '';
    if (cursor) {
      values.push(cursor.occurredOn, cursor.id);
      cursorClause = 'AND (txn.occurred_on, txn.id) < ($2::date, $3::uuid)';
    }
    values.push(options.limit + 1);
    const limitParameter = `$${values.length}`;
    const result = await this.pool.query<TransactionRow>(`${transactionSelect}
      WHERE txn.user_id = $1
      ${cursorClause}
      ORDER BY txn.occurred_on DESC, txn.id DESC
      LIMIT ${limitParameter}
    `, values);
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const items = rows.map(mapTransaction);
    const last = rows.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.occurred_on, last.id) : null,
    };
  }

  private async resolveOwnedAccountId(ownerUserId: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      'SELECT id FROM financial_accounts WHERE user_id = $1',
      [ownerUserId],
    );
    const account = result.rows[0];
    if (!account) throw unavailableError();
    return account.id;
  }
}

const transactionSelect = `
  SELECT txn.id, txn.kind, txn.amount_minor, txn.currency,
         txn.occurred_on, txn.balance_effect,
         txn.already_included_in_snapshot, category.code AS category_code,
         txn.expense_class, txn.is_unexpected, txn.note,
         txn.status, txn.balance_snapshot_id,
         txn.created_at, txn.updated_at, txn.version
  FROM transactions AS txn
  JOIN categories AS category ON category.id = txn.category_id
`;

function mapTransaction(row: TransactionRow | undefined): TransactionView {
  if (!row) throw new Error('Expected one inserted transaction row.');
  return {
    id: row.id,
    kind: row.kind,
    amountMinor: parseDatabaseBigint(row.amount_minor).toString(),
    currency: row.currency.trim(),
    occurredOn: row.occurred_on,
    balanceEffect: row.balance_effect,
    alreadyIncludedInSnapshot: row.already_included_in_snapshot,
    categoryCode: row.category_code,
    expenseClass: row.expense_class,
    isUnexpected: row.is_unexpected,
    note: row.note,
    status: row.status,
    balanceSnapshotId: row.balance_snapshot_id,
    createdAt: asDate(row.created_at).toISOString(),
    updatedAt: asDate(row.updated_at).toISOString(),
    version: parseDatabaseBigint(row.version).toString(),
  };
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function encodeCursor(occurredOn: string, id: string): string {
  return Buffer.from(JSON.stringify({ occurredOn, id }), 'utf8').toString('base64url');
}

function decodeCursor(value: string): { occurredOn: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid cursor');
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.occurredOn !== 'string'
      || typeof candidate.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.id)
    ) throw new Error('invalid cursor');
    return { occurredOn: assertLocalDate(candidate.occurredOn), id: candidate.id };
  } catch (error) {
    throw validationError('Transaction cursor is invalid.');
  }
}
