import { waitForActiveQuery } from '../barriers.mjs';
import { POLICY, RESULT_CODES } from '../constants.mjs';
import { TracedPool } from '../db.mjs';
import {
  createBaseFixture,
  destroyFixture,
  readFixtureState,
  recordFixtureState,
} from '../fixtures.mjs';
import { FinancialProtocol, makeRequest } from '../protocol.mjs';
import { assertEvidence } from '../race-utils.mjs';
import { delay, uuid } from '../util.mjs';

export async function runFinRace06(context) {
  const caseId = 'FIN-RACE-06';
  const { config, pool, protocol: mainProtocol, recorder } = context;
  recorder.startCase(caseId, { poolMode: config.poolMode });
  if (config.poolMode === 'transaction' || config.poolMode === 'unknown') {
    recorder.blockCase(
      caseId,
      `Rollback/handle lifecycle evidence requires direct or session mode; configured mode is ${config.poolMode}.`,
      { requiredMode: 'direct|session' },
    );
    return;
  }
  const oneSlotPool = new TracedPool(config, recorder, { max: 1 });
  const protocol = new FinancialProtocol({ pool: oneSlotPool, recorder, config });
  try {
    for (const sqlstate of ['55P03', '40P01', '40001']) {
      await retryOnceThenCommit({ caseId, sqlstate, pool, oneSlotPool, protocol, recorder });
    }
    await retryExhaustion({ caseId, oneSlotPool, protocol, recorder });
    await competitorBetweenAttempts({ caseId, pool, protocol, mainProtocol, recorder });
    await cancelledStatementTimeout({ caseId, pool, protocol, recorder });
    await budgetPreventedRetry({ caseId, protocol, recorder });
    await databaseBudgetDeadline({ caseId, config, oneSlotPool, protocol, recorder });
    await unconfirmedRollbackEviction({ caseId, oneSlotPool, protocol, recorder });
    await authorizationFailureNoRetry({ caseId, oneSlotPool, protocol, recorder });
    await validationFailureNoRetry({ caseId, oneSlotPool, protocol, recorder });
    recorder.passCase(caseId, { requiredSubcases: 11 });
  } finally {
    await oneSlotPool.end();
  }
}

