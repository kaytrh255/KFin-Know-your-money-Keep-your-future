import { randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  FinancialError,
  parseDatabaseBigint,
  unavailableError,
} from '@kfin/domain';
import { digestSecret } from './canonical.js';

export const SERIALIZATION_POLICY = Object.freeze({
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000,
  databaseBudgetMs: 8_000,
  maximumAttempts: 2,
  retryJitterMinimumMs: 25,
  retryJitterMaximumMs: 75,
  commitRecoveryBudgetMs: 2_000,
});

const RETRYABLE_SQLSTATES = new Set(['55P03', '40P01', '40001']);

export interface LockedAccount {
  readonly id: string;
  readonly userId: string;
  readonly currency: string;
  readonly financialStateVersion: bigint;
}

export interface LockedSnapshot {
  readonly id: string;
  readonly amountMinor: bigint;
  readonly effectiveAt: Date;
  readonly effectiveLocalDate: string;
  readonly timezone: string;
}

export interface BoundedTransaction {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  remainingMs(): number;
}

export interface SerializedWorkContext {
  readonly transaction: BoundedTransaction;
  readonly account: LockedAccount;
  readonly latestSnapshot: LockedSnapshot;
  readonly committedFinancialStateVersion: bigint;
}

export interface SerializedWorkResult<Value extends Record<string, unknown>> {
  readonly value: Value;
  readonly audit: {
    readonly action: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

export interface SerializedOperation<Value extends Record<string, unknown>> {
  readonly ownerUserId: string;
  readonly accountId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly expectedFinancialStateVersion: bigint;
  readonly reviewedLatestSnapshotId: string;
  readonly staleCode: 'FINANCIAL_STATE_STALE' | 'FIN_SNAPSHOT_STALE_STATE';
  readonly successStatus: number;
  readonly correlationId: string;
  readonly idempotencyRetentionMs: number;
  readonly work: (context: SerializedWorkContext) => Promise<SerializedWorkResult<Value>>;
}

export interface SerializedOperationResult<Value extends Record<string, unknown>> {
  readonly value: Value;
  readonly financialStateVersion: bigint;
  readonly replayed: boolean;
  readonly attempts: number;
}

interface AccountRow extends QueryResultRow {
  id: string;
  user_id: string;
  currency: string;
  financial_state_version: string;
}

interface SnapshotRow extends QueryResultRow {
  id: string;
  amount_minor: string;
  effective_at: Date;
  effective_local_date: string;
  timezone: string;
}

interface StoredResultRow extends QueryResultRow {
  request_digest: string;
  response_status: number;
  result_code: string;
  result: Record<string, unknown>;
  committed_financial_state_version: string | null;
}

interface AttemptResult<Value extends Record<string, unknown>> {
  readonly value: Value;
  readonly financialStateVersion: bigint;
  readonly replayed: boolean;
}

export class AccountFinancialSerializer {
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly now: () => number = Date.now,
    private readonly jitter: (minimum: number, maximumExclusive: number) => number = randomInt,
  ) {}

  async execute<Value extends Record<string, unknown>>(
    operation: SerializedOperation<Value>,
  ): Promise<SerializedOperationResult<Value>> {
    const normalDeadline = this.now() + SERIALIZATION_POLICY.databaseBudgetMs;
    let attempts = 0;

    while (attempts < SERIALIZATION_POLICY.maximumAttempts) {
      attempts += 1;
      try {
        const result = await this.attempt(operation, normalDeadline);
        return { ...result, attempts };
      } catch (error) {
        if (error instanceof CommitAcknowledgementUnknown) {
          return this.recoverUnknownCommit(operation, attempts);
        }
        if (!(error instanceof RetryableAttemptFailure)) throw error;
        if (attempts >= SERIALIZATION_POLICY.maximumAttempts) throw concurrencyBusy(error);

        const backoffMs = this.jitter(
          SERIALIZATION_POLICY.retryJitterMinimumMs,
          SERIALIZATION_POLICY.retryJitterMaximumMs + 1,
        );
        const requiredMs = SERIALIZATION_POLICY.statementTimeoutMs + backoffMs;
        if (normalDeadline - this.now() < requiredMs) throw concurrencyBusy(error);
        await delay(backoffMs);
      }
    }
    throw concurrencyBusy();
  }

  private async recoverUnknownCommit<Value extends Record<string, unknown>>(
    operation: SerializedOperation<Value>,
    priorAttempts: number,
  ): Promise<SerializedOperationResult<Value>> {
    const recoveryDeadline = this.now() + SERIALIZATION_POLICY.commitRecoveryBudgetMs;
    try {
      const result = await this.attempt(operation, recoveryDeadline);
      return { ...result, attempts: priorAttempts + 1 };
    } catch (error) {
      if (error instanceof FinancialError && (
        error.code === 'FINANCIAL_STATE_STALE'
        || error.code === 'FIN_SNAPSHOT_STALE_STATE'
        || error.code === 'IDEMPOTENCY_KEY_REUSED'
      )) throw error;
      throw new FinancialError({
        code: 'FINANCIAL_RESULT_UNKNOWN',
        statusCode: 503,
        safeMessage: 'The financial result is not yet known. Retry with the same idempotency key.',
        retryAfterSeconds: 1,
        cause: error,
      });
    }
  }

  private async attempt<Value extends Record<string, unknown>>(
    operation: SerializedOperation<Value>,
    deadline: number,
  ): Promise<AttemptResult<Value>> {
    let client: PoolClient;
    try {
      client = await connectBefore(this.pool, deadline, this.now);
    } catch (error) {
      if (error instanceof ApplicationDeadlineExceeded) throw operationTimeout(error);
      if (error instanceof FinancialError) throw error;
      throw new FinancialError({
        code: 'FIN_DATABASE_UNAVAILABLE',
        statusCode: 503,
        safeMessage: 'Financial data is temporarily unavailable.',
        retryAfterSeconds: 1,
        cause: error,
      });
    }
    let released = false;
    let commitSent = false;
    let committed = false;
    const transaction = new DeadlineBoundTransaction(
      client,
      deadline,
      this.now,
      SERIALIZATION_POLICY.statementTimeoutMs,
    );

    try {
      await transaction.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await transaction.query(
        "SELECT set_config('lock_timeout', $1, true)",
        [`${Math.max(1, Math.min(SERIALIZATION_POLICY.lockTimeoutMs, transaction.remainingMs()))}ms`],
      );

      // This is deliberately the first authoritative domain-row lock.
      const accountResult = await transaction.query<AccountRow>(`
        SELECT id, user_id, currency, financial_state_version
        FROM financial_accounts
        WHERE id = $1 AND user_id = $2
        FOR UPDATE
      `, [operation.accountId, operation.ownerUserId]);
      const accountRow = accountResult.rows[0];
      if (!accountRow) throw unavailableError();
      const account: LockedAccount = {
        id: accountRow.id,
        userId: accountRow.user_id,
        currency: accountRow.currency.trim(),
        financialStateVersion: parseDatabaseBigint(accountRow.financial_state_version),
      };

      const keyDigest = digestSecret(operation.idempotencyKey);
      const existing = await transaction.query<StoredResultRow>(`
        SELECT request_digest, response_status, result_code, result,
               committed_financial_state_version
        FROM idempotency_results
        WHERE user_id = $1 AND account_id = $2 AND operation = $3 AND key_digest = $4
      `, [operation.ownerUserId, operation.accountId, operation.operation, keyDigest]);
      const stored = existing.rows[0];
      if (stored) {
        commitSent = true;
        await commitBefore(client, deadline, this.now);
        committed = true;
        if (stored.request_digest.trim() !== operation.requestDigest) {
          throw idempotencyReused();
        }
        if (stored.response_status >= 400) throw storedFinancialError(stored);
        return {
          value: stored.result as Value,
          financialStateVersion: parseDatabaseBigint(
            stored.committed_financial_state_version ?? accountRow.financial_state_version,
          ),
          replayed: true,
        };
      }

      const snapshotResult = await transaction.query<SnapshotRow>(`
        SELECT id, amount_minor, effective_at, effective_local_date, timezone
        FROM balance_snapshots
        WHERE user_id = $1 AND account_id = $2
        ORDER BY effective_at DESC
        LIMIT 1
        FOR UPDATE
      `, [operation.ownerUserId, operation.accountId]);
      const snapshotRow = snapshotResult.rows[0];
      if (!snapshotRow) throw unavailableError();
      const latestSnapshot: LockedSnapshot = {
        id: snapshotRow.id,
        amountMinor: parseDatabaseBigint(snapshotRow.amount_minor),
        effectiveAt: snapshotRow.effective_at,
        effectiveLocalDate: snapshotRow.effective_local_date,
        timezone: snapshotRow.timezone,
      };

      if (
        account.financialStateVersion !== operation.expectedFinancialStateVersion
        || latestSnapshot.id !== operation.reviewedLatestSnapshotId
      ) {
        await insertIdempotencyResult(transaction, {
          id: randomUUID(),
          userId: operation.ownerUserId,
          accountId: operation.accountId,
          operation: operation.operation,
          keyDigest,
          requestDigest: operation.requestDigest,
          priorVersion: account.financialStateVersion,
          committedVersion: null,
          responseStatus: 409,
          resultCode: operation.staleCode,
          result: {},
          correlationId: operation.correlationId,
          retentionMs: operation.idempotencyRetentionMs,
        });
        commitSent = true;
        await commitBefore(client, deadline, this.now);
        committed = true;
        throw staleError(operation.staleCode);
      }

      const committedVersion = account.financialStateVersion + 1n;
      const work = await operation.work({
        transaction,
        account,
        latestSnapshot,
        committedFinancialStateVersion: committedVersion,
      });
      assertBeforeDeadline(deadline, this.now);

      const versionUpdate = await transaction.query(`
        UPDATE financial_accounts
        SET financial_state_version = $3, updated_at = clock_timestamp()
        WHERE id = $1 AND user_id = $2 AND financial_state_version = $4
      `, [operation.accountId, operation.ownerUserId, committedVersion.toString(), account.financialStateVersion.toString()]);
      if (versionUpdate.rowCount !== 1) {
        throw new Error('Locked financial account version update did not affect exactly one row.');
      }

      await insertIdempotencyResult(transaction, {
        id: randomUUID(),
        userId: operation.ownerUserId,
        accountId: operation.accountId,
        operation: operation.operation,
        keyDigest,
        requestDigest: operation.requestDigest,
        priorVersion: account.financialStateVersion,
        committedVersion,
        responseStatus: operation.successStatus,
        resultCode: 'OK',
        result: work.value,
        correlationId: operation.correlationId,
        retentionMs: operation.idempotencyRetentionMs,
      });
      await transaction.query(`
        INSERT INTO audit_events (
          id, user_id, actor_user_id, action, resource_type, resource_id,
          outcome, correlation_id, metadata
        ) VALUES ($1, $2, $2, $3, $4, $5, 'committed', $6, $7::jsonb)
      `, [
        randomUUID(),
        operation.ownerUserId,
        work.audit.action,
        work.audit.resourceType,
        work.audit.resourceId,
        operation.correlationId,
        JSON.stringify(work.audit.metadata ?? {}),
      ]);

      commitSent = true;
      await commitBefore(client, deadline, this.now);
      committed = true;
      return {
        value: work.value,
        financialStateVersion: committedVersion,
        replayed: false,
      };
    } catch (error) {
      if (committed) throw error;
      if (commitSent && !hasTrustworthySqlstate(error)) {
        client.release(true);
        released = true;
        throw new CommitAcknowledgementUnknown(error);
      }

      const cleaned = await rollbackBefore(client, deadline, this.now);
      if (!cleaned) {
        client.release(true);
        released = true;
        throw cleanupFailure(error);
      }
      client.release();
      released = true;

      if (error instanceof FinancialError) throw error;
      if (error instanceof ApplicationDeadlineExceeded) {
        throw operationTimeout(error);
      }
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '57014') throw operationTimeout(error);
      if (sqlstate && RETRYABLE_SQLSTATES.has(sqlstate)) {
        throw new RetryableAttemptFailure(sqlstate, error);
      }
      throw new FinancialError({
        code: 'FIN_DATABASE_UNAVAILABLE',
        statusCode: 503,
        safeMessage: 'Financial data is temporarily unavailable.',
        retryAfterSeconds: 1,
        cause: error,
      });
    } finally {
      if (!released) client.release(committed ? undefined : true);
    }
  }
}

