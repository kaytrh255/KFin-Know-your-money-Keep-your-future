import {
  NON_RETRYABLE_TIMEOUT_SQLSTATE,
  POLICY,
  RESULT_CODES,
  RETRYABLE_SQLSTATES,
} from './constants.mjs';
import { LockOrderGuard } from './barriers.mjs';
import {
  delay,
  elapsedMs,
  errorSummary,
  monotonicMs,
  randomBackoffMs,
  safeToken,
  sha256,
  uuid,
} from './util.mjs';

export class FinancialProtocol {
  constructor({ pool, recorder, config }) {
    this.pool = pool;
    this.recorder = recorder;
    this.config = config;
  }

  async execute(request, options = {}) {
    const caseId = options.caseId || 'UNSCOPED';
    const recoveryMode = Boolean(options.recoveryMode);
    const maxAttempts = recoveryMode ? 1 : (options.maxAttempts ?? POLICY.maxAttempts);
    const budgetMs = options.budgetMs ?? (recoveryMode ? POLICY.commitRecoveryBudgetMs : POLICY.databaseBudgetMs);
    const startedAt = monotonicMs();
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;
      const state = {
        attempt,
        began: false,
        commitSent: false,
        committed: false,
        transactionToken: null,
      };
      let lease;
      let databaseDeadlineTimer;
      try {
        await this.#hook(options, 'beforeAttempt', { attempt, request, caseId });
        const leaseProvider = options.leaseProvider || ((label) => this.pool.checkout(label));
        lease = await leaseProvider(`${caseId}.attempt-${attempt}`);
        const remainingAtCheckout = budgetMs - elapsedMs(startedAt);
        if (remainingAtCheckout <= this.config.cleanupReserveMs) {
          lease.release();
          this.recorder.event(recoveryMode
            ? 'transaction.recovery_not_admitted'
            : 'transaction.attempt_not_admitted', {
            caseId,
            correlationToken: request.correlationToken,
            remainingBudgetMs: Number(remainingAtCheckout.toFixed(3)),
            cleanupReserveMs: this.config.cleanupReserveMs,
          });
          if (recoveryMode) return { ...unknownResult(0), recoveryNotStarted: true };
          return {
            status: 'busy',
            code: RESULT_CODES.CONCURRENCY_BUSY,
            retryAfterSeconds: 1,
            attemptCount: attempt - 1,
            budgetPreventedAttempt: true,
          };
        }
        this.recorder.event('transaction.attempt_started', {
          caseId,
          correlationToken: request.correlationToken,
          attempt,
          ...lease.identity,
          remainingBudgetMs: Number(remainingAtCheckout.toFixed(3)),
        });
        databaseDeadlineTimer = setTimeout(() => {
          state.databaseDeadlineExpired = true;
          this.recorder.event('transaction.database_deadline_expired', {
            caseId,
            correlationToken: request.correlationToken,
            attempt,
            budgetMs,
            recoveryMode,
          });
          lease.destroySocket(recoveryMode ? 'commit-recovery-deadline' : 'database-budget-deadline');
        }, Math.max(1, Math.floor(remainingAtCheckout)));
        databaseDeadlineTimer.unref?.();
        const operationTimeoutMs = recoveryMode
          ? Math.max(1, Math.floor(remainingAtCheckout - this.config.cleanupReserveMs))
          : null;
        const result = await this.#runAttempt({
          request,
          options,
          caseId,
          lease,
          state,
          operationTimeoutMs,
        });
        clearTimeout(databaseDeadlineTimer);
        lease.release();
        this.recorder.event('transaction.attempt_finished', {
          caseId,
          correlationToken: request.correlationToken,
          attempt,
          result: result.status,
          transactionToken: state.transactionToken,
          elapsedMs: elapsedMs(startedAt),
        });
        return { ...result, attemptCount: attempt };
      } catch (error) {
        const sqlstate = normalizeSqlstate(error?.code);
        this.recorder.event('transaction.attempt_error', {
          caseId,
          correlationToken: request.correlationToken,
          attempt,
          sqlstate,
          error: errorSummary(error),
          commitSent: state.commitSent,
          commitAcknowledged: state.committed,
          transactionToken: state.transactionToken,
        });

        const uncertainCommit = state.committed
          || (state.commitSent && !isTrustworthyPostgresError(error));
        if (uncertainCommit) {
          clearTimeout(databaseDeadlineTimer);
          lease?.evict('commit-outcome-uncertain');
          await this.#hook(options, 'afterUncertainCommit', {
            attempt,
            request,
            caseId,
            lease,
            error,
            state,
          });
          return {
            status: 'unknown',
            code: RESULT_CODES.RESULT_UNKNOWN,
            attemptCount: attempt,
            commitUncertain: true,
          };
        }

        let cleanup = {
          confirmed: !state.began && !state.databaseDeadlineExpired,
          status: state.began || state.databaseDeadlineExpired ? null : 'I',
        };
        let failedTransactionState = null;
        if (state.began && lease) {
          if (sqlstate) {
            try {
              await lease.query('SELECT 1 AS must_not_succeed_before_rollback');
              failedTransactionState = 'unexpected-query-success';
            } catch (failedStateError) {
              failedTransactionState = normalizeSqlstate(failedStateError?.code);
            }
            this.recorder.event('transaction.failed_state_observed', {
              caseId,
              correlationToken: request.correlationToken,
              attempt,
              observedSqlstate: failedTransactionState,
            });
          }
          try {
            await this.#hook(options, 'beforeRollback', {
              attempt,
              request,
              caseId,
              lease,
              error,
              state,
            });
            cleanup = await lease.rollback();
            if (cleanup.confirmed) {
              const idle = await lease.query(
                `SELECT pg_catalog.txid_current_if_assigned() IS NULL AS idle_without_assigned_xid`,
              );
              cleanup.idleWithoutAssignedXid = idle.rows[0].idle_without_assigned_xid;
            }
          } catch (rollbackError) {
            cleanup = {
              confirmed: false,
              status: null,
              rollbackError: errorSummary(rollbackError),
            };
          }
          this.recorder.event('transaction.cleanup', {
            caseId,
            correlationToken: request.correlationToken,
            attempt,
            sqlstate,
            failedTransactionState,
            ...cleanup,
            ...lease.identity,
          });
        }
        clearTimeout(databaseDeadlineTimer);

        if (!cleanup.confirmed || cleanup.idleWithoutAssignedXid === false) {
          lease?.evict('rollback-idle-unconfirmed');
          await this.#hook(options, 'afterCleanup', {
            attempt,
            request,
            caseId,
            error,
            sqlstate,
            cleanup,
            evicted: true,
            state,
            leaseIdentity: lease?.identity ?? null,
          });
          return recoveryMode
            ? unknownResult(attempt)
            : mappedFailureWithoutRetry(sqlstate, attempt, false, state.databaseDeadlineExpired);
        }

        lease?.release();
        await this.#hook(options, 'afterCleanup', {
          attempt,
          request,
          caseId,
          error,
          sqlstate,
          cleanup,
          evicted: false,
          state,
          leaseIdentity: lease?.identity ?? null,
        });

        if (recoveryMode) return unknownResult(attempt);
        if (sqlstate === NON_RETRYABLE_TIMEOUT_SQLSTATE) {
          return {
            status: 'timeout',
            code: RESULT_CODES.OPERATION_TIMEOUT,
            sqlstate,
            attemptCount: attempt,
            cleanup,
          };
        }
        if (!RETRYABLE_SQLSTATES.has(sqlstate)) throw error;
        if (attempt >= maxAttempts) {
          return {
            status: 'busy',
            code: RESULT_CODES.CONCURRENCY_BUSY,
            retryAfterSeconds: 1,
            sqlstate,
            attemptCount: attempt,
            cleanup,
          };
        }

        await this.#hook(options, 'beforeRetryAdmission', {
          attempt,
          request,
          caseId,
          error,
          sqlstate,
          cleanup,
        });
        const backoffMs = randomBackoffMs(POLICY.retryBackoffMinMs, POLICY.retryBackoffMaxMs);
        const remainingBudgetMs = budgetMs - elapsedMs(startedAt);
        const requiredForRetryMs = POLICY.statementTimeoutMs + this.config.cleanupReserveMs + backoffMs;
        if (remainingBudgetMs <= requiredForRetryMs) {
          this.recorder.event('transaction.retry_prevented_by_budget', {
            caseId,
            correlationToken: request.correlationToken,
            attempt,
            sqlstate,
            remainingBudgetMs: Number(remainingBudgetMs.toFixed(3)),
            requiredForRetryMs,
          });
          return {
            status: 'busy',
            code: RESULT_CODES.CONCURRENCY_BUSY,
            retryAfterSeconds: 1,
            sqlstate,
            attemptCount: attempt,
            cleanup,
            budgetPreventedRetry: true,
          };
        }
        this.recorder.event('transaction.retry_scheduled', {
          caseId,
          correlationToken: request.correlationToken,
          attempt,
          sqlstate,
          backoffMs,
          remainingBudgetMs: Number(remainingBudgetMs.toFixed(3)),
          connectionHeldDuringBackoff: false,
        });
        await this.#hook(options, 'retryScheduled', {
          attempt,
          request,
          caseId,
          sqlstate,
          backoffMs,
          remainingBudgetMs,
        });
        await delay(backoffMs);
      }
    }
    throw new Error('Unreachable retry loop exit');
  }

  async #runAttempt({ request, options, caseId, lease, state, operationTimeoutMs }) {
    const guard = new LockOrderGuard({
      caseId,
      correlationToken: request.correlationToken,
      recorder: this.recorder,
    });
    await lease.begin();
    state.began = true;
    const lockTimeoutMs = operationTimeoutMs === null
      ? POLICY.lockTimeoutMs
      : Math.min(POLICY.lockTimeoutMs, operationTimeoutMs);
    const statementTimeoutMs = operationTimeoutMs === null
      ? POLICY.statementTimeoutMs
      : Math.min(POLICY.statementTimeoutMs, operationTimeoutMs);
    await lease.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await lease.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
    this.recorder.event('transaction.timeouts_applied', {
      caseId,
      correlationToken: request.correlationToken,
      attempt: state.attempt,
      lockTimeoutMs,
      statementTimeoutMs,
      cleanupReserveMs: operationTimeoutMs === null ? null : this.config.cleanupReserveMs,
    });
    const transactionIdentity = await lease.query(
      `SELECT pg_catalog.txid_current()::text AS xid,
              current_setting('transaction_isolation') AS isolation_level`,
    );
    state.transactionToken = `xid-${transactionIdentity.rows[0].xid}`;
    if (transactionIdentity.rows[0].isolation_level.toLowerCase() !== 'read committed') {
      throw new Error(`Unexpected transaction isolation: ${transactionIdentity.rows[0].isolation_level}`);
    }
    await this.#hook(options, 'afterBegin', {
      attempt: state.attempt,
      request,
      caseId,
      lease,
      state,
      guard,
    });

    guard.record('account', request.accountToken);
    const account = await lease.query(
      `SELECT id, currency, financial_state_version::text
       FROM financial_accounts
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [request.accountId, request.userId],
    );
    if (account.rowCount !== 1) {
      const cleanup = await lease.rollback();
      if (cleanup.confirmed) {
        const idle = await lease.query(
          `SELECT pg_catalog.txid_current_if_assigned() IS NULL AS idle_without_assigned_xid`,
        );
        cleanup.idleWithoutAssignedXid = idle.rows[0].idle_without_assigned_xid;
      }
      this.recorder.event('transaction.cleanup', {
        caseId,
        correlationToken: request.correlationToken,
        attempt: state.attempt,
        reason: 'owner-scoped-account-unavailable',
        sqlstate: null,
        ...cleanup,
        ...lease.identity,
      });
      if (!cleanup.confirmed || cleanup.idleWithoutAssignedXid === false) {
        const error = new Error('Owner-scoped account miss could not be confirmed idle');
        error.code = 'KFIN_CLEANUP_UNCONFIRMED';
        throw error;
      }
      state.began = false;
      return { status: 'unavailable', code: RESULT_CODES.ACCOUNT_UNAVAILABLE, cleanup };
    }
    await this.#hook(options, 'afterAccountLock', {
      attempt: state.attempt,
      request,
      caseId,
      lease,
      state,
      guard,
    });

    const existing = await lease.query(
      `SELECT request_digest, response_status, response_code, response_reference,
              prior_financial_state_version::text,
              committed_financial_state_version::text, result
       FROM idempotency_keys
       WHERE user_id = $1 AND account_id = $2 AND operation = $3 AND key_digest = $4`,
      [request.userId, request.accountId, request.operation, request.keyDigest],
    );
    if (existing.rowCount === 1) {
      if (existing.rows[0].request_digest !== request.requestDigest) {
        state.commitSent = true;
        await lease.query('COMMIT');
        state.began = false;
        state.committed = true;
        return { status: 'idempotency_conflict', code: RESULT_CODES.IDEMPOTENCY_REUSED };
      }
      state.commitSent = true;
      await lease.query('COMMIT');
      state.began = false;
      state.committed = true;
      return {
        status: 'idempotent_replay',
        code: existing.rows[0].response_code,
        replayedResult: existing.rows[0].result,
        committedVersion: existing.rows[0].committed_financial_state_version,
      };
    }

    const latest = await lease.query(
      `SELECT id, effective_at, effective_local_date, currency
       FROM balance_snapshots
       WHERE user_id = $1 AND account_id = $2
       ORDER BY effective_at DESC, id DESC
       LIMIT 1`,
      [request.userId, request.accountId],
    );
    if (latest.rowCount !== 1) throw new Error('Account has no authoritative snapshot');
    const actualVersion = BigInt(account.rows[0].financial_state_version);
    if (actualVersion !== request.expectedVersion || latest.rows[0].id !== request.reviewedSnapshotId) {
      guard.record('result', request.correlationToken);
      const staleCode = staleCodeFor(request.kind);
      await insertIdempotency(lease, request, {
        priorVersion: actualVersion,
        committedVersion: null,
        status: 'stale',
        code: staleCode,
        reference: request.primaryResourceId,
        result: { status: 'stale', code: staleCode },
      });
      state.commitSent = true;
      await lease.query('COMMIT');
      state.began = false;
      state.committed = true;
      return { status: 'stale', code: staleCode, actualVersion: actualVersion.toString() };
    }

    const authoritative = await this.#lockDomainRows({ lease, request, guard, latest: latest.rows[0] });
    await this.#hook(options, 'afterDomainLocks', {
      attempt: state.attempt,
      request,
      caseId,
      lease,
      state,
      guard,
      authoritative,
    });
    await this.#hook(options, 'beforeMutation', {
      attempt: state.attempt,
      request,
      caseId,
      lease,
      state,
      guard,
      authoritative,
    });
    const reference = await applyMutation(lease, request, authoritative);
    const updated = await lease.query(
      `UPDATE financial_accounts
       SET financial_state_version = financial_state_version + 1,
           updated_at = clock_timestamp()
       WHERE id = $1 AND user_id = $2
         AND financial_state_version < 9223372036854775807
       RETURNING financial_state_version::text`,
      [request.accountId, request.userId],
    );
    if (updated.rowCount !== 1) throw new Error('Financial state version overflow or account disappeared');
    const committedVersion = BigInt(updated.rows[0].financial_state_version);
    if (committedVersion !== request.expectedVersion + 1n) {
      throw new Error('Logical winner did not increment financial_state_version exactly once');
    }

    guard.record('result', request.correlationToken);
    const result = {
      status: 'committed',
      code: RESULT_CODES.COMMITTED,
      reference,
      priorVersion: request.expectedVersion.toString(),
      committedVersion: committedVersion.toString(),
    };
    await insertIdempotency(lease, request, {
      priorVersion: request.expectedVersion,
      committedVersion,
      status: 'committed',
      code: RESULT_CODES.COMMITTED,
      reference,
      result,
    });
    await lease.query(
      `INSERT INTO audit_events(
         id, user_id, account_id, action, resource_type, resource_id,
         outcome, correlation_token, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, 'committed', $7, $8::jsonb)`,
      [
        uuid(),
        request.userId,
        request.accountId,
        request.operation,
        request.kind,
        reference,
        request.correlationToken,
        JSON.stringify({ actorPath: request.actorPath }),
      ],
    );
    await this.#hook(options, 'beforeCommit', {
      attempt: state.attempt,
      request,
      caseId,
      lease,
      state,
      guard,
      result,
    });
    state.commitSent = true;
    if (options.commitStrategy) {
      await options.commitStrategy({ lease, request, caseId, state, result });
    } else {
      await lease.query('COMMIT');
    }
    state.began = false;
    state.committed = true;
    await this.#hook(options, 'afterCommit', {
      attempt: state.attempt,
      request,
      caseId,
      lease,
      state,
      guard,
      result,
    });
    return result;
  }

  async #lockDomainRows({ lease, request, guard }) {
    guard.record('snapshot', request.reviewedSnapshotToken);
    const snapshot = await lease.query(
      `SELECT id, user_id, account_id, currency, effective_at, effective_local_date
       FROM balance_snapshots
       WHERE id = $1 AND user_id = $2 AND account_id = $3
       FOR UPDATE`,
      [request.reviewedSnapshotId, request.userId, request.accountId],
    );
    if (snapshot.rowCount !== 1) throw new Error('Reviewed snapshot is unavailable after account lock');

    if (request.kind === 'correction' || request.kind === 'void') {
      guard.record('transaction', request.sourceTransactionToken);
      const source = await lease.query(
        `SELECT id, user_id, account_id, balance_snapshot_id, kind, amount_minor::text,
                currency, occurred_on, balance_effect, already_included_in_snapshot, status
         FROM transactions
         WHERE id = $1 AND user_id = $2 AND account_id = $3
         FOR UPDATE`,
        [request.payload.sourceTransactionId, request.userId, request.accountId],
      );
      if (source.rowCount !== 1 || source.rows[0].status !== 'posted') {
        const error = new Error('Source transaction is no longer terminal posted state');
        error.code = 'FIN_CORRECTION_STALE_STATE';
        throw error;
      }
      let occurrence = null;
      if (request.payload.occurrenceId) {
        guard.record('occurrence', request.occurrenceToken);
        occurrence = await lease.query(
          `SELECT id, state, confirmed_transaction_id
           FROM scheduled_occurrences
           WHERE id = $1 AND user_id = $2 AND account_id = $3
           FOR UPDATE`,
          [request.payload.occurrenceId, request.userId, request.accountId],
        );
        if (
          occurrence.rowCount !== 1
          || occurrence.rows[0].state !== 'confirmed'
          || occurrence.rows[0].confirmed_transaction_id !== source.rows[0].id
        ) {
          const error = new Error('Occurrence link changed under correction');
          error.code = 'FIN_CORRECTION_STALE_STATE';
          throw error;
        }
      }
      return { snapshot: snapshot.rows[0], source: source.rows[0], occurrence: occurrence?.rows[0] ?? null };
    }
    return { snapshot: snapshot.rows[0] };
  }

  async #hook(options, name, context) {
    const hook = options.hooks?.[name];
    if (hook) await hook(context);
  }
}

export function makeRequest(kind, fixture, overrides = {}) {
  const operation = operationFor(kind);
  const requestSeed = overrides.requestSeed || safeToken(`${kind}-request`);
  const primaryResourceId = overrides.primaryResourceId || uuid();
  const payload = {
    ...(kind === 'snapshot' ? {
      snapshotId: primaryResourceId,
      amountMinor: 900000,
      effectiveAt: '2026-01-03T00:00:00.000Z',
      effectiveLocalDate: '2026-01-03',
    } : {}),
    ...(kind === 'transaction' ? {
      transactionId: primaryResourceId,
      kind: 'expense',
      amountMinor: 10000,
      occurredOn: '2026-01-03',
    } : {}),
    ...(kind === 'correction' ? {
      sourceTransactionId: fixture.sourceTransactionId,
      replacementTransactionId: primaryResourceId,
      occurrenceId: fixture.occurrenceId,
      replacementAmountMinor: 250000,
      replacementOccurredOn: '2026-01-02',
    } : {}),
    ...(kind === 'void' ? {
      sourceTransactionId: fixture.sourceTransactionId,
      occurrenceId: null,
      voidReason: 'synthetic evidence void',
    } : {}),
    ...(overrides.payload || {}),
  };
  const canonical = JSON.stringify({
    kind,
    operation,
    expectedVersion: String(overrides.expectedVersion ?? fixture.initialVersion),
    reviewedSnapshotId: overrides.reviewedSnapshotId || fixture.initialSnapshotId,
    payload,
  });
  return {
    kind,
    operation,
    userId: fixture.userId,
    accountId: fixture.accountId,
    accountToken: `account-${sha256(fixture.accountId).slice(0, 12)}`,
    expectedVersion: BigInt(overrides.expectedVersion ?? fixture.initialVersion),
    reviewedSnapshotId: overrides.reviewedSnapshotId || fixture.initialSnapshotId,
    reviewedSnapshotToken: `snapshot-${sha256(overrides.reviewedSnapshotId || fixture.initialSnapshotId).slice(0, 12)}`,
    primaryResourceId,
    sourceTransactionToken: fixture.sourceTransactionId
      ? `transaction-${sha256(fixture.sourceTransactionId).slice(0, 12)}`
      : null,
    occurrenceToken: fixture.occurrenceId
      ? `occurrence-${sha256(fixture.occurrenceId).slice(0, 12)}`
      : null,
    keyDigest: overrides.keyDigest || sha256(`key:${requestSeed}`),
    requestDigest: overrides.requestDigest || sha256(canonical),
    correlationToken: overrides.correlationToken || safeToken('corr'),
    actorPath: overrides.actorPath || 'user',
    payload,
  };
}

async function applyMutation(lease, request, authoritative) {
  if (request.kind === 'snapshot') {
    const latestAt = new Date(authoritative.snapshot.effective_at).getTime();
    if (new Date(request.payload.effectiveAt).getTime() <= latestAt) {
      throw new Error('Synthetic snapshot is not strictly later than authoritative snapshot');
    }
    await lease.query(
      `INSERT INTO balance_snapshots(
         id, user_id, account_id, amount_minor, currency, effective_at,
         effective_local_date, timezone, reason, correlation_token
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'UTC', 'manual_balance_update', $8)`,
      [
        request.payload.snapshotId,
        request.userId,
        request.accountId,
        request.payload.amountMinor,
        authoritative.snapshot.currency,
        request.payload.effectiveAt,
        request.payload.effectiveLocalDate,
        request.correlationToken,
      ],
    );
    return request.payload.snapshotId;
  }

  if (request.kind === 'transaction') {
    await lease.query(
      `INSERT INTO transactions(
         id, user_id, account_id, balance_snapshot_id, kind, amount_minor,
         currency, occurred_on, balance_effect, already_included_in_snapshot,
         status, correlation_token
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 'current', false, 'posted', $9)`,
      [
        request.payload.transactionId,
        request.userId,
        request.accountId,
        authoritative.snapshot.id,
        request.payload.kind,
        request.payload.amountMinor,
        authoritative.snapshot.currency,
        request.payload.occurredOn,
        request.correlationToken,
      ],
    );
    return request.payload.transactionId;
  }

  const source = authoritative.source;
  await lease.query(
    `UPDATE transactions
     SET status = 'voided', voided_at = clock_timestamp(), void_reason = $1,
         updated_at = clock_timestamp(), row_version = row_version + 1
     WHERE id = $2 AND user_id = $3 AND account_id = $4 AND status = 'posted'`,
    [request.payload.voidReason || 'synthetic correction', source.id, request.userId, request.accountId],
  );
  if (request.kind === 'void') return source.id;

  await lease.query(
    `INSERT INTO transactions(
       id, user_id, account_id, balance_snapshot_id, kind, amount_minor,
       currency, occurred_on, balance_effect, already_included_in_snapshot,
       status, supersedes_transaction_id, correlation_token
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               'posted', $11, $12)`,
    [
      request.payload.replacementTransactionId,
      request.userId,
      request.accountId,
      source.balance_snapshot_id,
      source.kind,
      request.payload.replacementAmountMinor,
      source.currency,
      request.payload.replacementOccurredOn,
      source.balance_effect,
      source.already_included_in_snapshot,
      source.id,
      request.correlationToken,
    ],
  );
  if (authoritative.occurrence) {
    await lease.query(
      `UPDATE scheduled_occurrences
       SET confirmed_transaction_id = $1, updated_at = clock_timestamp()
       WHERE id = $2 AND user_id = $3 AND account_id = $4
         AND confirmed_transaction_id = $5`,
      [
        request.payload.replacementTransactionId,
        request.payload.occurrenceId,
        request.userId,
        request.accountId,
        source.id,
      ],
    );
  }
  return request.payload.replacementTransactionId;
}

async function insertIdempotency(lease, request, value) {
  await lease.query(
    `INSERT INTO idempotency_keys(
       id, user_id, account_id, operation, key_digest, request_digest,
       prior_financial_state_version, committed_financial_state_version,
       response_status, response_code, response_reference, result, correlation_token
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
    [
      uuid(),
      request.userId,
      request.accountId,
      request.operation,
      request.keyDigest,
      request.requestDigest,
      value.priorVersion?.toString() ?? null,
      value.committedVersion?.toString() ?? null,
      value.status,
      value.code,
      value.reference,
      JSON.stringify(value.result),
      request.correlationToken,
    ],
  );
}