async function retryOnceThenCommit({ caseId, sqlstate, pool, oneSlotPool, protocol, recorder }) {
  const fixture = await createBaseFixture(pool);
  let faultBlocker = null;
  const attempts = [];
  const backoffs = [];
  let accountLockReleased = false;
  try {
    if (sqlstate === '55P03') {
      faultBlocker = await pool.checkout(`${caseId}.55P03.blocker`);
      await faultBlocker.query('BEGIN');
      await faultBlocker.query('SELECT id FROM evidence_fault_locks WHERE id = 1 FOR UPDATE');
    }
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-${sqlstate}-retry` });
    const result = await protocol.execute(request, {
      caseId,
      hooks: {
        afterBegin: async ({ attempt, lease, state }) => {
          attempts.push({ attempt, handleToken: lease.identity.handleToken, transactionToken: state.transactionToken });
        },
        afterAccountLock: async ({ attempt, lease }) => {
          if (attempt !== 1) return;
          if (sqlstate === '55P03') {
            await lease.query('SELECT id FROM evidence_fault_locks WHERE id = 1 FOR UPDATE');
          } else {
            await lease.query('SELECT evidence_raise_sqlstate($1)', [sqlstate]);
          }
        },
        afterCleanup: async ({ attempt, evicted }) => {
          if (attempt !== 1 || evicted) return;
          if (faultBlocker) {
            await faultBlocker.query('ROLLBACK');
            faultBlocker.release();
            faultBlocker = null;
          }
          accountLockReleased = await proveAccountLockReleased(pool, fixture);
        },
        retryScheduled: async ({ sqlstate: observed, backoffMs }) => {
          backoffs.push({ sqlstate: observed, backoffMs });
        },
      },
    });
    const state = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, `${sqlstate}-retry-success`, state);
    assertEvidence(recorder, caseId, `${sqlstate}: retry committed on attempt two`,
      result.status === 'committed' && result.attemptCount === 2, { result: result.status, attempts: result.attemptCount });
    assertEvidence(recorder, caseId, `${sqlstate}: exact SQLSTATE classified`,
      backoffs.length === 1 && backoffs[0].sqlstate === sqlstate);
    assertEvidence(recorder, caseId, `${sqlstate}: backoff stayed within 25–75 ms`,
      backoffs[0].backoffMs >= POLICY.retryBackoffMinMs && backoffs[0].backoffMs <= POLICY.retryBackoffMaxMs,
      { backoffMs: backoffs[0].backoffMs });
    assertEvidence(recorder, caseId, `${sqlstate}: confirmed cleanup released account lock before retry`, accountLockReleased);
    assertEvidence(recorder, caseId, `${sqlstate}: one-slot pool reused confirmed-clean handle`,
      attempts.length === 2 && attempts[0].handleToken === attempts[1].handleToken);
    assertEvidence(recorder, caseId, `${sqlstate}: retry used fresh PostgreSQL transaction`,
      attempts.length === 2 && attempts[0].transactionToken !== attempts[1].transactionToken);
    assertEvidence(recorder, caseId, `${sqlstate}: failed transaction state was observed before rollback`,
      hasEvent(recorder, request.correlationToken, 'transaction.failed_state_observed', (event) => event.observedSqlstate === '25P02'));
    assertEvidence(recorder, caseId, `${sqlstate}: rollback/idle preceded retry scheduling`,
      cleanupBeforeRetry(recorder, request.correlationToken));
    assertEvidence(recorder, caseId, `${sqlstate}: exactly one effect/version increment`,
      state.version === 2n && state.transactionCount === 1 && state.idempotencyCount === 1);
  } finally {
    if (faultBlocker) {
      await faultBlocker.query('ROLLBACK').catch(() => {});
      faultBlocker.release();
    }
    await destroyFixture(pool, fixture);
  }
}

async function retryExhaustion({ caseId, oneSlotPool, protocol, recorder }) {
  const fixture = await createBaseFixture(oneSlotPool);
  const attempts = [];
  try {
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-retry-exhaustion` });
    const result = await protocol.execute(request, {
      caseId,
      hooks: {
        afterBegin: async ({ attempt, state }) => attempts.push({ attempt, transactionToken: state.transactionToken }),
        afterAccountLock: async ({ lease }) => lease.query('SELECT evidence_raise_sqlstate($1)', ['40001']),
      },
    });
    const state = await readFixtureState(oneSlotPool, fixture);
    recordFixtureState(recorder, caseId, 'retry-exhaustion', state);
    assertEvidence(recorder, caseId, 'retry exhaustion returns stable busy result',
      result.status === 'busy'
      && result.code === RESULT_CODES.CONCURRENCY_BUSY
      && result.retryAfterSeconds === 1
      && result.attemptCount === 2);
    assertEvidence(recorder, caseId, 'retry exhaustion has two fresh transactions and no third attempt',
      attempts.length === 2 && attempts[0].transactionToken !== attempts[1].transactionToken);
    assertEvidence(recorder, caseId, 'retry exhaustion commits no financial effect',
      state.version === 1n && state.transactionCount === 0 && state.idempotencyCount === 0);
  } finally {
    await destroyFixture(oneSlotPool, fixture);
  }
}