class DeadlineBoundTransaction implements BoundedTransaction {
  constructor(
    private readonly client: PoolClient,
    private readonly deadline: number,
    private readonly now: () => number,
    private readonly maximumStatementTimeoutMs: number,
  ) {}

  remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    assertBeforeDeadline(this.deadline, this.now);
    const remaining = this.remainingMs();
    if (!/^\s*(?:BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(text)) {
      await this.client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${Math.max(1, Math.min(this.maximumStatementTimeoutMs, remaining))}ms`],
      );
    }
    return this.client.query<Row>(text, [...values]);
  }
}

async function insertIdempotencyResult(
  transaction: BoundedTransaction,
  input: {
    id: string;
    userId: string;
    accountId: string;
    operation: string;
    keyDigest: string;
    requestDigest: string;
    priorVersion: bigint;
    committedVersion: bigint | null;
    responseStatus: number;
    resultCode: string;
    result: Record<string, unknown>;
    correlationId: string;
    retentionMs: number;
  },
): Promise<void> {
  await transaction.query(`
    INSERT INTO idempotency_results (
      id, user_id, account_id, operation, key_digest, request_digest,
      prior_financial_state_version, committed_financial_state_version,
      response_status, result_code, result, correlation_id, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
              clock_timestamp() + ($13::bigint * interval '1 millisecond'))
  `, [
    input.id,
    input.userId,
    input.accountId,
    input.operation,
    input.keyDigest,
    input.requestDigest,
    input.priorVersion.toString(),
    input.committedVersion?.toString() ?? null,
    input.responseStatus,
    input.resultCode,
    JSON.stringify(input.result),
    input.correlationId,
    input.retentionMs,
  ]);
}

async function connectBefore(
  pool: Pick<Pool, 'connect'>,
  deadline: number,
  now: () => number,
): Promise<PoolClient> {
  const remaining = deadline - now();
  if (remaining <= 0) throw new ApplicationDeadlineExceeded();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const connecting = pool.connect();
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new ApplicationDeadlineExceeded());
    }, remaining);
  });
  connecting.then((client) => {
    if (timedOut) client.release();
  }).catch(() => undefined);
  try {
    return await Promise.race([connecting, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function commitBefore(
  client: PoolClient,
  deadline: number,
  now: () => number,
): Promise<void> {
  const remaining = deadline - now();
  if (remaining <= 0) throw new ApplicationDeadlineExceeded();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.query('COMMIT'),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ApplicationDeadlineExceeded()), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function rollbackBefore(
  client: PoolClient,
  deadline: number,
  now: () => number,
): Promise<boolean> {
  const remaining = deadline - now();
  if (remaining <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      // node-postgres resolves this query only after consuming ReadyForQuery; this is
      // the driver-equivalent idle acknowledgement required before pool release.
      client.query('ROLLBACK'),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ApplicationDeadlineExceeded()), remaining);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertBeforeDeadline(deadline: number, now: () => number): void {
  if (now() >= deadline) throw new ApplicationDeadlineExceeded();
}

function hasTrustworthySqlstate(error: unknown): boolean {
  return sqlstateOf(error) !== null;
}

function sqlstateOf(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function staleError(code: 'FINANCIAL_STATE_STALE' | 'FIN_SNAPSHOT_STALE_STATE'): FinancialError {
  return new FinancialError({
    code,
    statusCode: 409,
    safeMessage: 'The reviewed financial state is stale. Refetch and review before retrying.',
  });
}

function storedFinancialError(row: StoredResultRow): FinancialError {
  if (row.result_code === 'FINANCIAL_STATE_STALE' || row.result_code === 'FIN_SNAPSHOT_STALE_STATE') {
    return staleError(row.result_code);
  }
  return new FinancialError({
    code: 'FIN_DATABASE_UNAVAILABLE',
    statusCode: 503,
    safeMessage: 'The stored financial result is unavailable.',
  });
}

function idempotencyReused(): FinancialError {
  return new FinancialError({
    code: 'IDEMPOTENCY_KEY_REUSED',
    statusCode: 409,
    safeMessage: 'The idempotency key was already used for a different request.',
  });
}

function operationTimeout(cause?: unknown): FinancialError {
  return new FinancialError({
    code: 'FINANCIAL_OPERATION_TIMEOUT',
    statusCode: 503,
    safeMessage: 'The financial operation timed out. Retry safely with the same idempotency key.',
    retryAfterSeconds: 1,
    cause,
  });
}

function concurrencyBusy(cause?: unknown): FinancialError {
  return new FinancialError({
    code: 'FINANCIAL_CONCURRENCY_BUSY',
    statusCode: 503,
    safeMessage: 'The financial account is busy. Retry with the same idempotency key.',
    retryAfterSeconds: 1,
    cause,
  });
}

function cleanupFailure(trigger: unknown): FinancialError {
  const code = sqlstateOf(trigger);
  if (code === '57014' || trigger instanceof ApplicationDeadlineExceeded) return operationTimeout(trigger);
  if (code && RETRYABLE_SQLSTATES.has(code)) return concurrencyBusy(trigger);
  return new FinancialError({
    code: 'FIN_DATABASE_UNAVAILABLE',
    statusCode: 503,
    safeMessage: 'Financial data is temporarily unavailable.',
    retryAfterSeconds: 1,
    cause: trigger,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class RetryableAttemptFailure extends Error {
  constructor(readonly sqlstate: string, cause: unknown) {
    super(`Retryable SQLSTATE ${sqlstate}`, { cause });
    this.name = 'RetryableAttemptFailure';
  }
}

class CommitAcknowledgementUnknown extends Error {
  constructor(cause: unknown) {
    super('Commit acknowledgement was not established.', { cause });
    this.name = 'CommitAcknowledgementUnknown';
  }
}

class ApplicationDeadlineExceeded extends Error {
  constructor() {
    super('Application database deadline exceeded.');
    this.name = 'ApplicationDeadlineExceeded';
  }
}