function operationFor(kind) {
  if (kind === 'snapshot') return 'snapshot.create';
  if (kind === 'transaction') return 'transaction.create';
  if (kind === 'correction') return 'transaction.correct';
  if (kind === 'void') return 'transaction.void';
  throw new Error(`Unsupported financial mutation kind: ${kind}`);
}

function staleCodeFor(kind) {
  if (kind === 'snapshot') return RESULT_CODES.SNAPSHOT_STALE;
  if (kind === 'correction' || kind === 'void') return RESULT_CODES.CORRECTION_STALE;
  return RESULT_CODES.FINANCIAL_STALE;
}

function normalizeSqlstate(code) {
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function isTrustworthyPostgresError(error) {
  return normalizeSqlstate(error?.code) !== null;
}

function unknownResult(attemptCount) {
  return {
    status: 'unknown',
    code: RESULT_CODES.RESULT_UNKNOWN,
    attemptCount,
    commitUncertain: true,
  };
}

function mappedFailureWithoutRetry(sqlstate, attemptCount, cleanupConfirmed, databaseDeadlineExpired = false) {
  if (sqlstate === NON_RETRYABLE_TIMEOUT_SQLSTATE || databaseDeadlineExpired) {
    return {
      status: 'timeout',
      code: RESULT_CODES.OPERATION_TIMEOUT,
      sqlstate,
      attemptCount,
      cleanupConfirmed,
    };
  }
  return {
    status: 'busy',
    code: RESULT_CODES.CONCURRENCY_BUSY,
    retryAfterSeconds: 1,
    sqlstate,
    attemptCount,
    cleanupConfirmed,
  };
}
