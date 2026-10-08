import { PostgreSqlFaultProxy } from '../fault-proxy.mjs';
import {
  createBaseFixture,
  destroyFixture,
  readFixtureState,
  recordFixtureState,
} from '../fixtures.mjs';
import { makeRequest } from '../protocol.mjs';
import { createProxyLease } from '../proxy-lease.mjs';
import { assertEvidence } from '../race-utils.mjs';

export async function runFinRace07(context) {
  const caseId = 'FIN-RACE-07';
  const { config, recorder } = context;
  recorder.startCase(caseId, { poolMode: config.poolMode });
  if (config.poolMode === 'transaction' || config.poolMode === 'unknown') {
    recorder.blockCase(
      caseId,
      `Connection-level commit evidence requires direct or session mode; configured mode is ${config.poolMode}.`,
      { requiredMode: 'direct|session' },
    );
    return;
  }
  await beforeCommitDisconnect(context);
  await sentCommitOriginalRollback(context);
  await sentCommitAcknowledgementLost(context);
  await committedBeforeResponseLoss(context);
  await unresolvedRecoveryBudget(context);
  recorder.passCase(caseId, { faultInjection: 'connection-and-wire-proxy' });
}

async function beforeCommitDisconnect(context) {
  const { config, pool, protocol, recorder } = context;
  const caseId = 'FIN-RACE-07';
  const fixture = await createBaseFixture(pool);
  const proxy = new PostgreSqlFaultProxy({ config, recorder, caseId, mode: 'pass' });
  try {
    const endpoint = await proxy.start();
    const lease = await createProxyLease(config, recorder, endpoint.host, endpoint.port, `${caseId}.before-commit`);
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-before-commit` });
    const original = await protocol.execute(request, {
      caseId,
      leaseProvider: singleLeaseProvider(lease),
      hooks: {
        beforeCommit: async ({ lease: activeLease }) => {
          activeLease.destroySocket('fin-race-07-before-commit');
          throw new Error('Connection cut before COMMIT dispatch');
        },
      },
    });
    const closure = await proxy.waitForConnectionsClosed();
    const preRecovery = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, 'before-commit-pre-recovery', preRecovery);
    const recovery = await protocol.execute(request, { caseId, recoveryMode: true });
    const final = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, 'before-commit-after-recovery', final);
    assertEvidence(recorder, caseId, 'before COMMIT disconnect closed original client/backend path before recovery',
      closure.downstreamClosed && closure.upstreamClosed);
    assertEvidence(recorder, caseId, 'before COMMIT disconnect left no original effect',
      preRecovery.version === 1n && preRecovery.transactionCount === 0);
    assertEvidence(recorder, caseId, 'before COMMIT same-key recovery executed once',
      original.attemptCount === 1 && recovery.status === 'committed' && recovery.attemptCount === 1);
    assertEvidence(recorder, caseId, 'before COMMIT branch has one final effect/version increment',
      final.version === 2n && final.transactionCount === 1 && final.idempotencyCount === 1);
  } finally {
    await proxy.stop();
    await destroyFixture(pool, fixture);
  }
}

async function sentCommitOriginalRollback(context) {
  const { config, pool, protocol, recorder } = context;
  const caseId = 'FIN-RACE-07';
  const fixture = await createBaseFixture(pool);
  const proxy = new PostgreSqlFaultProxy({
    config,
    recorder,
    caseId,
    mode: 'drop-commit-before-upstream',
  });
  try {
    const endpoint = await proxy.start();
    const lease = await createProxyLease(config, recorder, endpoint.host, endpoint.port, `${caseId}.sent-rollback`);
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-sent-original-rollback` });
    const original = await protocol.execute(request, {
      caseId,
      leaseProvider: singleLeaseProvider(lease),
    });
    const fault = await proxy.waitForFault();
    const closure = await proxy.waitForConnectionsClosed();
    const preRecovery = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, 'commit-withheld-pre-recovery', preRecovery);
    const recovery = await protocol.execute(request, { caseId, recoveryMode: true });
    const final = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, 'commit-withheld-after-recovery', final);
    assertEvidence(recorder, caseId, 'COMMIT sent to proxy but withheld from backend',
      fault.triggered && fault.commitForwarded === false && original.status === 'unknown');
    assertEvidence(recorder, caseId, 'withheld-COMMIT backend path terminated before same-key recovery',
      closure.downstreamClosed && closure.upstreamClosed);
    assertEvidence(recorder, caseId, 'withheld COMMIT rolled back on connection termination',
      preRecovery.version === 1n && preRecovery.transactionCount === 0);
    assertEvidence(recorder, caseId, 'same-key recovery safely executed original rollback branch once',
      recovery.status === 'committed' && recovery.attemptCount === 1
      && final.version === 2n && final.transactionCount === 1);
  } finally {
    await proxy.stop();
    await destroyFixture(pool, fixture);
  }
}