async function competitorBetweenAttempts({ caseId, pool, protocol, mainProtocol, recorder }) {
  const fixture = await createBaseFixture(pool);
  let competitorResult = null;
  try {
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-stale-after-retry` });
    const competitor = makeRequest('transaction', fixture, { requestSeed: `${caseId}-competitor` });
    const result = await protocol.execute(request, {
      caseId,
      hooks: {
        afterAccountLock: async ({ attempt, lease }) => {
          if (attempt === 1) await lease.query('SELECT evidence_raise_sqlstate($1)', ['40001']);
        },
        afterCleanup: async ({ attempt, evicted }) => {
          if (attempt === 1 && !evicted) competitorResult = await mainProtocol.execute(competitor, { caseId });
        },
      },
    });
    const state = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, 'competitor-between-attempts', state);
    assertEvidence(recorder, caseId, 'competitor committed between attempts', competitorResult?.status === 'committed');
    assertEvidence(recorder, caseId, 'retry preserved old reviewed state and became stale',
      result.status === 'stale' && result.attemptCount === 2 && result.code === RESULT_CODES.FINANCIAL_STALE);
    assertEvidence(recorder, caseId, 'stale retry made no second effect/version increment',
      state.version === 2n && state.transactionCount === 1 && state.idempotencyCount === 2);
  } finally {
    await destroyFixture(pool, fixture);
  }
}

async function cancelledStatementTimeout({ caseId, pool, protocol, recorder }) {
  const fixture = await createBaseFixture(pool);
  let requestContextCancelled = false;
  let activeQueryObserved = false;
  let attemptCount = 0;
  try {
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-57014` });
    const result = await protocol.execute(request, {
      caseId,
      hooks: {
        afterBegin: async () => { attemptCount += 1; },
        afterAccountLock: async ({ lease }) => {
          const observer = await pool.checkout(`${caseId}.57014.cancel-observer`);
          try {
            const longQuery = lease.query('SELECT pg_sleep(30) /* fin-race-06-cancel */');
            const observed = await waitForActiveQuery(observer.client, lease.backendPid, 'fin-race-06-cancel');
            activeQueryObserved = observed.observed;
            requestContextCancelled = true;
            await observer.query('SELECT pg_catalog.pg_cancel_backend($1) AS cancelled', [lease.backendPid]);
            await longQuery;
          } finally {
            observer.release();
          }
        },
      },
    });
    const state = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, '57014-cancelled-context', state);
    assertEvidence(recorder, caseId, '57014 used real active-query cancellation', activeQueryObserved && requestContextCancelled);
    assertEvidence(recorder, caseId, '57014 was not retried and mapped to timeout',
      result.status === 'timeout' && result.code === RESULT_CODES.OPERATION_TIMEOUT && result.sqlstate === '57014' && attemptCount === 1);
    assertEvidence(recorder, caseId, '57014 cleanup committed no effect',
      state.version === 1n && state.transactionCount === 0);
    assertEvidence(recorder, caseId, '57014 observed failed state then idle-confirmed rollback',
      hasEvent(recorder, request.correlationToken, 'transaction.failed_state_observed', (event) => event.observedSqlstate === '25P02')
      && hasEvent(recorder, request.correlationToken, 'transaction.cleanup', (event) => event.confirmed === true));
  } finally {
    await destroyFixture(pool, fixture);
  }
}

