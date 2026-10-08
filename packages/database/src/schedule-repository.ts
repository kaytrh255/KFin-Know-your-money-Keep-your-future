import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  assertLocalDate,
  classifyTransaction,
  deriveOccurrencePresentation,
  FinancialError,
  localDateAt,
  parseDatabaseBigint,
  parsePositiveMinor,
  unavailableError,
  validateTransactionClassification,
  validationError,
  type ExpenseClass,
  type OccurrenceDirection,
  type OccurrenceState,
  type TransactionKind,
} from '@kfin/domain';
import { assertFinancialAggregateBounds } from './aggregate-bounds.js';
import { digestCanonicalRequest } from './canonical.js';
import {
  AccountFinancialSerializer,
  StableIdempotentFinancialError,
  type BoundedTransaction,
} from './serialization.js';

export interface CreateOneOffScheduleInput {
  readonly title: string;
  readonly kind: TransactionKind;
  readonly expectedAmountMinor: string;
  readonly dueOn: string;
  readonly categoryCode: string;
  readonly expenseClass?: ExpenseClass;
  readonly expectedFinancialStateVersion: string;
  readonly reviewedLatestSnapshotId: string;
}

export interface CreateOneOffScheduleResult {
  readonly scheduledItemId: string;
  readonly occurrenceId: string;
  readonly financialStateVersion: string;
}

export interface OccurrenceView {
  readonly id: string;
  readonly scheduledItemId: string;
  readonly title: string;
  readonly kind: TransactionKind;
  readonly direction: OccurrenceDirection;
  readonly expectedAmountMinor: string;
  readonly currency: string;
  readonly dueOn: string;
  readonly categoryCode: string;
  readonly expenseClass: ExpenseClass | null;
  readonly state: OccurrenceState;
  readonly presentation:
    | 'upcoming'
    | 'due_today'
    | 'overdue'
    | 'projected'
    | 'paid'
    | 'received'
    | 'skipped'
    | 'cancelled';
  readonly confirmedTransactionId: string | null;
  readonly confirmedAt: string | null;
  readonly skippedAt: string | null;
  readonly skipReason: string | null;
  readonly cancelledAt: string | null;
  readonly version: string;
}

export interface ConfirmOccurrenceInput {
  readonly amountMinor: string;
  readonly occurredOn: string;
  readonly categoryCode: string;
  readonly expenseClass?: ExpenseClass;
  readonly isUnexpected: boolean;
  readonly alreadyIncludedInSnapshot?: boolean;
  readonly note?: string;
  readonly expectedFinancialStateVersion: string;
  readonly reviewedLatestSnapshotId: string;
  readonly reviewedOccurrenceVersion: string;
}

export interface ConfirmOccurrenceResult {
  readonly occurrenceId: string;
  readonly transactionId: string;
  readonly state: 'confirmed';
  readonly financialStateVersion: string;
  readonly occurrenceVersion: string;
}

export interface TransitionOccurrenceInput {
  readonly reason: string;
  readonly expectedFinancialStateVersion: string;
  readonly reviewedLatestSnapshotId: string;
  readonly reviewedOccurrenceVersion: string;
}

export interface TransitionOccurrenceResult {
  readonly occurrenceId: string;
  readonly state: 'skipped' | 'cancelled';
  readonly financialStateVersion: string;
  readonly occurrenceVersion: string;
}

interface OccurrenceRow extends QueryResultRow {
  id: string;
  scheduled_item_id: string;
  account_id: string;
  title: string;
  transaction_kind: TransactionKind;
  expected_amount_minor: string;
  currency: string;
  due_on: string;
  category_id: string;
  category_code: string;
  expense_class: ExpenseClass | null;
  state: OccurrenceState;
  confirmed_transaction_id: string | null;
  confirmed_at: Date | null;
  skipped_at: Date | null;
  skip_reason: string | null;
  cancelled_at: Date | null;
  timezone: string;
  version: string;
}

interface CategoryRow extends QueryResultRow {
  id: string;
}

export class PostgresScheduleRepository {
  private readonly serializer: AccountFinancialSerializer;

  constructor(
    private readonly pool: Pool,
    private readonly idempotencyRetentionMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.serializer = new AccountFinancialSerializer(pool, () => this.now().getTime());
  }

