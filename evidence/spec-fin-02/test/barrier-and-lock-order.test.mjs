import assert from 'node:assert/strict';
import test from 'node:test';
import { DeterministicBarrier, LockOrderGuard } from '../src/barriers.mjs';

test('deterministic barrier does not continue until explicit release', async () => {
  const barrier = new DeterministicBarrier('unit-barrier');
  let continued = false;
  const worker = barrier.hold({ stage: 'account-locked' }).then(() => { continued = true; });
  const payload = await barrier.waitUntilReached();
  assert.deepEqual(payload, { stage: 'account-locked' });
  assert.equal(continued, false);
  barrier.release();
  await worker;
  assert.equal(continued, true);
});

test('lock order guard accepts account-first global rank order', () => {
  const guard = new LockOrderGuard({ caseId: 'FIN-RACE-08', correlationToken: 'synthetic' });
  guard.record('account');
  guard.record('snapshot');
  guard.record('transaction');
  guard.record('occurrence');
  guard.record('result');
  assert.deepEqual(guard.acquisitions.map(({ rank }) => rank), [1, 2, 3, 4, 8]);
});

test('lock order guard rejects child-before-account and descending rank', () => {
  const childFirst = new LockOrderGuard({ caseId: 'FIN-RACE-08', correlationToken: 'synthetic' });
  assert.throws(() => childFirst.record('transaction'), (error) => error.code === 'LOCK_ORDER_VIOLATION');

  const descending = new LockOrderGuard({ caseId: 'FIN-RACE-08', correlationToken: 'synthetic' });
  descending.record('account');
  descending.record('transaction');
  assert.throws(() => descending.record('snapshot'), (error) => error.code === 'LOCK_ORDER_VIOLATION');
});