async function budgetPreventedRetry({ caseId, protocol, recorder }) {
  const fixture = await createBaseFixture(protocol.pool);
  let attempts = 0;
  try {
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-budget-prevented` });
    const result = await protocol.execute(request, {
      caseId,
      hooks: {
        afterBegin: async () => { attempts += 1; },
        afterAccountLock: async ({ attempt, lease }) => {
          if (attempt === 1) await lease.query('SELECT evidence_raise_sqlstate($1)', ['40001']);
        },
        beforeRetryAdmission: async () => {
          // Consume enough of the 8 s budget that a 5 s statement plus cleanup
          // reserve/backoff cannot fit, without letting the test itself exceed it.
          await delay(POLICY.lockTimeoutMs + 750);
        },
      },
    });
    const state = await readFixtureState(protocol.pool, fixture);
    recordFixtureState(recorder, caseId, 'budget-prevented-retry', state);
    assertEvidence(recorder, caseId, 'insufficient remaining budget prevented second BEGIN',
      result.status === 'busy'
      && result.retryAfterSeconds === 1
      && result.budgetPreventedRetry === true
      && attempts === 1);
    assertEvidence(recorder, caseId, 'budget-prevented retry left financial state unchanged',
      state.version === 1n && state.transactionCount === 0);
  } finally {
    await destroyFixture(protocol.pool, fixture);
  }
}

async function databaseBudgetDeadline({ caseId, config, oneSlotPool, protocol, recorder }) {
  const fixture = await createBaseFixture(oneSlotPool);
  const budgetMs = config.cleanupReserveMs + 300;
  let attempts = 0;
  let firstHandle = null;
  const startedAt = performance.now();
  try {
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-database-deadline` });
    const result = await protocol.execute(request, {
      caseId,
      budgetMs,
      hooks: {
        afterBegin: async ({ lease }) => {
          attempts += 1;
          firstHandle = lease.identity.handleToken;
        },
        afterAccountLock: async ({ lease }) => {
          await lease.query('SELECT pg_sleep(30) /* fin-race-06-database-budget */');
        },
      },
    });
    const elapsed = performance.now() - startedAt;
    const nextBorrower = await oneSlotPool.checkout(`${caseId}.post-deadline-borrower`);
    const nextHandle = nextBorrower.identity.handleToken;
    await nextBorrower.query('SELECT 1 AS clean_after_database_deadline');
    nextBorrower.release();
    const state = await readFixtureState(oneSlotPool, fixture);
    recordFixtureState(recorder, caseId, 'hard-database-budget-deadline', state);
    assertEvidence(recorder, caseId, 'hard database budget stopped the active operation without retry',
      result.status === 'timeout' && result.code === RESULT_CODES.OPERATION_TIMEOUT
      && result.attemptCount === 1 && attempts === 1);
    assertEvidence(recorder, caseId, 'hard database budget remained bounded',
      elapsed < budgetMs + 1_000,
      { configuredBudgetMs: budgetMs, elapsedMs: Number(elapsed.toFixed(3)) });
    assertEvidence(recorder, caseId, 'deadline with unconfirmed cleanup evicted the old handle',
      firstHandle !== null && nextHandle !== firstHandle
      && hasEvent(recorder, request.correlationToken, 'transaction.database_deadline_expired', () => true)
      && hasEvent(recorder, request.correlationToken, 'transaction.cleanup', (event) => event.confirmed === false));
    assertEvidence(recorder, caseId, 'hard deadline left financial state unchanged',
      state.version === 1n && state.transactionCount === 0 && state.idempotencyCount === 0);
  } finally {
    await destroyFixture(oneSlotPool, fixture);
  }
}

async function unconfirmedRollbackEviction({ caseId, oneSlotPool, protocol, recorder }) {
  const fixture = await createBaseFixture(oneSlotPool);
  let firstHandle = null;
  let attempts = 0;
  try {
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-rollback-ack-lost` });
    const result = await protocol.execute(request, {
      caseId,
      hooks: {
        afterBegin: async ({ lease }) => {
          attempts += 1;
          firstHandle ??= lease.identity.handleToken;
        },
        afterAccountLock: async ({ lease }) => lease.query('SELECT evidence_raise_sqlstate($1)', ['40001']),
        beforeRollback: async ({ lease }) => lease.destroySocket('fin-race-06-drop-rollback-ack'),
      },
    });
    const nextBorrower = await oneSlotPool.checkout(`${caseId}.post-eviction-borrower`);
    const nextHandle = nextBorrower.identity.handleToken;
    await nextBorrower.query('SELECT 1 AS clean_new_borrower');
    nextBorrower.release();
    const state = await readFixtureState(oneSlotPool, fixture);
    recordFixtureState(recorder, caseId, 'unconfirmed-rollback-eviction', state);
    assertEvidence(recorder, caseId, 'unconfirmed rollback started no retry', attempts === 1 && result.attemptCount === 1);
    assertEvidence(recorder, caseId, 'unconfirmed rollback evicted application handle',
      firstHandle !== null && nextHandle !== firstHandle);
    assertEvidence(recorder, caseId, 'evicted handle made no financial effect',
      state.version === 1n && state.transactionCount === 0);
    assertEvidence(recorder, caseId, 'eviction occurred without sentinel rehabilitation',
      hasEvent(recorder, request.correlationToken, 'transaction.cleanup', (event) => event.confirmed === false)
      && hasEvent(recorder, null, 'connection.evict', (event) => event.handleToken === firstHandle));
  } finally {
    await destroyFixture(oneSlotPool, fixture);
  }
}

async function authorizationFailureNoRetry({ caseId, oneSlotPool, protocol, recorder }) {
  const fixture = await createBaseFixture(oneSlotPool);
  let attempts = 0;
  try {
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-authorization` });
    request.userId = uuid();
    const result = await protocol.execute(request, {
      caseId,
      hooks: { afterBegin: async () => { attempts += 1; } },
    });
    const state = await readFixtureState(oneSlotPool, fixture);
    recordFixtureState(recorder, caseId, 'authorization-failure', state);
    assertEvidence(recorder, caseId, 'owner mismatch returned unavailable without retry',
      result.status === 'unavailable' && result.attemptCount === 1 && attempts === 1);
    assertEvidence(recorder, caseId, 'owner mismatch made no financial mutation',
      state.version === 1n && state.transactionCount === 0 && state.idempotencyCount === 0);
    assertEvidence(recorder, caseId, 'owner mismatch rollback was explicitly confirmed idle',
      hasEvent(recorder, request.correlationToken, 'transaction.cleanup', (event) => (
        event.reason === 'owner-scoped-account-unavailable'
        && event.confirmed === true
        && event.idleWithoutAssignedXid === true
      )));
  } finally {
    await destroyFixture(oneSlotPool, fixture);
  }
}

