import { POLICY, RESULT_CODES } from '../constants.mjs';
import {
  createBaseFixture,
  destroyFixture,
  readFixtureState,
  readOccurrence,
  readTransactions,
} from '../fixtures.mjs';
import { makeRequest } from '../protocol.mjs';
import { assertEvidence, runForcedWinnerPair } from '../race-utils.mjs';
import { percentile, safeToken, sha256 } from '../util.mjs';

export async function runFinRace01(context) {
  const caseId = 'FIN-RACE-01';
  const { config, pool, protocol, recorder } = context;
  recorder.startCase(caseId, { repetitionsPerOrder: config.repetitions });
  const lockWaits = [];
  for (const order of ['transaction-first', 'snapshot-first']) {
    for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
      const fixture = await createBaseFixture(pool);
      try {
        const transaction = makeRequest('transaction', fixture, { requestSeed: `${caseId}-${order}-${repetition}-tx` });
        const snapshot = makeRequest('snapshot', fixture, { requestSeed: `${caseId}-${order}-${repetition}-snapshot` });
        const winnerRequest = order === 'transaction-first' ? transaction : snapshot;
        const loserRequest = order === 'transaction-first' ? snapshot : transaction;
        const race = await runForcedWinnerPair({
          caseId,
          order: `${order}-${repetition}`,
          protocol,
          pool,
          recorder,
          winnerRequest,
          loserRequest,
        });
        lockWaits.push(race.lockWaitElapsedMs);
        const state = await readFixtureState(pool, fixture);
        recordFinalState(recorder, caseId, order, repetition, state);
        const transactions = await readTransactions(pool, fixture);
        assertEvidence(recorder, caseId, `${order}/${repetition}: version incremented exactly once`, state.version === 2n);
        assertEvidence(recorder, caseId, `${order}/${repetition}: two stable idempotency outcomes`, state.idempotencyCount === 2);
        if (order === 'transaction-first') {
          assertEvidence(recorder, caseId, `${order}/${repetition}: losing snapshot did not create anchor`, state.snapshotCount === 1);
          assertEvidence(recorder, caseId, `${order}/${repetition}: one transaction effect`, state.transactionCount === 1 && state.postedCount === 1);
          assertEvidence(
            recorder,
            caseId,
            `${order}/${repetition}: transaction remained on reviewed anchor`,
            transactions[0]?.balance_snapshot_id === fixture.initialSnapshotId,
          );
          assertEvidence(recorder, caseId, `${order}/${repetition}: snapshot stale code`, race.loser.code === RESULT_CODES.SNAPSHOT_STALE);
        } else {
          assertEvidence(recorder, caseId, `${order}/${repetition}: one new authoritative anchor`, state.snapshotCount === 2);
          assertEvidence(recorder, caseId, `${order}/${repetition}: losing transaction created no effect`, state.transactionCount === 0);
          assertEvidence(recorder, caseId, `${order}/${repetition}: transaction stale code`, race.loser.code === RESULT_CODES.FINANCIAL_STALE);
        }
      } finally {
        await destroyFixture(pool, fixture);
      }
    }
  }
  finishRepeatedCase(recorder, caseId, config, lockWaits);
}

