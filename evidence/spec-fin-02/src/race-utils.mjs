import { DeterministicBarrier, waitForPostgresLockWait } from './barriers.mjs';
import { deferred, invariant, safeToken, withTimeout } from './util.mjs';

export function assertEvidence(recorder, caseId, name, condition, details = {}) {
  recorder.assertion(caseId, name, condition, details);
  invariant(condition, `${caseId}: ${name}`, details);
}

export async function runForcedWinnerPair({
  caseId,
  order,
  protocol,
  pool,
  recorder,
  winnerRequest,
  loserRequest,
  expectedLoserStatus = 'stale',
}) {
  const barrier = new DeterministicBarrier(`${caseId}-${order}-${safeToken('barrier')}`);
  const loserPid = deferred();
  const loserAccountLock = deferred();
  let loserLockStartedAt = null;
  const winnerPromise = protocol.execute(winnerRequest, {
    caseId,
    hooks: {
      afterAccountLock: async ({ lease }) => {
        recorder.event('barrier.winner_account_locked', {
          caseId,
          order,
          correlationToken: winnerRequest.correlationToken,
          backendToken: lease.identity.backendToken,
        });
        await barrier.hold({ backendPid: lease.backendPid });
      },
    },
  });

  await barrier.waitUntilReached();
  const loserPromise = protocol.execute(loserRequest, {
    caseId,
    hooks: {
      afterBegin: async ({ lease }) => {
        if (loserLockStartedAt === null) loserLockStartedAt = performance.now();
        loserPid.resolve(lease.backendPid);
      },
      afterAccountLock: async () => {
        if (loserLockStartedAt !== null) {
          loserAccountLock.resolve(Number((performance.now() - loserLockStartedAt).toFixed(3)));
        }
      },
    },
  });

  const pid = await withTimeout(loserPid.promise, 5_000, `${caseId} loser BEGIN`);
  const observer = await pool.checkout(`${caseId}.lock-observer`);
  let waitEvidence;
  try {
    waitEvidence = await waitForPostgresLockWait(observer.client, pid);
  } catch (error) {
    waitEvidence = { observed: false, elapsedMs: null, blockerCount: 0, error: error.message };
  } finally {
    observer.release();
    barrier.release();
  }
  const [winner, loser] = await Promise.all([winnerPromise, loserPromise]);
  const lockWaitElapsedMs = await withTimeout(
    loserAccountLock.promise,
    5_000,
    `${caseId} loser account-lock completion`,
  );
  recorder.event('postgres.account_lock_wait', {
    caseId,
    order,
    correlationToken: loserRequest.correlationToken,
    elapsedMs: lockWaitElapsedMs,
  });
  assertEvidence(
    recorder,
    caseId,
    `${order}: loser waits on PostgreSQL lock before winner release`,
    waitEvidence.observed,
    {
      order,
      lockWaitElapsedMs: waitEvidence.elapsedMs,
      blockerCount: waitEvidence.blockerCount,
      sanitizedLocks: waitEvidence.locks || [],
    },
  );
  assertEvidence(recorder, caseId, `${order}: forced winner committed`, winner.status === 'committed', {
    order,
    observed: winner.status,
  });
  assertEvidence(
    recorder,
    caseId,
    `${order}: waiter result is ${expectedLoserStatus}`,
    loser.status === expectedLoserStatus,
    { order, observed: loser.status, code: loser.code },
  );
  assertEvidence(
    recorder,
    caseId,
    `${order}: business/idempotency waiter was not internally retried`,
    loser.attemptCount === 1,
    { order, attemptCount: loser.attemptCount },
  );
  return { winner, loser, waitEvidence, lockWaitElapsedMs };
}
