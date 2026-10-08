import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  applyCorrectionDelta,
  assertMoneyRange,
  correctionCurrentBalanceDelta,
  FinancialError,
  localDateAt,
  monthBounds,
  parseDatabaseBigint,
  parsePositiveMinor,
  unavailableError,
  validateCorrectionOccurrenceDate,
  validateTransactionClassification,
  type BalanceEffect,
  type ExpenseClass,
  type TransactionKind,
} from '@kfin/domain';
import {
  assertCorrectionAggregateProjection,
  assertFinancialAggregateBounds,
} from './aggregate-bounds.js';
import { digestCanonicalRequest, signCanonicalPayload, verifyCanonicalPayload } from './canonical.js';
import {
  AccountFinancialSerializer,
  StableIdempotentFinancialError,
  type BoundedTransaction,
  type LockedAccount,
  type LockedSnapshot,
} from './serialization.js';

export interface CorrectionReplacementInput {
  readonly amountMinor: string;
  readonly occurredOn: string;
  readonly categoryCode: string;
  readonly expenseClass?: ExpenseClass;
  readonly isUnexpected: boolean;
  readonly note?: string | null;
}

export interface CorrectionReviewContext {
  readonly expectedFinancialStateVersion: string;
  readonly reviewedLatestSnapshotId: string;
  readonly reviewedSourceVersion: string;
  readonly reviewedSourceSnapshotId: string;
  readonly reviewedSourceBalanceEffect: BalanceEffect;
  readonly reviewedSourceAlreadyIncludedInSnapshot: boolean;
  readonly reviewedSourceKind: TransactionKind;
  readonly reviewedSourceCurrency: string;
  readonly reviewedUserTimezone: string;
  readonly reviewedUserVersion: string;
  readonly reviewedOwningDomain: {
    readonly type: 'none' | 'schedule';
    readonly scheduleOccurrenceId: string | null;
    readonly scheduleOccurrenceVersion: string | null;
  };
  readonly reviewedPreviewDigest: string;
}

export interface PreviewCorrectionInput {
  readonly replacement: CorrectionReplacementInput;
  readonly reason: string;
}

export interface PreviewVoidInput {
  readonly reason: string;
}

export interface CommitCorrectionInput extends PreviewCorrectionInput {
  readonly context: CorrectionReviewContext;
}

export interface CommitVoidInput extends PreviewVoidInput {
  readonly context: CorrectionReviewContext;
}

export interface CorrectionPreviewView {
  readonly operation: 'correction' | 'void';
  readonly source: {
    readonly transactionId: string;
    readonly amountMinor: string;
    readonly occurredOn: string;
    readonly categoryCode: string;
    readonly expenseClass: ExpenseClass | null;
    readonly isUnexpected: boolean;
    readonly note: string | null;
  };
  readonly replacement: {
    readonly amountMinor: string;
    readonly occurredOn: string;
    readonly categoryCode: string;
    readonly expenseClass: ExpenseClass | null;
    readonly isUnexpected: boolean;
    readonly note: string | null;
  } | null;
  readonly authority: {
    readonly currency: string;
    readonly balanceSnapshotId: string;
    readonly snapshotEffectiveAt: string;
    readonly balanceEffect: BalanceEffect;
    readonly alreadyIncludedInSnapshot: boolean;
    readonly segment: 'latest' | 'closed';
  };
  readonly currentBalance: {
    readonly beforeMinor: string;
    readonly deltaMinor: string;
    readonly afterMinor: string;
    readonly changes: boolean;
  };
  readonly reports: {
    readonly removed: ReportImpact;
    readonly added: ReportImpact | null;
  };
  readonly owningDomain: {
    readonly type: 'none' | 'schedule';
    readonly genericCorrectionSupported: boolean;
    readonly genericVoidSupported: boolean;
    readonly unsupportedReasonCode: 'FIN_CORRECTION_LINKED_DOMAIN_REQUIRED' | null;
    readonly scheduleOccurrenceId: string | null;
    readonly scheduleOccurrenceVersion: string | null;
  };
  readonly context: CorrectionReviewContext;
}

export interface CorrectionConsequence {
  readonly currentBalance: CorrectionPreviewView['currentBalance'];
  readonly reports: CorrectionPreviewView['reports'];
  readonly owningDomain: {
    readonly type: 'none' | 'schedule';
    readonly scheduleOccurrenceId: string | null;
    readonly scheduleOccurrenceVersion: string | null;
  };
}

export interface CorrectionCommitResult {
  readonly sourceTransactionId: string;
  readonly replacementTransactionId: string | null;
  readonly financialStateVersion: string;
  readonly consequence: CorrectionConsequence;
}

export interface MonthlyActualsView {
  readonly month: string;
  readonly currency: string;
  readonly incomeMinor: string;
  readonly expenseMinor: string;
  readonly netMinor: string;
  readonly groups: {
    readonly categoryCode: string;
    readonly kind: TransactionKind;
    readonly balanceEffect: BalanceEffect;
    readonly amountMinor: string;
    readonly transactionCount: number;
    readonly amended: boolean;
    readonly drilldown: {
      readonly month: string;
      readonly categoryCode: string;
      readonly kind: TransactionKind;
      readonly balanceEffect: BalanceEffect;
    };
  }[];
}