export async function runFinRace02(context) {
  const caseId = 'FIN-RACE-02';
  const { config, pool, protocol, recorder } = context;
  recorder.startCase(caseId, { repetitionsPerOrder: config.repetitions });
  const lockWaits = [];
  for (const order of ['correction-first', 'snapshot-first']) {
    for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
      const fixture = await createBaseFixture(pool, { withSourceTransaction: true, linkedOccurrence: true });
      try {
        const correction = makeRequest('correction', fixture, { requestSeed: `${caseId}-${order}-${repetition}-correction` });
        const snapshot = makeRequest('snapshot', fixture, { requestSeed: `${caseId}-${order}-${repetition}-snapshot` });
        const winnerRequest = order === 'correction-first' ? correction : snapshot;
        const loserRequest = order === 'correction-first' ? snapshot : correction;
        const race = await runForcedWinnerPair({
          caseId,
          order: `${order}-${repetition}`,
          protocol,
          pool,
          recorder,
          winnerRequest,
          loserRequest,
        });
        lockWaits.push(race.lockWaitElapsedMs);
        const state = await readFixtureState(pool, fixture);
        recordFinalState(recorder, caseId, order, repetition, state);
        const occurrence = await readOccurrence(pool, fixture.occurrenceId);
        const transactions = await readTransactions(pool, fixture);
        assertEvidence(recorder, caseId, `${order}/${repetition}: version incremented exactly once`, state.version === 3n);
        if (order === 'correction-first') {
          assertEvidence(recorder, caseId, `${order}/${repetition}: correction chain atomic`,
            state.transactionCount === 2 && state.voidedCount === 1 && state.postedCount === 1 && state.replacementCount === 1);
          const replacement = transactions.find((row) => row.supersedes_transaction_id === fixture.sourceTransactionId);
          assertEvidence(recorder, caseId, `${order}/${repetition}: occurrence pointer transferred atomically`,
            occurrence?.confirmed_transaction_id === replacement?.id);
          assertEvidence(recorder, caseId, `${order}/${repetition}: losing snapshot made no anchor`, state.snapshotCount === 1);
          assertEvidence(recorder, caseId, `${order}/${repetition}: snapshot stale code`, race.loser.code === RESULT_CODES.SNAPSHOT_STALE);
        } else {
          assertEvidence(recorder, caseId, `${order}/${repetition}: snapshot committed alone`, state.snapshotCount === 2);
          assertEvidence(recorder, caseId, `${order}/${repetition}: stale correction left source posted`,
            state.transactionCount === 1 && state.postedCount === 1 && state.voidedCount === 0);
          assertEvidence(recorder, caseId, `${order}/${repetition}: stale correction retained occurrence source`,
            occurrence?.confirmed_transaction_id === fixture.sourceTransactionId);
          assertEvidence(recorder, caseId, `${order}/${repetition}: correction stale code`, race.loser.code === RESULT_CODES.CORRECTION_STALE);
        }
      } finally {
        await destroyFixture(pool, fixture);
      }
    }
  }
  finishRepeatedCase(recorder, caseId, config, lockWaits);
}

export async function runFinRace03(context) {
  const caseId = 'FIN-RACE-03';
  const { config, pool, protocol, recorder } = context;
  recorder.startCase(caseId, { repetitionsPerOrder: config.repetitions });
  const lockWaits = [];
  for (const order of ['correction-first', 'void-first']) {
    for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
      const fixture = await createBaseFixture(pool, { withSourceTransaction: true });
      try {
        const correction = makeRequest('correction', fixture, { requestSeed: `${caseId}-${order}-${repetition}-correction` });
        const standaloneVoid = makeRequest('void', fixture, { requestSeed: `${caseId}-${order}-${repetition}-void` });
        const winnerRequest = order === 'correction-first' ? correction : standaloneVoid;
        const loserRequest = order === 'correction-first' ? standaloneVoid : correction;
        const race = await runForcedWinnerPair({
          caseId,
          order: `${order}-${repetition}`,
          protocol,
          pool,
          recorder,
          winnerRequest,
          loserRequest,
        });
        lockWaits.push(race.lockWaitElapsedMs);
        const state = await readFixtureState(pool, fixture);
        recordFinalState(recorder, caseId, order, repetition, state);
        assertEvidence(recorder, caseId, `${order}/${repetition}: one financial winner`, state.version === 3n);
        assertEvidence(recorder, caseId, `${order}/${repetition}: source transitioned exactly once`, state.voidedCount === 1);
        assertEvidence(recorder, caseId, `${order}/${repetition}: no correction branch`, state.replacementCount <= 1);
        assertEvidence(recorder, caseId, `${order}/${repetition}: losing request stale`, race.loser.code === RESULT_CODES.CORRECTION_STALE);
        if (order === 'correction-first') {
          assertEvidence(recorder, caseId, `${order}/${repetition}: exactly one replacement`,
            state.transactionCount === 2 && state.replacementCount === 1 && state.postedCount === 1);
        } else {
          assertEvidence(recorder, caseId, `${order}/${repetition}: standalone void made no replacement`,
            state.transactionCount === 1 && state.replacementCount === 0 && state.postedCount === 0);
        }
      } finally {
        await destroyFixture(pool, fixture);
      }
    }
  }
  finishRepeatedCase(recorder, caseId, config, lockWaits);
}