async function validationFailureNoRetry({ caseId, oneSlotPool, protocol, recorder }) {
  const fixture = await createBaseFixture(oneSlotPool);
  let attempts = 0;
  let observedError = null;
  try {
    const request = makeRequest('transaction', fixture, {
      requestSeed: `${caseId}-validation`,
      payload: { amountMinor: -1 },
    });
    try {
      await protocol.execute(request, {
        caseId,
        hooks: { afterBegin: async () => { attempts += 1; } },
      });
    } catch (error) {
      observedError = error;
    }
    const state = await readFixtureState(oneSlotPool, fixture);
    recordFixtureState(recorder, caseId, 'validation-failure', state);
    assertEvidence(recorder, caseId, 'database validation error was not retried',
      observedError?.code === '23514' && attempts === 1,
      { sqlstate: observedError?.code ?? null, attempts });
    assertEvidence(recorder, caseId, 'validation failure rolled back complete mutation',
      state.version === 1n && state.transactionCount === 0 && state.idempotencyCount === 0);
    assertEvidence(recorder, caseId, 'validation failure observed failed state and confirmed idle rollback',
      hasEvent(recorder, request.correlationToken, 'transaction.failed_state_observed', (event) => event.observedSqlstate === '25P02')
      && hasEvent(recorder, request.correlationToken, 'transaction.cleanup', (event) => (
        event.confirmed === true && event.idleWithoutAssignedXid === true
      )));
  } finally {
    await destroyFixture(oneSlotPool, fixture);
  }
}

async function proveAccountLockReleased(pool, fixture) {
  const observer = await pool.checkout('fin-race-06.lock-release-observer');
  try {
    await observer.query('BEGIN');
    await observer.query(
      `SELECT id FROM financial_accounts
       WHERE id = $1 AND user_id = $2
       FOR UPDATE NOWAIT`,
      [fixture.accountId, fixture.userId],
    );
    await observer.query('ROLLBACK');
    return true;
  } catch {
    await observer.query('ROLLBACK').catch(() => {});
    return false;
  } finally {
    observer.release();
  }
}

function hasEvent(recorder, correlationToken, type, predicate) {
  return recorder.events.some((event) => event.type === type
    && (correlationToken === null || event.correlationToken === correlationToken)
    && predicate(event));
}

function cleanupBeforeRetry(recorder, correlationToken) {
  const cleanup = recorder.events.find((event) => event.type === 'transaction.cleanup'
    && event.correlationToken === correlationToken && event.attempt === 1 && event.confirmed === true);
  const retry = recorder.events.find((event) => event.type === 'transaction.retry_scheduled'
    && event.correlationToken === correlationToken && event.attempt === 1);
  const second = recorder.events.find((event) => event.type === 'transaction.attempt_started'
    && event.correlationToken === correlationToken && event.attempt === 2);
  return Boolean(cleanup && retry && second && cleanup.sequence < retry.sequence && retry.sequence < second.sequence);
}