interface ReportImpact {
  readonly month: string;
  readonly categoryCode: string;
  readonly kind: TransactionKind;
}

interface PreviewProvenance {
  readonly currentBalance: CorrectionPreviewView['currentBalance'];
  readonly reports: CorrectionPreviewView['reports'];
  readonly owningDomain: CorrectionPreviewView['owningDomain'];
}

interface SourceRow extends QueryResultRow {
  id: string;
  user_id: string;
  account_id: string;
  balance_snapshot_id: string;
  kind: TransactionKind;
  amount_minor: string;
  currency: string;
  occurred_on: string;
  balance_effect: BalanceEffect;
  already_included_in_snapshot: boolean;
  category_id: string;
  category_code: string;
  expense_class: ExpenseClass | null;
  is_unexpected: boolean;
  note: string | null;
  status: 'posted' | 'voided';
  version: string;
  snapshot_effective_at: Date;
  snapshot_effective_local_date: string;
  snapshot_timezone: string;
  next_snapshot_effective_local_date: string | null;
  successor_id: string | null;
  schedule_occurrence_id: string | null;
  schedule_occurrence_version: string | null;
}

interface PreviewSourceRow extends SourceRow {
  latest_snapshot_id: string;
  financial_state_version: string;
  current_balance_minor: string;
  current_timezone: string;
  current_user_version: string;
}

interface CategoryRow extends QueryResultRow {
  id: string;
}

interface MonthlyRow extends QueryResultRow {
  category_code: string;
  kind: TransactionKind;
  balance_effect: BalanceEffect;
  amount_minor: string;
  transaction_count: string;
  amended: boolean;
}

interface ReplacementFacts {
  readonly amountMinor: bigint;
  readonly occurredOn: string;
  readonly categoryCode: string;
  readonly categoryId: string;
  readonly expenseClass: ExpenseClass | null;
  readonly isUnexpected: boolean;
  readonly note: string | null;
}

export class PostgresTransactionCorrectionService {
  private readonly serializer: AccountFinancialSerializer;