export async function runFinRace04(context) {
  const caseId = 'FIN-RACE-04';
  const { config, pool, protocol, recorder } = context;
  recorder.startCase(caseId, { repetitionsPerOrder: config.repetitions });
  const lockWaits = [];
  for (const order of ['snapshot-a-first', 'snapshot-b-first']) {
    for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
      const fixture = await createBaseFixture(pool);
      try {
        const snapshotA = makeRequest('snapshot', fixture, { requestSeed: `${caseId}-${order}-${repetition}-a` });
        const snapshotB = makeRequest('snapshot', fixture, { requestSeed: `${caseId}-${order}-${repetition}-b` });
        const winnerRequest = order === 'snapshot-a-first' ? snapshotA : snapshotB;
        const loserRequest = order === 'snapshot-a-first' ? snapshotB : snapshotA;
        const race = await runForcedWinnerPair({
          caseId,
          order: `${order}-${repetition}`,
          protocol,
          pool,
          recorder,
          winnerRequest,
          loserRequest,
        });
        lockWaits.push(race.lockWaitElapsedMs);
        const state = await readFixtureState(pool, fixture);
        recordFinalState(recorder, caseId, order, repetition, state);
        assertEvidence(recorder, caseId, `${order}/${repetition}: one version increment`, state.version === 2n);
        assertEvidence(recorder, caseId, `${order}/${repetition}: exactly one new snapshot`, state.snapshotCount === 2);
        assertEvidence(recorder, caseId, `${order}/${repetition}: losing snapshot stale`, race.loser.code === RESULT_CODES.SNAPSHOT_STALE);
        assertEvidence(recorder, caseId, `${order}/${repetition}: no transaction side effect`, state.transactionCount === 0);
      } finally {
        await destroyFixture(pool, fixture);
      }
    }
  }
  finishRepeatedCase(recorder, caseId, config, lockWaits);
}

