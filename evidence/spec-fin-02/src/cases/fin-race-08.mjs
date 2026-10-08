import {
  DeterministicBarrier,
  LockOrderGuard,
  waitForPostgresLockWait,
} from '../barriers.mjs';
import {
  createBaseFixture,
  destroyFixture,
  readFixtureState,
  recordFixtureState,
} from '../fixtures.mjs';
import { makeRequest } from '../protocol.mjs';
import { assertEvidence, runForcedWinnerPair } from '../race-utils.mjs';
import {
  deferred,
  safeToken,
  sha256,
  withTimeout,
} from '../util.mjs';

export async function runFinRace08(context) {
  const caseId = 'FIN-RACE-08';
  const { recorder } = context;
  recorder.startCase(caseId);
  await proveSameAccountSerialization(context);
  await proveDistinctAccountConcurrency(context);
  await proveMixedSingleAndMultiAccountOrder(context);
  await proveCoveredPathsAndOrder(context);
  proveProhibitedOrderRejected(context);
  recorder.passCase(caseId, {
    coveredPaths: ['user', 'worker', 'operator', 'domain'],
    mixedSingleMultiAccountOrder: true,
  });
}

async function proveSameAccountSerialization({ pool, protocol, recorder }) {
  const caseId = 'FIN-RACE-08';
  const fixture = await createBaseFixture(pool);
  try {
    const first = makeRequest('transaction', fixture, { requestSeed: `${caseId}-same-account-first` });
    const second = makeRequest('snapshot', fixture, { requestSeed: `${caseId}-same-account-second` });
    const result = await runForcedWinnerPair({
      caseId,
      order: 'same-account',
      protocol,
      pool,
      recorder,
      winnerRequest: first,
      loserRequest: second,
    });
    const state = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, 'same-account-serialization', state);
    assertEvidence(recorder, caseId, 'same-account writes serialized to winner/stale loser',
      result.waitEvidence.observed && state.version === 2n && state.transactionCount === 1 && state.snapshotCount === 1);
  } finally {
    await destroyFixture(pool, fixture);
  }
}

async function proveDistinctAccountConcurrency({ pool, protocol, recorder }) {
  const caseId = 'FIN-RACE-08';
  const fixtureA = await createBaseFixture(pool);
  const fixtureB = await createBaseFixture(pool);
  const barrier = new DeterministicBarrier(`${caseId}-distinct-${safeToken('barrier')}`);
  let operationA;
  let operationB;
  try {
    const requestA = makeRequest('transaction', fixtureA, { requestSeed: `${caseId}-account-a` });
    const requestB = makeRequest('transaction', fixtureB, { requestSeed: `${caseId}-account-b` });
    operationA = protocol.execute(requestA, {
      caseId,
      hooks: {
        afterAccountLock: async () => barrier.hold(),
      },
    });
    await barrier.waitUntilReached();
    operationB = protocol.execute(requestB, { caseId });
    let bFinishedBeforeARelease = false;
    let bResult;
    try {
      bResult = await withTimeout(operationB, 5_000, 'distinct-account operation');
      bFinishedBeforeARelease = true;
    } finally {
      barrier.release();
    }
    const aResult = await operationA;
    assertEvidence(recorder, caseId, 'distinct account committed while first account lock remained held',
      bFinishedBeforeARelease && bResult.status === 'committed' && aResult.status === 'committed');
    const [stateA, stateB] = await Promise.all([
      readFixtureState(pool, fixtureA),
      readFixtureState(pool, fixtureB),
    ]);
    recordFixtureState(recorder, caseId, 'distinct-account-a', stateA);
    recordFixtureState(recorder, caseId, 'distinct-account-b', stateB);
    assertEvidence(recorder, caseId, 'distinct accounts incremented independently',
      stateA.version === 2n && stateB.version === 2n
      && stateA.transactionCount === 1 && stateB.transactionCount === 1);
  } finally {
    if (barrier.isReached && !barrier.isReleased) barrier.release();
    await Promise.allSettled([operationA, operationB].filter(Boolean));
    await destroyFixture(pool, fixtureA);
    await destroyFixture(pool, fixtureB);
  }
}