  async createOneOff(
    ownerUserId: string,
    input: CreateOneOffScheduleInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CreateOneOffScheduleResult> {
    const accountId = await this.resolveOwnedAccountId(ownerUserId);
    const title = input.title.trim();
    if (title.length < 1 || title.length > 120) {
      throw validationError('Schedule title must be between 1 and 120 characters.');
    }
    const expectedAmount = parsePositiveMinor(input.expectedAmountMinor);
    const dueOn = assertLocalDate(input.dueOn);
    if (input.expenseClass === 'daily') {
      throw validationError('A scheduled essential expense cannot use the daily expense class.');
    }
    const expenseClass = validateTransactionClassification({
      kind: input.kind,
      ...(input.expenseClass === undefined ? {} : { expenseClass: input.expenseClass }),
      isUnexpected: false,
    });
    const scheduledItemId = randomUUID();
    const occurrenceId = randomUUID();
    const requestDigest = digestCanonicalRequest({
      title,
      kind: input.kind,
      expectedAmount,
      dueOn,
      categoryCode: input.categoryCode,
      expenseClass,
      expectedFinancialStateVersion: input.expectedFinancialStateVersion,
      reviewedLatestSnapshotId: input.reviewedLatestSnapshotId,
    });

    const result = await this.serializer.execute({
      ownerUserId,
      accountId,
      operation: 'schedule.one_off.create',
      idempotencyKey,
      requestDigest,
      expectedFinancialStateVersion: BigInt(input.expectedFinancialStateVersion),
      reviewedLatestSnapshotId: input.reviewedLatestSnapshotId,
      staleCode: 'FINANCIAL_STATE_STALE',
      successStatus: 201,
      correlationId,
      idempotencyRetentionMs: this.idempotencyRetentionMs,
      work: async ({ transaction, account, latestSnapshot, committedFinancialStateVersion }) => {
        const category = await resolveCategory(
          transaction,
          ownerUserId,
          input.categoryCode,
          input.kind,
        );
        await transaction.query(`
          INSERT INTO scheduled_items (
            id, user_id, account_id, kind, transaction_kind, title,
            expected_amount_minor, currency, category_id, expense_class,
            frequency, recurrence_interval, start_on, timezone, confirmation_policy
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    'one_off', 1, $11, $12, 'explicit')
        `, [
          scheduledItemId,
          ownerUserId,
          accountId,
          input.kind === 'income' ? 'income' : 'essential_expense',
          input.kind,
          title,
          expectedAmount.toString(),
          account.currency,
          category.id,
          expenseClass,
          dueOn,
          account.timezone,
        ]);
        await transaction.query(`
          INSERT INTO scheduled_occurrences (
            id, user_id, account_id, scheduled_item_id, transaction_kind,
            due_on, expected_amount_minor, currency
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          occurrenceId,
          ownerUserId,
          accountId,
          scheduledItemId,
          input.kind,
          dueOn,
          expectedAmount.toString(),
          account.currency,
        ]);
        return {
          value: {
            scheduledItemId,
            occurrenceId,
            financialStateVersion: committedFinancialStateVersion.toString(),
          },
          audit: {
            action: 'schedule.one_off.create',
            resourceType: 'scheduled_occurrence',
            resourceId: occurrenceId,
            metadata: {
              scheduledItemId,
              direction: directionOf(input.kind),
              dueOn,
              frequency: 'one_off',
              confirmationPolicy: 'explicit',
            },
          },
        };
      },
    });

    return {
      scheduledItemId: String(result.value.scheduledItemId),
      occurrenceId: String(result.value.occurrenceId),
      financialStateVersion: result.financialStateVersion.toString(),
    };
  }

  async getOccurrence(ownerUserId: string, occurrenceId: string): Promise<OccurrenceView> {
    const result = await this.pool.query<OccurrenceRow>(`${occurrenceSelect}
      WHERE occurrence.user_id = $1 AND occurrence.id = $2
    `, [ownerUserId, occurrenceId]);
    const row = result.rows[0];
    if (!row) throw unavailableError();
    return this.mapOccurrence(row);
  }

  async listOccurrences(
    ownerUserId: string,
    options: {
      readonly state?: OccurrenceState;
      readonly kind?: TransactionKind;
      readonly limit: number;
      readonly cursor?: string;
    },
  ): Promise<{ readonly items: OccurrenceView[]; readonly nextCursor: string | null }> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw validationError('Occurrence page limit must be between 1 and 100.');
    }
    const values: unknown[] = [ownerUserId];
    const filters: string[] = [];
    if (options.state !== undefined) {
      values.push(options.state);
      filters.push(`occurrence.state = $${values.length}`);
    }
    if (options.kind !== undefined) {
      values.push(options.kind);
      filters.push(`occurrence.transaction_kind = $${values.length}`);
    }
    const cursor = options.cursor ? decodeOccurrenceCursor(options.cursor) : null;
    if (cursor) {
      values.push(cursor.dueOn, cursor.id);
      filters.push(`(occurrence.due_on, occurrence.id) > ($${values.length - 1}::date, $${values.length}::uuid)`);
    }
    values.push(options.limit + 1);
    const result = await this.pool.query<OccurrenceRow>(`${occurrenceSelect}
      WHERE occurrence.user_id = $1
      ${filters.length === 0 ? '' : `AND ${filters.join(' AND ')}`}
      ORDER BY occurrence.due_on ASC, occurrence.id ASC
      LIMIT $${values.length}
    `, values);
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => this.mapOccurrence(row)),
      nextCursor: hasMore && last ? encodeOccurrenceCursor(last.due_on, last.id) : null,
    };
  }

  async confirmOccurrence(
    ownerUserId: string,
    occurrenceId: string,
    input: ConfirmOccurrenceInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<ConfirmOccurrenceResult> {
    const accountId = await this.resolveOwnedOccurrenceAccount(ownerUserId, occurrenceId);
    const amount = parsePositiveMinor(input.amountMinor);
    const occurredOn = assertLocalDate(input.occurredOn);
    const transactionId = randomUUID();
    const requestDigest = digestCanonicalRequest({ occurrenceId, ...input });

    const result = await this.serializer.execute({
      ownerUserId,
      accountId,
      operation: 'schedule.occurrence.confirm',
      idempotencyKey,
      requestDigest,
      expectedFinancialStateVersion: BigInt(input.expectedFinancialStateVersion),
      reviewedLatestSnapshotId: input.reviewedLatestSnapshotId,
      staleCode: 'FINANCIAL_STATE_STALE',
      successStatus: 201,
      correlationId,
      idempotencyRetentionMs: this.idempotencyRetentionMs,
      work: async ({ transaction, account, latestSnapshot, committedFinancialStateVersion }) => {
        const occurrence = await lockOccurrence(transaction, ownerUserId, accountId, occurrenceId);
        assertReviewedScheduled(occurrence, input.reviewedOccurrenceVersion);
        const expenseClass = validateTransactionClassification({
          kind: occurrence.transaction_kind,
          ...(input.expenseClass === undefined ? {} : { expenseClass: input.expenseClass }),
          isUnexpected: input.isUnexpected,
        });
        const category = await resolveCategory(
          transaction,
          ownerUserId,
          input.categoryCode,
          occurrence.transaction_kind,
        );
        const classification = classifyTransaction({
          occurredOn,
          snapshotEffectiveLocalDate: latestSnapshot.effectiveLocalDate,
          currentLocalDate: localDateAt(this.now(), account.timezone),
          ...(input.alreadyIncludedInSnapshot === undefined
            ? {}
            : { alreadyIncludedInSnapshot: input.alreadyIncludedInSnapshot }),
        });
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
          occurrence.transaction_kind,
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
        const updated = await transaction.query(`
          UPDATE scheduled_occurrences
          SET state = 'confirmed', confirmed_transaction_id = $4,
              confirmed_at = clock_timestamp(), updated_at = clock_timestamp(),
              version = version + 1
          WHERE user_id = $1 AND account_id = $2 AND id = $3
            AND state = 'scheduled' AND version = $5
        `, [ownerUserId, accountId, occurrenceId, transactionId, occurrence.version]);
        if (updated.rowCount !== 1) throw new StableIdempotentFinancialError(occurrenceStaleError());
        await assertFinancialAggregateBounds(
          transaction,
          ownerUserId,
          accountId,
          [occurredOn.slice(0, 7)],
        );
        const occurrenceVersion = (parseDatabaseBigint(occurrence.version) + 1n).toString();
        return {
          value: {
            occurrenceId,
            transactionId,
            state: 'confirmed',
            financialStateVersion: committedFinancialStateVersion.toString(),
            occurrenceVersion,
          },
          audit: {
            action: 'schedule.occurrence.confirm',
            resourceType: 'scheduled_occurrence',
            resourceId: occurrenceId,
            metadata: {
              transactionId,
              persistedState: 'confirmed',
              direction: directionOf(occurrence.transaction_kind),
              balanceEffect: classification.balanceEffect,
              snapshotId: latestSnapshot.id,
            },
          },
        };
      },
    });

    return {
      occurrenceId: String(result.value.occurrenceId),
      transactionId: String(result.value.transactionId),
      state: 'confirmed',
      financialStateVersion: result.financialStateVersion.toString(),
      occurrenceVersion: String(result.value.occurrenceVersion),
    };
  }

  async transitionOccurrence(
    ownerUserId: string,
    occurrenceId: string,
    targetState: 'skipped' | 'cancelled',
    input: TransitionOccurrenceInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<TransitionOccurrenceResult> {
    const accountId = await this.resolveOwnedOccurrenceAccount(ownerUserId, occurrenceId);
    const reason = input.reason.trim();
    if (reason.length < 1 || reason.length > 1_000) {
      throw validationError('A transition reason between 1 and 1000 characters is required.');
    }
    const requestDigest = digestCanonicalRequest({ occurrenceId, targetState, ...input, reason });
    const operation = `schedule.occurrence.${targetState === 'skipped' ? 'skip' : 'cancel'}`;

    const result = await this.serializer.execute({
      ownerUserId,
      accountId,
      operation,
      idempotencyKey,
      requestDigest,
      expectedFinancialStateVersion: BigInt(input.expectedFinancialStateVersion),
      reviewedLatestSnapshotId: input.reviewedLatestSnapshotId,
      staleCode: 'FINANCIAL_STATE_STALE',
      successStatus: 200,
      correlationId,
      idempotencyRetentionMs: this.idempotencyRetentionMs,
      work: async ({ transaction, committedFinancialStateVersion }) => {
        const occurrence = await lockOccurrence(transaction, ownerUserId, accountId, occurrenceId);
        assertReviewedScheduled(occurrence, input.reviewedOccurrenceVersion);
        const updated = targetState === 'skipped'
          ? await transaction.query(`
              UPDATE scheduled_occurrences
              SET state = 'skipped', skipped_at = clock_timestamp(), skip_reason = $4,
                  updated_at = clock_timestamp(), version = version + 1
              WHERE user_id = $1 AND account_id = $2 AND id = $3
                AND state = 'scheduled' AND version = $5
            `, [ownerUserId, accountId, occurrenceId, reason, occurrence.version])
          : await transaction.query(`
              UPDATE scheduled_occurrences
              SET state = 'cancelled', cancelled_at = clock_timestamp(),
                  updated_at = clock_timestamp(), version = version + 1
              WHERE user_id = $1 AND account_id = $2 AND id = $3
                AND state = 'scheduled' AND version = $4
            `, [ownerUserId, accountId, occurrenceId, occurrence.version]);
        if (updated.rowCount !== 1) throw new StableIdempotentFinancialError(occurrenceStaleError());
        const occurrenceVersion = (parseDatabaseBigint(occurrence.version) + 1n).toString();
        return {
          value: {
            occurrenceId,
            state: targetState,
            financialStateVersion: committedFinancialStateVersion.toString(),
            occurrenceVersion,
          },
          audit: {
            action: operation,
            resourceType: 'scheduled_occurrence',
            resourceId: occurrenceId,
            metadata: { persistedState: targetState, reason },
          },
        };
      },
    });

    return {
      occurrenceId: String(result.value.occurrenceId),
      state: targetState,
      financialStateVersion: result.financialStateVersion.toString(),
      occurrenceVersion: String(result.value.occurrenceVersion),
    };
  }

  private mapOccurrence(row: OccurrenceRow): OccurrenceView {
    const direction = directionOf(row.transaction_kind);
    return {
      id: row.id,
      scheduledItemId: row.scheduled_item_id,
      title: row.title,
      kind: row.transaction_kind,
      direction,
      expectedAmountMinor: parseDatabaseBigint(row.expected_amount_minor).toString(),
      currency: row.currency.trim(),
      dueOn: row.due_on,
      categoryCode: row.category_code,
      expenseClass: row.expense_class,
      state: row.state,
      presentation: deriveOccurrencePresentation({
        state: row.state,
        direction,
        dueOn: row.due_on,
        localDate: localDateAt(this.now(), row.timezone),
      }),
      confirmedTransactionId: row.confirmed_transaction_id,
      confirmedAt: nullableIso(row.confirmed_at),
      skippedAt: nullableIso(row.skipped_at),
      skipReason: row.skip_reason,
      cancelledAt: nullableIso(row.cancelled_at),
      version: parseDatabaseBigint(row.version).toString(),
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

  private async resolveOwnedOccurrenceAccount(ownerUserId: string, occurrenceId: string): Promise<string> {
    const result = await this.pool.query<{ account_id: string }>(`
      SELECT account_id FROM scheduled_occurrences WHERE user_id = $1 AND id = $2
    `, [ownerUserId, occurrenceId]);
    const occurrence = result.rows[0];
    if (!occurrence) throw unavailableError();
    return occurrence.account_id;
  }
}

const occurrenceSelect = `
  SELECT occurrence.id, occurrence.scheduled_item_id, occurrence.account_id,
         item.title, occurrence.transaction_kind, occurrence.expected_amount_minor,
         occurrence.currency, occurrence.due_on::text AS due_on,
         item.category_id, category.code AS category_code, item.expense_class,
         occurrence.state, occurrence.confirmed_transaction_id,
         occurrence.confirmed_at, occurrence.skipped_at, occurrence.skip_reason,
         occurrence.cancelled_at, item.timezone, occurrence.version
  FROM scheduled_occurrences AS occurrence
  JOIN scheduled_items AS item
    ON item.user_id = occurrence.user_id
   AND item.account_id = occurrence.account_id
   AND item.id = occurrence.scheduled_item_id
  JOIN categories AS category ON category.id = item.category_id
`;

async function lockOccurrence(
  transaction: BoundedTransaction,
  ownerUserId: string,
  accountId: string,
  occurrenceId: string,
): Promise<OccurrenceRow> {
  const result = await transaction.query<OccurrenceRow>(`${occurrenceSelect}
    WHERE occurrence.user_id = $1 AND occurrence.account_id = $2 AND occurrence.id = $3
    FOR UPDATE OF occurrence
  `, [ownerUserId, accountId, occurrenceId]);
  const occurrence = result.rows[0];
  if (!occurrence) throw unavailableError();
  return occurrence;
}

async function resolveCategory(
  transaction: BoundedTransaction,
  ownerUserId: string,
  categoryCode: string,
  kind: TransactionKind,
): Promise<CategoryRow> {
  const result = await transaction.query<CategoryRow>(`
    SELECT id FROM categories
    WHERE code = $1 AND transaction_kind = $2 AND active = TRUE
      AND (owner_user_id IS NULL OR owner_user_id = $3)
  `, [categoryCode, kind, ownerUserId]);
  const category = result.rows[0];
  if (!category) throw validationError('Category is invalid for this transaction direction.');
  return category;
}

function assertReviewedScheduled(occurrence: OccurrenceRow, reviewedVersion: string): void {
  if (
    occurrence.state !== 'scheduled'
    || parseDatabaseBigint(occurrence.version).toString() !== reviewedVersion
  ) {
    throw new StableIdempotentFinancialError(occurrenceStaleError());
  }
}

function occurrenceStaleError(): FinancialError {
  return new FinancialError({
    code: 'FINANCIAL_STATE_STALE',
    statusCode: 409,
    safeMessage: 'The reviewed occurrence state is stale. Refetch before retrying.',
  });
}

function directionOf(kind: TransactionKind): OccurrenceDirection {
  return kind === 'income' ? 'incoming' : 'outgoing';
}

function encodeOccurrenceCursor(dueOn: string, id: string): string {
  return Buffer.from(JSON.stringify({ dueOn, id }), 'utf8').toString('base64url');
}

function decodeOccurrenceCursor(value: string): { readonly dueOn: string; readonly id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid cursor');
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.dueOn !== 'string'
      || typeof candidate.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.id)
    ) throw new Error('invalid cursor');
    return { dueOn: assertLocalDate(candidate.dueOn), id: candidate.id };
  } catch {
    throw validationError('Occurrence cursor is invalid.');
  }
}

function nullableIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