export async function runFinRace05(context) {
  const caseId = 'FIN-RACE-05';
  const { config, pool, protocol, recorder } = context;
  recorder.startCase(caseId, { repetitionsPerOrder: config.repetitions });
  const lockWaits = [];
  for (const order of ['caller-a-first', 'caller-b-first']) {
    for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
      const fixture = await createBaseFixture(pool);
      try {
        const keyDigest = sha256(`synthetic-shared-key-${caseId}-${order}-${repetition}`);
        const first = makeRequest('transaction', fixture, {
          requestSeed: `${caseId}-${order}-${repetition}-shared`,
          keyDigest,
        });
        const second = {
          ...first,
          correlationToken: safeToken('corr'),
        };
        const winnerRequest = order === 'caller-a-first' ? first : second;
        const loserRequest = order === 'caller-a-first' ? second : first;
        const race = await runForcedWinnerPair({
          caseId,
          order: `${order}-${repetition}`,
          protocol,
          pool,
          recorder,
          winnerRequest,
          loserRequest,
          expectedLoserStatus: 'idempotent_replay',
        });
        lockWaits.push(race.lockWaitElapsedMs);
        let state = await readFixtureState(pool, fixture);
        assertEvidence(recorder, caseId, `${order}/${repetition}: parallel duplicate has one effect`,
          state.version === 2n && state.transactionCount === 1 && state.idempotencyCount === 1);

        const intervening = makeRequest('transaction', fixture, {
          requestSeed: `${caseId}-${order}-${repetition}-intervening`,
          expectedVersion: 2n,
          reviewedSnapshotId: fixture.initialSnapshotId,
        });
        const interveningResult = await protocol.execute(intervening, { caseId });
        assertEvidence(recorder, caseId, `${order}/${repetition}: independent mutation changed version`,
          interveningResult.status === 'committed');

        const replay = await protocol.execute({ ...first, correlationToken: safeToken('corr') }, { caseId });
        assertEvidence(recorder, caseId, `${order}/${repetition}: old compatible key replays before stale check`,
          replay.status === 'idempotent_replay');

        const conflict = await protocol.execute({
          ...first,
          correlationToken: safeToken('corr'),
          requestDigest: sha256(`different-payload-${order}-${repetition}`),
        }, { caseId });
        assertEvidence(recorder, caseId, `${order}/${repetition}: same key different digest rejected without retry`,
          conflict.status === 'idempotency_conflict'
          && conflict.code === RESULT_CODES.IDEMPOTENCY_REUSED
          && conflict.attemptCount === 1);

        state = await readFixtureState(pool, fixture);
        recordFinalState(recorder, caseId, order, repetition, state);
        assertEvidence(recorder, caseId, `${order}/${repetition}: replay/conflict do not increment version`, state.version === 3n);
        assertEvidence(recorder, caseId, `${order}/${repetition}: exactly two logical effects/results`,
          state.transactionCount === 2 && state.idempotencyCount === 2 && state.auditCount === 2);
      } finally {
        await destroyFixture(pool, fixture);
      }
    }
  }
  finishRepeatedCase(recorder, caseId, config, lockWaits);
}

function recordFinalState(recorder, caseId, order, repetition, state) {
  recorder.event('database.final_state', {
    caseId,
    order,
    repetition,
    financialStateVersion: state.version.toString(),
    snapshotCount: state.snapshotCount,
    transactionCount: state.transactionCount,
    postedCount: state.postedCount,
    voidedCount: state.voidedCount,
    replacementCount: state.replacementCount,
    idempotencyCount: state.idempotencyCount,
    auditCount: state.auditCount,
  });
}

function finishRepeatedCase(recorder, caseId, config, lockWaits) {
  const transactionDurations = recorder.events
    .filter((event) => event.type === 'transaction.attempt_finished' && event.caseId === caseId)
    .map((event) => event.elapsedMs)
    .filter((value) => typeof value === 'number');
  const lockWaitP95 = percentile(lockWaits, 0.95);
  const lockWaitP99 = percentile(lockWaits, 0.99);
  const transactionP95 = percentile(transactionDurations, 0.95);
  const transactionP99 = percentile(transactionDurations, 0.99);
  recorder.note(caseId, `Forced lock-wait p95=${lockWaitP95} ms; p99=${lockWaitP99} ms.`);
  recorder.note(caseId, `Logical transaction p95=${transactionP95} ms; p99=${transactionP99} ms.`);
  assertEvidence(recorder, caseId, 'observed p99 forced lock wait remained within per-attempt lock bound',
    lockWaitP99 !== null && lockWaitP99 < POLICY.lockTimeoutMs,
    { p95Ms: lockWaitP95, p99Ms: lockWaitP99, boundMs: POLICY.lockTimeoutMs });
  assertEvidence(recorder, caseId, 'observed p99 logical transaction remained within database budget',
    transactionP99 !== null && transactionP99 < POLICY.databaseBudgetMs,
    { p95Ms: transactionP95, p99Ms: transactionP99, boundMs: POLICY.databaseBudgetMs });
  if (config.repetitions < 100) {
    recorder.incompleteCase(
      caseId,
      `Executed ${config.repetitions} repetition(s) per order; closure evidence requires at least 100.`,
    );
  } else {
    recorder.passCase(caseId, { repetitionsPerOrder: config.repetitions, forbiddenOutcomes: 0 });
  }
}