  constructor(
    private readonly pool: Pool,
    private readonly idempotencyRetentionMs: number,
    private readonly previewSigningKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[a-fA-F0-9]{64}$/.test(previewSigningKey)) {
      throw new Error('Financial preview signing key must be 32 bytes encoded as hexadecimal.');
    }
    this.serializer = new AccountFinancialSerializer(pool, () => this.now().getTime());
  }

  async previewCorrection(
    ownerUserId: string,
    sourceTransactionId: string,
    input: PreviewCorrectionInput,
  ): Promise<CorrectionPreviewView> {
    const reason = assertReason(input.reason);
    const source = await this.loadPreviewSource(ownerUserId, sourceTransactionId);
    const replacement = await this.resolveReplacement(
      this.pool,
      ownerUserId,
      source,
      input.replacement,
      undefined,
      source.current_timezone,
    );
    await assertCorrectionAggregateProjection(
      this.pool,
      ownerUserId,
      source.account_id,
      aggregateProjection(source, source.latest_snapshot_id, replacement),
    );
    return buildPreview('correction', source, replacement, reason, this.previewSigningKey);
  }

  async previewVoid(
    ownerUserId: string,
    sourceTransactionId: string,
    input: PreviewVoidInput,
  ): Promise<CorrectionPreviewView> {
    const reason = assertReason(input.reason);
    const source = await this.loadPreviewSource(ownerUserId, sourceTransactionId);
    await assertCorrectionAggregateProjection(
      this.pool,
      ownerUserId,
      source.account_id,
      aggregateProjection(source, source.latest_snapshot_id, null),
    );
    return buildPreview('void', source, null, reason, this.previewSigningKey);
  }

  async correct(
    ownerUserId: string,
    sourceTransactionId: string,
    input: CommitCorrectionInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CorrectionCommitResult> {
    const reason = assertReason(input.reason);
    const accountId = await this.resolveOwnedAccountId(ownerUserId);
    const replacementTransactionId = randomUUID();
    const requestDigest = digestCanonicalRequest({
      sourceTransactionId,
      replacement: input.replacement,
      reason,
      context: input.context,
    });

    const result = await this.serializer.execute({
      ownerUserId,
      accountId,
      operation: 'financial.transaction.correct',
      idempotencyKey,
      requestDigest,
      expectedFinancialStateVersion: BigInt(input.context.expectedFinancialStateVersion),
      reviewedLatestSnapshotId: input.context.reviewedLatestSnapshotId,
      staleCode: 'FIN_CORRECTION_STALE_STATE',
      successStatus: 201,
      correlationId,
      idempotencyRetentionMs: this.idempotencyRetentionMs,
      work: async ({ transaction, account, latestSnapshot, committedFinancialStateVersion }) => {
        const source = await lockCorrectionSource(
          transaction,
          ownerUserId,
          accountId,
          sourceTransactionId,
        );
        validateReviewedSource(source, input.context, account);
        const replacement = await this.resolveReplacement(
          transaction,
          ownerUserId,
          source,
          input.replacement,
          latestSnapshot,
          account.timezone,
        );
        const aggregateBefore = await assertCorrectionAggregateProjection(
          transaction,
          ownerUserId,
          accountId,
          aggregateProjection(source, latestSnapshot.id, replacement),
        );
        const provenance = buildPreviewProvenance(
          'correction',
          source,
          replacement,
          aggregateBefore.balance,
          latestSnapshot.id,
        );
        assertPreviewDigest(
          'correction',
          source.id,
          reason,
          replacement,
          input.context,
          provenance,
          this.previewSigningKey,
        );
        const consequence = buildConsequence(source, provenance);

        await transaction.query(`
          INSERT INTO transactions (
            id, user_id, account_id, balance_snapshot_id, kind, amount_minor,
            currency, occurred_on, balance_effect, already_included_in_snapshot,
            category_id, expense_class, is_unexpected, note, supersedes_transaction_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [
          replacementTransactionId,
          ownerUserId,
          accountId,
          source.balance_snapshot_id,
          source.kind,
          replacement.amountMinor.toString(),
          account.currency,
          replacement.occurredOn,
          source.balance_effect,
          source.already_included_in_snapshot,
          replacement.categoryId,
          replacement.expenseClass,
          replacement.isUnexpected,
          replacement.note,
          source.id,
        ]);
        await transferScheduleClaim(transaction, source, replacementTransactionId);
        await voidSource(transaction, source, reason);
        await assertFinancialAggregateBounds(transaction, ownerUserId, accountId, [
          source.occurred_on.slice(0, 7),
          replacement.occurredOn.slice(0, 7),
        ]);

        return {
          value: {
            sourceTransactionId: source.id,
            replacementTransactionId,
            financialStateVersion: committedFinancialStateVersion.toString(),
            consequence,
          },
          audit: {
            action: 'financial.transaction.correct',
            resourceType: 'transaction',
            resourceId: replacementTransactionId,
            metadata: correctionAuditMetadata(source, replacementTransactionId, latestSnapshot, replacement),
          },
        };
      },
    });

    return {
      sourceTransactionId: String(result.value.sourceTransactionId),
      replacementTransactionId: String(result.value.replacementTransactionId),
      financialStateVersion: result.financialStateVersion.toString(),
      consequence: result.value.consequence as unknown as CorrectionConsequence,
    };
  }

  async void(
    ownerUserId: string,
    sourceTransactionId: string,
    input: CommitVoidInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CorrectionCommitResult> {
    const reason = assertReason(input.reason);
    const accountId = await this.resolveOwnedAccountId(ownerUserId);
    const requestDigest = digestCanonicalRequest({
      sourceTransactionId,
      reason,
      context: input.context,
    });

    const result = await this.serializer.execute({
      ownerUserId,
      accountId,
      operation: 'financial.transaction.void',
      idempotencyKey,
      requestDigest,
      expectedFinancialStateVersion: BigInt(input.context.expectedFinancialStateVersion),
      reviewedLatestSnapshotId: input.context.reviewedLatestSnapshotId,
      staleCode: 'FIN_CORRECTION_STALE_STATE',
      successStatus: 200,
      correlationId,
      idempotencyRetentionMs: this.idempotencyRetentionMs,
      work: async ({ transaction, account, latestSnapshot, committedFinancialStateVersion }) => {
        const source = await lockCorrectionSource(
          transaction,
          ownerUserId,
          accountId,
          sourceTransactionId,
        );
        validateReviewedSource(source, input.context, account);
        const aggregateBefore = await assertCorrectionAggregateProjection(
          transaction,
          ownerUserId,
          accountId,
          aggregateProjection(source, latestSnapshot.id, null),
        );
        const provenance = buildPreviewProvenance(
          'void',
          source,
          null,
          aggregateBefore.balance,
          latestSnapshot.id,
        );
        assertPreviewDigest(
          'void',
          source.id,
          reason,
          null,
          input.context,
          provenance,
          this.previewSigningKey,
        );
        const consequence = buildConsequence(source, provenance);
        if (source.schedule_occurrence_id !== null) {
          throw new StableIdempotentFinancialError(linkedDomainRequiredError());
        }
        await voidSource(transaction, source, reason);
        await assertFinancialAggregateBounds(
          transaction,
          ownerUserId,
          accountId,
          [source.occurred_on.slice(0, 7)],
        );

        return {
          value: {
            sourceTransactionId: source.id,
            replacementTransactionId: null,
            financialStateVersion: committedFinancialStateVersion.toString(),
            consequence,
          },
          audit: {
            action: 'financial.transaction.void',
            resourceType: 'transaction',
            resourceId: source.id,
            metadata: {
              sourceTransactionId: source.id,
              snapshotId: source.balance_snapshot_id,
              originalBalanceEffect: source.balance_effect,
              segment: source.balance_snapshot_id === latestSnapshot.id ? 'latest' : 'closed',
              owningDomain: 'none',
            },
          },
        };
      },
    });

    return {
      sourceTransactionId: String(result.value.sourceTransactionId),
      replacementTransactionId: null,
      financialStateVersion: result.financialStateVersion.toString(),
      consequence: result.value.consequence as unknown as CorrectionConsequence,
    };
  }

  async getMonthlyActuals(ownerUserId: string, month: string): Promise<MonthlyActualsView> {
    const { start, end } = monthBounds(month);
    const account = await this.pool.query<{ currency: string }>(
      'SELECT currency FROM financial_accounts WHERE user_id = $1',
      [ownerUserId],
    );
    const accountRow = account.rows[0];
    if (!accountRow) throw unavailableError();

    const result = await this.pool.query<MonthlyRow>(`
      SELECT category.code AS category_code, txn.kind, txn.balance_effect,
             COALESCE(SUM(txn.amount_minor) FILTER (WHERE txn.status = 'posted'), 0)::numeric AS amount_minor,
             COUNT(*) FILTER (WHERE txn.status = 'posted')::text AS transaction_count,
             BOOL_OR(
               txn.status = 'voided'
               OR txn.supersedes_transaction_id IS NOT NULL
               OR successor.id IS NOT NULL
             ) AS amended
      FROM transactions AS txn
      JOIN categories AS category ON category.id = txn.category_id
      LEFT JOIN transactions AS successor
        ON successor.user_id = txn.user_id
       AND successor.account_id = txn.account_id
       AND successor.supersedes_transaction_id = txn.id
      WHERE txn.user_id = $1
        AND txn.status IN ('posted', 'voided')
        AND txn.occurred_on >= $2::date
        AND txn.occurred_on < $3::date
      GROUP BY category.code, txn.kind, txn.balance_effect
      ORDER BY txn.kind, category.code, txn.balance_effect
    `, [ownerUserId, start, end]);

    let income = 0n;
    let expense = 0n;
    const groups = result.rows.map((row) => {
      const amount = assertMoneyRange(parseDatabaseBigint(row.amount_minor));
      if (row.kind === 'income') income = assertMoneyRange(income + amount);
      else expense = assertMoneyRange(expense + amount);
      return {
        categoryCode: row.category_code,
        kind: row.kind,
        balanceEffect: row.balance_effect,
        amountMinor: amount.toString(),
        transactionCount: Number.parseInt(row.transaction_count, 10),
        amended: row.amended,
        drilldown: {
          month,
          categoryCode: row.category_code,
          kind: row.kind,
          balanceEffect: row.balance_effect,
        },
      };
    });
    const net = assertMoneyRange(income - expense);
    return {
      month,
      currency: accountRow.currency.trim(),
      incomeMinor: income.toString(),
      expenseMinor: expense.toString(),
      netMinor: net.toString(),
      groups,
    };
  }

  private async loadPreviewSource(
    ownerUserId: string,
    sourceTransactionId: string,
  ): Promise<PreviewSourceRow> {
    const result = await this.pool.query<PreviewSourceRow>(`
      SELECT txn.id, txn.user_id, txn.account_id, txn.balance_snapshot_id,
             txn.kind, txn.amount_minor, txn.currency,
             txn.occurred_on::text AS occurred_on, txn.balance_effect,
             txn.already_included_in_snapshot, txn.category_id,
             category.code AS category_code, txn.expense_class, txn.is_unexpected,
             txn.note, txn.status, txn.version,
             source_snapshot.effective_at AS snapshot_effective_at,
             source_snapshot.effective_local_date::text AS snapshot_effective_local_date,
             source_snapshot.timezone AS snapshot_timezone,
             next_snapshot.effective_local_date AS next_snapshot_effective_local_date,
             successor.id AS successor_id,
             schedule_occurrence.id AS schedule_occurrence_id,
             schedule_occurrence.version AS schedule_occurrence_version,
             current_balance.snapshot_id AS latest_snapshot_id,
             current_balance.financial_state_version,
             current_balance.current_balance_minor,
             owner.timezone AS current_timezone, owner.version AS current_user_version
      FROM transactions AS txn
      JOIN categories AS category ON category.id = txn.category_id
      JOIN balance_snapshots AS source_snapshot
        ON source_snapshot.user_id = txn.user_id
       AND source_snapshot.account_id = txn.account_id
       AND source_snapshot.id = txn.balance_snapshot_id
      JOIN users AS owner ON owner.id = txn.user_id
      JOIN financial_current_balances AS current_balance
        ON current_balance.user_id = txn.user_id
       AND current_balance.account_id = txn.account_id
      LEFT JOIN LATERAL (
        SELECT candidate.effective_local_date::text AS effective_local_date
        FROM balance_snapshots AS candidate
        WHERE candidate.user_id = txn.user_id
          AND candidate.account_id = txn.account_id
          AND candidate.effective_at > source_snapshot.effective_at
        ORDER BY candidate.effective_at ASC
        LIMIT 1
      ) AS next_snapshot ON TRUE
      LEFT JOIN transactions AS successor
        ON successor.user_id = txn.user_id
       AND successor.account_id = txn.account_id
       AND successor.supersedes_transaction_id = txn.id
      LEFT JOIN scheduled_occurrences AS schedule_occurrence
        ON schedule_occurrence.user_id = txn.user_id
       AND schedule_occurrence.account_id = txn.account_id
       AND schedule_occurrence.confirmed_transaction_id = txn.id
      WHERE txn.user_id = $1 AND txn.id = $2
    `, [ownerUserId, sourceTransactionId]);
    const source = result.rows[0];
    if (!source) throw unavailableError();
    assertPostedTerminal(source);
    return source;
  }

  private async resolveReplacement(
    queryable: Pick<Pool, 'query'> | BoundedTransaction,
    ownerUserId: string,
    source: SourceRow,
    input: CorrectionReplacementInput,
    latestSnapshot: LockedSnapshot | undefined,
    currentTimezone: string,
  ): Promise<ReplacementFacts> {
    const amountMinor = parsePositiveMinor(input.amountMinor);
    const expenseClass = validateTransactionClassification({
      kind: source.kind,
      ...(input.expenseClass === undefined ? {} : { expenseClass: input.expenseClass }),
      isUnexpected: input.isUnexpected,
    });
    const occurredOn = validateCorrectionOccurrenceDate({
      kind: source.kind,
      amountMinor: parseDatabaseBigint(source.amount_minor),
      occurredOn: source.occurred_on,
      balanceEffect: source.balance_effect,
      alreadyIncludedInSnapshot: source.already_included_in_snapshot,
      balanceSnapshotId: source.balance_snapshot_id,
      latestSnapshotId: latestSnapshot?.id ?? (source as PreviewSourceRow).latest_snapshot_id,
      snapshotEffectiveLocalDate: source.snapshot_effective_local_date,
      nextSnapshotEffectiveLocalDate: source.next_snapshot_effective_local_date,
      currentLocalDate: localDateAt(this.now(), currentTimezone),
    }, input.occurredOn);
    const categorySql = `
      SELECT id
      FROM categories
      WHERE code = $1 AND transaction_kind = $2 AND active = TRUE
        AND (owner_user_id IS NULL OR owner_user_id = $3)
    `;
    const categoryValues = [input.categoryCode, source.kind, ownerUserId];
    const categoryResult = 'remainingMs' in queryable
      ? await queryable.query<CategoryRow>(categorySql, categoryValues)
      : await queryable.query<CategoryRow>(categorySql, categoryValues);
    const category = categoryResult.rows[0];
    if (!category) {
      throw new FinancialError({
        code: 'FIN_CORRECTION_INVALID_TRANSITION',
        statusCode: 409,
        safeMessage: 'The replacement category is invalid for the original transaction direction.',
      });
    }
    return {
      amountMinor,
      occurredOn,
      categoryCode: input.categoryCode,
      categoryId: category.id,
      expenseClass,
      isUnexpected: input.isUnexpected,
      note: input.note === undefined ? source.note : input.note,
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

async function lockCorrectionSource(
  transaction: BoundedTransaction,
  ownerUserId: string,
  accountId: string,
  sourceTransactionId: string,
): Promise<SourceRow> {
  const result = await transaction.query<SourceRow>(`
    SELECT txn.id, txn.user_id, txn.account_id, txn.balance_snapshot_id,
           txn.kind, txn.amount_minor, txn.currency,
           txn.occurred_on::text AS occurred_on, txn.balance_effect,
           txn.already_included_in_snapshot, txn.category_id,
           category.code AS category_code, txn.expense_class, txn.is_unexpected,
           txn.note, txn.status, txn.version,
           source_snapshot.effective_at AS snapshot_effective_at,
           source_snapshot.effective_local_date::text AS snapshot_effective_local_date,
           source_snapshot.timezone AS snapshot_timezone,
           next_snapshot.effective_local_date AS next_snapshot_effective_local_date,
           successor.id AS successor_id,
           NULL::uuid AS schedule_occurrence_id,
           NULL::bigint AS schedule_occurrence_version
    FROM transactions AS txn
    JOIN categories AS category ON category.id = txn.category_id
    JOIN balance_snapshots AS source_snapshot
      ON source_snapshot.user_id = txn.user_id
     AND source_snapshot.account_id = txn.account_id
     AND source_snapshot.id = txn.balance_snapshot_id
    LEFT JOIN LATERAL (
      SELECT candidate.effective_local_date::text AS effective_local_date
      FROM balance_snapshots AS candidate
      WHERE candidate.user_id = txn.user_id
        AND candidate.account_id = txn.account_id
        AND candidate.effective_at > source_snapshot.effective_at
      ORDER BY candidate.effective_at ASC
      LIMIT 1
    ) AS next_snapshot ON TRUE
    LEFT JOIN transactions AS successor
      ON successor.user_id = txn.user_id
     AND successor.account_id = txn.account_id
     AND successor.supersedes_transaction_id = txn.id
    WHERE txn.user_id = $1 AND txn.account_id = $2 AND txn.id = $3
    FOR UPDATE OF txn
  `, [ownerUserId, accountId, sourceTransactionId]);
  const source = result.rows[0];
  if (!source) throw unavailableError();

  // The serializer locked account then latest snapshot; this function locks the
  // transaction next. Immutable source snapshots are read without another row lock,
  // then owning-domain rows follow in the global order.
  const scheduleClaim = await transaction.query<{ id: string; version: string }>(`
    SELECT id, version
    FROM scheduled_occurrences
    WHERE user_id = $1 AND account_id = $2 AND confirmed_transaction_id = $3
    FOR UPDATE
  `, [ownerUserId, accountId, sourceTransactionId]);
  if (scheduleClaim.rows.length > 1) throw domainLinkConflictError();
  source.schedule_occurrence_id = scheduleClaim.rows[0]?.id ?? null;
  source.schedule_occurrence_version = scheduleClaim.rows[0]?.version ?? null;
  return source;
}

function validateReviewedSource(
  source: SourceRow,
  context: CorrectionReviewContext,
  account: LockedAccount,
): void {
  if (
    account.timezone !== context.reviewedUserTimezone
    || account.userVersion.toString() !== context.reviewedUserVersion
  ) {
    throw new StableIdempotentFinancialError(correctionStaleError());
  }
  if (
    source.status !== 'posted'
    || source.successor_id !== null
    || parseDatabaseBigint(source.version).toString() !== context.reviewedSourceVersion
  ) {
    throw new StableIdempotentFinancialError(correctionStaleError());
  }
  if (source.balance_snapshot_id !== context.reviewedSourceSnapshotId) {
    throw new FinancialError({
      code: 'FIN_CORRECTION_CROSS_SEGMENT_UNSUPPORTED',
      statusCode: 409,
      safeMessage: 'A correction cannot select a different snapshot segment.',
    });
  }
  if (
    source.balance_effect !== context.reviewedSourceBalanceEffect
    || source.already_included_in_snapshot !== context.reviewedSourceAlreadyIncludedInSnapshot
  ) {
    throw new FinancialError({
      code: 'FIN_CORRECTION_EFFECT_CHANGE_UNSUPPORTED',
      statusCode: 409,
      safeMessage: 'A correction cannot change balance effect or snapshot-inclusion meaning.',
    });
  }
  if (
    source.kind !== context.reviewedSourceKind
    || source.currency.trim() !== context.reviewedSourceCurrency
  ) {
    throw new FinancialError({
      code: 'FIN_CORRECTION_INVALID_TRANSITION',
      statusCode: 409,
      safeMessage: 'A correction cannot change transaction authority or direction.',
    });
  }

  const actualOwnerType = source.schedule_occurrence_id === null ? 'none' : 'schedule';
  const reviewedOwner = context.reviewedOwningDomain;
  if (
    reviewedOwner.type !== actualOwnerType
    || reviewedOwner.scheduleOccurrenceId !== source.schedule_occurrence_id
    || reviewedOwner.scheduleOccurrenceVersion !== source.schedule_occurrence_version
  ) {
    throw new StableIdempotentFinancialError(correctionStaleError());
  }
}

async function transferScheduleClaim(
  transaction: BoundedTransaction,
  source: SourceRow,
  replacementTransactionId: string,
): Promise<void> {
  if (source.schedule_occurrence_id === null) return;
  if (source.schedule_occurrence_version === null) throw domainLinkConflictError();
  const updated = await transaction.query(`
    UPDATE scheduled_occurrences
    SET confirmed_transaction_id = $4, updated_at = clock_timestamp(), version = version + 1
    WHERE user_id = $1 AND account_id = $2 AND id = $3
      AND state = 'confirmed'
      AND confirmed_transaction_id = $5
      AND version = $6
  `, [
    source.user_id,
    source.account_id,
    source.schedule_occurrence_id,
    replacementTransactionId,
    source.id,
    source.schedule_occurrence_version,
  ]);
  if (updated.rowCount !== 1) {
    throw new StableIdempotentFinancialError(correctionStaleError());
  }
}

async function voidSource(
  transaction: BoundedTransaction,
  source: SourceRow,
  reason: string,
): Promise<void> {
  const updated = await transaction.query(`
    UPDATE transactions
    SET status = 'voided', voided_at = clock_timestamp(), void_reason = $4,
        updated_at = clock_timestamp(), version = version + 1
    WHERE user_id = $1 AND account_id = $2 AND id = $3
      AND status = 'posted' AND version = $5
  `, [source.user_id, source.account_id, source.id, reason, source.version]);
  if (updated.rowCount !== 1) {
    throw new StableIdempotentFinancialError(correctionStaleError());
  }
}

function buildPreview(
  operation: 'correction' | 'void',
  source: PreviewSourceRow,
  replacement: ReplacementFacts | null,
  reason: string,
  previewSigningKey: string,
): CorrectionPreviewView {
  const sourceAmount = parseDatabaseBigint(source.amount_minor);
  const before = assertMoneyRange(parseDatabaseBigint(source.current_balance_minor));
  const provenance = buildPreviewProvenance(
    operation,
    source,
    replacement,
    before,
    source.latest_snapshot_id,
  );
  const sourceFact = {
    transactionId: source.id,
    amountMinor: sourceAmount.toString(),
    occurredOn: source.occurred_on,
    categoryCode: source.category_code,
    expenseClass: source.expense_class,
    isUnexpected: source.is_unexpected,
    note: source.note,
  };
  const reviewedContext: Omit<CorrectionReviewContext, 'reviewedPreviewDigest'> = {
    expectedFinancialStateVersion: parseDatabaseBigint(source.financial_state_version).toString(),
    reviewedLatestSnapshotId: source.latest_snapshot_id,
    reviewedSourceVersion: parseDatabaseBigint(source.version).toString(),
    reviewedSourceSnapshotId: source.balance_snapshot_id,
    reviewedSourceBalanceEffect: source.balance_effect,
    reviewedSourceAlreadyIncludedInSnapshot: source.already_included_in_snapshot,
    reviewedSourceKind: source.kind,
    reviewedSourceCurrency: source.currency.trim(),
    reviewedUserTimezone: source.current_timezone,
    reviewedUserVersion: parseDatabaseBigint(source.current_user_version).toString(),
    reviewedOwningDomain: {
      type: source.schedule_occurrence_id === null ? 'none' : 'schedule',
      scheduleOccurrenceId: source.schedule_occurrence_id,
      scheduleOccurrenceVersion: source.schedule_occurrence_version === null
        ? null
        : parseDatabaseBigint(source.schedule_occurrence_version).toString(),
    },
  };
  return {
    operation,
    source: sourceFact,
    replacement: replacement === null ? null : {
      amountMinor: replacement.amountMinor.toString(),
      occurredOn: replacement.occurredOn,
      categoryCode: replacement.categoryCode,
      expenseClass: replacement.expenseClass,
      isUnexpected: replacement.isUnexpected,
      note: replacement.note,
    },
    authority: {
      currency: source.currency.trim(),
      balanceSnapshotId: source.balance_snapshot_id,
      snapshotEffectiveAt: asDate(source.snapshot_effective_at).toISOString(),
      balanceEffect: source.balance_effect,
      alreadyIncludedInSnapshot: source.already_included_in_snapshot,
      segment: source.balance_snapshot_id === source.latest_snapshot_id ? 'latest' : 'closed',
    },
    currentBalance: provenance.currentBalance,
    reports: provenance.reports,
    owningDomain: provenance.owningDomain,
    context: {
      ...reviewedContext,
      reviewedPreviewDigest: previewDigest(
        operation,
        source.id,
        reason,
        replacement,
        reviewedContext,
        provenance,
        previewSigningKey,
      ),
    },
  };
}

function assertPreviewDigest(
  operation: 'correction' | 'void',
  sourceTransactionId: string,
  reason: string,
  replacement: ReplacementFacts | null,
  context: CorrectionReviewContext,
  provenance: PreviewProvenance,
  previewSigningKey: string,
): void {
  const { reviewedPreviewDigest, ...reviewedContext } = context;
  if (!verifyCanonicalPayload(
    previewPayload(operation, sourceTransactionId, reason, replacement, reviewedContext, provenance),
    reviewedPreviewDigest,
    previewSigningKey,
  )) {
    throw new FinancialError({
      code: 'FIN_CORRECTION_INVALID_TRANSITION',
      statusCode: 409,
      safeMessage: 'The correction does not match the reviewed consequence preview.',
    });
  }
}

function previewDigest(
  operation: 'correction' | 'void',
  sourceTransactionId: string,
  reason: string,
  replacement: ReplacementFacts | null,
  context: Omit<CorrectionReviewContext, 'reviewedPreviewDigest'>,
  provenance: PreviewProvenance,
  previewSigningKey: string,
): string {
  return signCanonicalPayload(
    previewPayload(operation, sourceTransactionId, reason, replacement, context, provenance),
    previewSigningKey,
  );
}

function previewPayload(
  operation: 'correction' | 'void',
  sourceTransactionId: string,
  reason: string,
  replacement: ReplacementFacts | null,
  context: Omit<CorrectionReviewContext, 'reviewedPreviewDigest'>,
  provenance: PreviewProvenance,
): Readonly<Record<string, unknown>> {
  return {
    operation,
    sourceTransactionId,
    reason,
    replacement: replacement === null ? null : {
      amountMinor: replacement.amountMinor,
      occurredOn: replacement.occurredOn,
      categoryCode: replacement.categoryCode,
      expenseClass: replacement.expenseClass,
      isUnexpected: replacement.isUnexpected,
      note: replacement.note,
    },
    context,
    consequence: provenance,
  };
}

function aggregateProjection(
  source: SourceRow,
  latestSnapshotId: string,
  replacement: ReplacementFacts | null,
) {
  return {
    source: {
      kind: source.kind,
      amount: parseDatabaseBigint(source.amount_minor),
      occurredOn: source.occurred_on,
      balanceEffect: source.balance_effect,
      balanceSnapshotId: source.balance_snapshot_id,
    },
    latestSnapshotId,
    replacement: replacement === null ? null : {
      amount: replacement.amountMinor,
      occurredOn: replacement.occurredOn,
    },
  };
}

function buildPreviewProvenance(
  operation: 'correction' | 'void',
  source: SourceRow,
  replacement: ReplacementFacts | null,
  before: bigint,
  latestSnapshotId: string,
): PreviewProvenance {
  const delta = correctionCurrentBalanceDelta({
    amountMinor: parseDatabaseBigint(source.amount_minor),
    kind: source.kind,
    balanceEffect: source.balance_effect,
    balanceSnapshotId: source.balance_snapshot_id,
    latestSnapshotId,
  }, replacement?.amountMinor ?? null);
  const after = applyCorrectionDelta(before, delta);
  return {
    currentBalance: {
      beforeMinor: before.toString(),
      deltaMinor: delta.toString(),
      afterMinor: after.toString(),
      changes: delta !== 0n,
    },
    reports: {
      removed: reportImpact(source.occurred_on, source.category_code, source.kind),
      added: replacement === null
        ? null
        : reportImpact(replacement.occurredOn, replacement.categoryCode, source.kind),
    },
    owningDomain: {
      type: source.schedule_occurrence_id === null ? 'none' : 'schedule',
      genericCorrectionSupported: true,
      genericVoidSupported: source.schedule_occurrence_id === null,
      unsupportedReasonCode: operation === 'void' && source.schedule_occurrence_id !== null
        ? 'FIN_CORRECTION_LINKED_DOMAIN_REQUIRED'
        : null,
      scheduleOccurrenceId: source.schedule_occurrence_id,
      scheduleOccurrenceVersion: source.schedule_occurrence_version === null
        ? null
        : parseDatabaseBigint(source.schedule_occurrence_version).toString(),
    },
  };
}

function buildConsequence(
  source: SourceRow,
  provenance: PreviewProvenance,
): CorrectionConsequence {
  return {
    currentBalance: provenance.currentBalance,
    reports: provenance.reports,
    owningDomain: {
      type: source.schedule_occurrence_id === null ? 'none' : 'schedule',
      scheduleOccurrenceId: source.schedule_occurrence_id,
      scheduleOccurrenceVersion: source.schedule_occurrence_version === null
        ? null
        : (parseDatabaseBigint(source.schedule_occurrence_version) + 1n).toString(),
    },
  };
}

function correctionAuditMetadata(
  source: SourceRow,
  replacementTransactionId: string,
  latestSnapshot: LockedSnapshot,
  replacement: ReplacementFacts,
): Readonly<Record<string, unknown>> {
  const changedFields = [
    source.amount_minor !== replacement.amountMinor.toString() ? 'amountMinor' : null,
    source.occurred_on !== replacement.occurredOn ? 'occurredOn' : null,
    source.category_code !== replacement.categoryCode ? 'categoryCode' : null,
    source.expense_class !== replacement.expenseClass ? 'expenseClass' : null,
    source.is_unexpected !== replacement.isUnexpected ? 'isUnexpected' : null,
    source.note !== replacement.note ? 'note' : null,
  ].filter((field): field is string => field !== null);
  return {
    sourceTransactionId: source.id,
    replacementTransactionId,
    snapshotId: source.balance_snapshot_id,
    originalBalanceEffect: source.balance_effect,
    segment: source.balance_snapshot_id === latestSnapshot.id ? 'latest' : 'closed',
    owningDomain: source.schedule_occurrence_id === null ? 'none' : 'schedule',
    scheduleOccurrenceId: source.schedule_occurrence_id,
    priorScheduleOccurrenceVersion: source.schedule_occurrence_version,
    activeTransactionPointerTransferred: source.schedule_occurrence_id !== null,
    changedFields,
    sourceReportMonth: source.occurred_on.slice(0, 7),
    replacementReportMonth: replacement.occurredOn.slice(0, 7),
  };
}

function assertPostedTerminal(source: Pick<SourceRow, 'status' | 'successor_id'>): void {
  if (source.status !== 'posted' || source.successor_id !== null) throw correctionStaleError();
}

function correctionStaleError(): FinancialError {
  return new FinancialError({
    code: 'FIN_CORRECTION_STALE_STATE',
    statusCode: 409,
    safeMessage: 'The reviewed correction state is stale. Refetch and preview before retrying.',
  });
}

function linkedDomainRequiredError(): FinancialError {
  return new FinancialError({
    code: 'FIN_CORRECTION_LINKED_DOMAIN_REQUIRED',
    statusCode: 409,
    safeMessage: 'This transaction must be changed through its owning schedule workflow.',
  });
}

function domainLinkConflictError(): FinancialError {
  return new FinancialError({
    code: 'FIN_TRANSACTION_DOMAIN_LINK_CONFLICT',
    statusCode: 409,
    safeMessage: 'The transaction has an incompatible owning-domain claim.',
  });
}

function assertReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 1_000) {
    throw new FinancialError({
      code: 'FINANCIAL_VALIDATION_FAILED',
      statusCode: 400,
      safeMessage: 'A correction reason between 1 and 1000 characters is required.',
    });
  }
  return reason;
}

function reportImpact(occurredOn: string, categoryCode: string, kind: TransactionKind): ReportImpact {
  return { month: occurredOn.slice(0, 7), categoryCode, kind };
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