async function proveMixedSingleAndMultiAccountOrder({ pool, protocol, recorder }) {
  const caseId = 'FIN-RACE-08';
  const fixtureA = await createBaseFixture(pool);
  const fixtureB = await createBaseFixture(pool);
  const ordered = [fixtureA, fixtureB].sort(compareAccountUuid);
  const held = ordered[0];
  const other = ordered[1];
  const barrier = new DeterministicBarrier(`${caseId}-mixed-${safeToken('barrier')}`);
  const multiStarted = deferred();
  let singleOperation;
  let multiOperation;
  try {
    const singleRequest = makeRequest('transaction', held, {
      requestSeed: `${caseId}-mixed-single`,
      actorPath: 'domain',
    });
    singleOperation = protocol.execute(singleRequest, {
      caseId,
      hooks: { afterAccountLock: async () => barrier.hold() },
    });
    await barrier.waitUntilReached();

    // Deliberately supply descending IDs. The probe must sort every account lock
    // before it requests either narrower snapshot row.
    multiOperation = runMultiAccountLockProbe({
      pool,
      recorder,
      caseId,
      accounts: [other, held],
      onBegin: (pid) => multiStarted.resolve(pid),
    });
    const multiPid = await withTimeout(multiStarted.promise, 5_000, 'mixed multi-account BEGIN');
    const observer = await pool.checkout(`${caseId}.mixed-lock-observer`);
    let waitEvidence;
    try {
      waitEvidence = await waitForPostgresLockWait(observer.client, multiPid);
    } finally {
      observer.release();
    }

    const otherStillFree = await canLockAccountNowait(pool, other);
    barrier.release();
    const [singleResult, multiResult] = await Promise.all([singleOperation, multiOperation]);
    assertEvidence(recorder, caseId, 'mixed multi-account request waited on globally first account',
      waitEvidence.observed && waitEvidence.blockerCount >= 1,
      { lockWaitElapsedMs: waitEvidence.elapsedMs, blockerCount: waitEvidence.blockerCount });
    assertEvidence(recorder, caseId, 'blocked multi-account request had not pre-locked later account', otherStillFree);
    assertEvidence(recorder, caseId, 'multi-account request sorted descending input into stable UUID order',
      multiResult.accountOrder.join(',') === ordered.map(({ accountId }) => accountId).join(','));
    assertEvidence(recorder, caseId, 'multi-account request locked all accounts before narrower snapshots',
      multiResult.lockKinds.join(',') === 'account,account,snapshot,snapshot');
    assertEvidence(recorder, caseId, 'multi-account request used stable UUID order within snapshot rank',
      multiResult.snapshotOrder.join(',')
        === [...ordered]
          .sort(compareSnapshotUuid)
          .map(({ initialSnapshotId }) => initialSnapshotId)
          .join(','));
    assertEvidence(recorder, caseId, 'mixed single/multi-account path completed without duplicate financial effect',
      singleResult.status === 'committed' && multiResult.status === 'committed');

    const [heldState, otherState] = await Promise.all([
      readFixtureState(pool, held),
      readFixtureState(pool, other),
    ]);
    recordFixtureState(recorder, caseId, 'mixed-single-account-writer', heldState);
    recordFixtureState(recorder, caseId, 'mixed-multi-account-lock-only-peer', otherState);
    assertEvidence(recorder, caseId, 'lock-only multi-account probe made no financial mutation',
      heldState.version === 2n && heldState.transactionCount === 1
      && otherState.version === 1n && otherState.transactionCount === 0);
  } finally {
    if (barrier.isReached && !barrier.isReleased) barrier.release();
    await Promise.allSettled([singleOperation, multiOperation].filter(Boolean));
    await Promise.all([
      destroyFixture(pool, fixtureA),
      destroyFixture(pool, fixtureB),
    ]);
  }
}