async function sentCommitAcknowledgementLost(context) {
  const { config, pool, protocol, recorder } = context;
  const caseId = 'FIN-RACE-07';
  const fixture = await createBaseFixture(pool);
  const proxy = new PostgreSqlFaultProxy({
    config,
    recorder,
    caseId,
    mode: 'drop-commit-ack-after-upstream',
  });
  try {
    const endpoint = await proxy.start();
    const lease = await createProxyLease(config, recorder, endpoint.host, endpoint.port, `${caseId}.ack-lost`);
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-ack-lost` });
    const original = await protocol.execute(request, {
      caseId,
      leaseProvider: singleLeaseProvider(lease),
    });
    const fault = await proxy.waitForFault();
    const closure = await proxy.waitForConnectionsClosed();
    const recovery = await protocol.execute(request, { caseId, recoveryMode: true });
    const final = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, 'commit-acknowledgement-lost', final);
    assertEvidence(recorder, caseId, 'proxy proved backend commit while suppressing acknowledgement',
      fault.triggered && fault.commitForwarded && !fault.commitAcknowledgementForwarded
      && fault.commandCompleteObservedUpstream && fault.readyForQueryStatus === 'I');
    assertEvidence(recorder, caseId, 'lost-acknowledgement path terminated before same-key recovery',
      closure.downstreamClosed && closure.upstreamClosed);
    assertEvidence(recorder, caseId, 'lost acknowledgement returned unknown before recovery',
      original.status === 'unknown' && original.code === 'FINANCIAL_RESULT_UNKNOWN');
    assertEvidence(recorder, caseId, 'same-key recovery replayed committed result in one attempt',
      recovery.status === 'idempotent_replay' && recovery.attemptCount === 1);
    assertEvidence(recorder, caseId, 'acknowledgement-loss branch has no duplicate effect/version',
      final.version === 2n && final.transactionCount === 1 && final.idempotencyCount === 1);
  } finally {
    await proxy.stop();
    await destroyFixture(pool, fixture);
  }
}

async function committedBeforeResponseLoss(context) {
  const { config, pool, protocol, recorder } = context;
  const caseId = 'FIN-RACE-07';
  const fixture = await createBaseFixture(pool);
  const proxy = new PostgreSqlFaultProxy({ config, recorder, caseId, mode: 'pass' });
  try {
    const endpoint = await proxy.start();
    const lease = await createProxyLease(config, recorder, endpoint.host, endpoint.port, `${caseId}.after-commit`);
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-after-commit-before-response` });
    const original = await protocol.execute(request, {
      caseId,
      leaseProvider: singleLeaseProvider(lease),
      hooks: {
        afterCommit: async () => {
          proxy.closeAfterAcknowledgedCommit();
          throw new Error('Response channel lost after COMMIT acknowledgement');
        },
      },
    });
    const closure = await proxy.waitForConnectionsClosed();
    const recovery = await protocol.execute(request, { caseId, recoveryMode: true });
    const final = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, 'post-commit-response-loss', final);
    assertEvidence(recorder, caseId, 'post-COMMIT response channel closed before same-key recovery',
      closure.downstreamClosed && closure.upstreamClosed);
    assertEvidence(recorder, caseId, 'post-COMMIT response loss surfaced unknown result', original.status === 'unknown');
    assertEvidence(recorder, caseId, 'post-COMMIT response loss recovered same stored result',
      recovery.status === 'idempotent_replay' && recovery.attemptCount === 1);
    assertEvidence(recorder, caseId, 'post-COMMIT response loss has one effect/version increment',
      final.version === 2n && final.transactionCount === 1 && final.idempotencyCount === 1);
  } finally {
    await proxy.stop();
    await destroyFixture(pool, fixture);
  }
}

async function unresolvedRecoveryBudget(context) {
  const { config, pool, protocol, recorder } = context;
  const caseId = 'FIN-RACE-07';
  const fixture = await createBaseFixture(pool);
  const proxy = new PostgreSqlFaultProxy({
    config,
    recorder,
    caseId,
    mode: 'drop-commit-ack-after-upstream',
  });
  let blocker = null;
  try {
    const endpoint = await proxy.start();
    const lease = await createProxyLease(config, recorder, endpoint.host, endpoint.port, `${caseId}.recovery-budget`);
    const request = makeRequest('transaction', fixture, { requestSeed: `${caseId}-recovery-budget` });
    const original = await protocol.execute(request, {
      caseId,
      leaseProvider: singleLeaseProvider(lease),
    });
    const fault = await proxy.waitForFault();
    const closure = await proxy.waitForConnectionsClosed();
    blocker = await pool.checkout(`${caseId}.recovery-lock-blocker`);
    await blocker.query('BEGIN');
    await blocker.query(
      `SELECT id FROM financial_accounts
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [fixture.accountId, fixture.userId],
    );
    let recoveryBegins = 0;
    const recovery = await protocol.execute(request, {
      caseId,
      recoveryMode: true,
      hooks: { afterBegin: async () => { recoveryBegins += 1; } },
    });
    await blocker.query('ROLLBACK');
    blocker.release();
    blocker = null;
    const finalRetry = await protocol.execute(request, { caseId, recoveryMode: true });
    const final = await readFixtureState(pool, fixture);
    recordFixtureState(recorder, caseId, 'recovery-budget-unresolved-then-retried', final);
    assertEvidence(recorder, caseId, 'recovery-budget original session ended before bounded recovery',
      closure.downstreamClosed && closure.upstreamClosed);
    assertEvidence(recorder, caseId, 'recovery-budget fixture committed original with hidden acknowledgement',
      original.status === 'unknown' && fault.committed === true);
    assertEvidence(recorder, caseId, 'unresolved recovery returned result unknown with no nested retry',
      recovery.status === 'unknown' && recovery.attemptCount === 1 && recoveryBegins === 1);
    assertEvidence(recorder, caseId, 'later same-key retry recovered stored result',
      finalRetry.status === 'idempotent_replay' && finalRetry.attemptCount === 1);
    assertEvidence(recorder, caseId, 'blocked recovery made no duplicate effect/version increment',
      final.version === 2n && final.transactionCount === 1 && final.idempotencyCount === 1);
  } finally {
    if (blocker) {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
    await proxy.stop();
    await destroyFixture(pool, fixture);
  }
}

function singleLeaseProvider(lease) {
  let used = false;
  return async () => {
    if (used) throw new Error('Proxy evidence path attempted an implicit second checkout');
    used = true;
    return lease;
  };
}