async function runMultiAccountLockProbe({ pool, recorder, caseId, accounts, onBegin }) {
  const lease = await pool.checkout(`${caseId}.multi-account-probe`);
  const ordered = [...accounts].sort(compareAccountUuid);
  const guard = new LockOrderGuard({
    caseId,
    correlationToken: safeToken('multi-account'),
    recorder,
  });
  const lockKinds = [];
  try {
    await lease.begin();
    onBegin(lease.backendPid);
    for (const account of ordered) {
      guard.record('account', `account-${sha256(account.accountId).slice(0, 12)}`);
      const locked = await lease.query(
        `SELECT id FROM financial_accounts
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [account.accountId, account.userId],
      );
      if (locked.rowCount !== 1) throw new Error('Multi-account probe could not lock owner-scoped account');
      lockKinds.push('account');
    }
    const snapshots = [...accounts].sort(compareSnapshotUuid);
    for (const account of snapshots) {
      guard.record('snapshot', `snapshot-${sha256(account.initialSnapshotId).slice(0, 12)}`);
      const locked = await lease.query(
        `SELECT id FROM balance_snapshots
         WHERE id = $1 AND user_id = $2 AND account_id = $3
         FOR UPDATE`,
        [account.initialSnapshotId, account.userId, account.accountId],
      );
      if (locked.rowCount !== 1) throw new Error('Multi-account probe could not lock owner-scoped snapshot');
      lockKinds.push('snapshot');
    }
    await lease.query('COMMIT');
    return {
      status: 'committed',
      accountOrder: ordered.map(({ accountId }) => accountId),
      snapshotOrder: snapshots.map(({ initialSnapshotId }) => initialSnapshotId),
      lockKinds,
    };
  } catch (error) {
    await lease.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    lease.release();
  }
}

async function canLockAccountNowait(pool, fixture) {
  const lease = await pool.checkout('fin-race-08.nowait-order-probe');
  try {
    await lease.query('BEGIN');
    const locked = await lease.query(
      `SELECT id FROM financial_accounts
       WHERE id = $1 AND user_id = $2
       FOR UPDATE NOWAIT`,
      [fixture.accountId, fixture.userId],
    );
    await lease.query('ROLLBACK');
    return locked.rowCount === 1;
  } catch {
    await lease.query('ROLLBACK').catch(() => {});
    return false;
  } finally {
    lease.release();
  }
}

async function proveCoveredPathsAndOrder({ pool, protocol, recorder }) {
  const caseId = 'FIN-RACE-08';
  const fixture = await createBaseFixture(pool);
  const paths = ['user', 'worker', 'operator', 'domain'];
  const correlations = [];
  try {
    let expectedVersion = 1n;
    for (const actorPath of paths) {
      const request = makeRequest('transaction', fixture, {
        requestSeed: `${caseId}-${actorPath}`,
        actorPath,
        expectedVersion,
      });
      correlations.push(request.correlationToken);
      const result = await protocol.execute(request, { caseId });
      assertEvidence(recorder, caseId, `${actorPath} path used shared protocol and committed`, result.status === 'committed');
      expectedVersion += 1n;
    }
    const state = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, 'covered-user-worker-operator-domain-paths', state);
    assertEvidence(recorder, caseId, 'all covered paths incremented once through account boundary',
      state.version === 5n && state.transactionCount === 4 && state.auditCount === 4);
    for (const correlationToken of correlations) {
      const order = recorder.events
        .filter((event) => event.type === 'lock_order.recorded' && event.correlationToken === correlationToken)
        .map((event) => event.rank);
      assertEvidence(recorder, caseId, `account-first nondecreasing lock order for ${correlationToken}`,
        order.length >= 3 && order[0] === 1 && order.every((rank, index) => index === 0 || rank >= order[index - 1]),
        { ranks: order });
    }
  } finally {
    await destroyFixture(pool, fixture);
  }
}

function compareAccountUuid(left, right) {
  if (left.accountId < right.accountId) return -1;
  if (left.accountId > right.accountId) return 1;
  return 0;
}

function compareSnapshotUuid(left, right) {
  if (left.initialSnapshotId < right.initialSnapshotId) return -1;
  if (left.initialSnapshotId > right.initialSnapshotId) return 1;
  return 0;
}

function proveProhibitedOrderRejected({ recorder }) {
  const caseId = 'FIN-RACE-08';
  const guard = new LockOrderGuard({
    caseId,
    correlationToken: safeToken('prohibited-order'),
    recorder,
  });
  let detected = false;
  try {
    guard.record('transaction', 'synthetic-child');
  } catch (error) {
    detected = error.code === 'LOCK_ORDER_VIOLATION';
  }
  assertEvidence(recorder, caseId, 'instrumentation rejects child-before-account lock order', detected);
}
