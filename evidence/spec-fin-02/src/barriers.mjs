import { LOCK_RANK } from './constants.mjs';
import { withTimeout } from './util.mjs';

export class DeterministicBarrier {
  constructor(name) {
    this.name = name;
    this.reachedPayload = undefined;
    this.isReached = false;
    this.isReleased = false;
    this.reachedPromise = new Promise((resolve) => { this.resolveReached = resolve; });
    this.releasePromise = new Promise((resolve) => { this.resolveRelease = resolve; });
  }

  async hold(payload = {}) {
    if (this.isReached) throw new Error(`Barrier ${this.name} was reached more than once`);
    this.isReached = true;
    this.reachedPayload = payload;
    this.resolveReached(payload);
    await this.releasePromise;
  }

  async waitUntilReached(timeoutMs = 10_000) {
    return withTimeout(this.reachedPromise, timeoutMs, `barrier ${this.name}`);
  }

  release() {
    if (!this.isReached) throw new Error(`Cannot release unreached barrier ${this.name}`);
    if (!this.isReleased) {
      this.isReleased = true;
      this.resolveRelease();
    }
  }
}

export class LockOrderGuard {
  constructor({ caseId, correlationToken, recorder }) {
    this.caseId = caseId;
    this.correlationToken = correlationToken;
    this.recorder = recorder;
    this.lastRank = 0;
    this.accountSeen = false;
    this.acquisitions = [];
  }

  record(kind, resourceToken = null) {
    const rank = LOCK_RANK[kind];
    if (!rank) throw new Error(`Unknown lock rank: ${kind}`);
    if (kind !== 'account' && !this.accountSeen) {
      const error = new Error(`LOCK_ORDER_VIOLATION: ${kind} before account`);
      error.code = 'LOCK_ORDER_VIOLATION';
      throw error;
    }
    if (rank < this.lastRank) {
      const error = new Error(`LOCK_ORDER_VIOLATION: ${kind} rank ${rank} after ${this.lastRank}`);
      error.code = 'LOCK_ORDER_VIOLATION';
      throw error;
    }
    if (kind === 'account') this.accountSeen = true;
    this.lastRank = rank;
    const acquisition = { kind, rank, resourceToken };
    this.acquisitions.push(acquisition);
    this.recorder?.event('lock_order.recorded', {
      caseId: this.caseId,
      correlationToken: this.correlationToken,
      ...acquisition,
    });
  }
}

export async function waitForPostgresLockWait(observerClient, blockedPid, {
  timeoutMs = 5_000,
  pollMs = 10,
} = {}) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const result = await observerClient.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_locks
         WHERE pid = $1 AND NOT granted
       ) AS waiting,
       COALESCE(array_length(pg_catalog.pg_blocking_pids($1), 1), 0) AS blocker_count`,
      [blockedPid],
    );
    if (result.rows[0].waiting || Number(result.rows[0].blocker_count) > 0) {
      const locks = await observerClient.query(
        `SELECT l.locktype, l.mode, l.granted,
                COALESCE(c.relname, 'non-relation') AS relation_name
         FROM pg_catalog.pg_locks l
         LEFT JOIN pg_catalog.pg_class c ON c.oid = l.relation
         WHERE l.pid = $1
         ORDER BY l.granted, l.locktype, l.mode, relation_name`,
        [blockedPid],
      );
      return {
        observed: true,
        elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
        blockerCount: Number(result.rows[0].blocker_count),
        locks: locks.rows.map((row) => ({
          locktype: row.locktype,
          mode: row.mode,
          granted: row.granted,
          relation: row.relation_name,
        })),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return {
    observed: false,
    elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
    blockerCount: 0,
  };
}

export async function waitForActiveQuery(observerClient, pid, fragment, {
  timeoutMs = 5_000,
  pollMs = 10,
} = {}) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const result = await observerClient.query(
      `SELECT state, wait_event_type, wait_event
       FROM pg_catalog.pg_stat_activity
       WHERE pid = $1 AND query LIKE '%' || $2 || '%'`,
      [pid, fragment],
    );
    if (result.rowCount === 1 && result.rows[0].state === 'active') {
      return {
        observed: true,
        elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
        waitEventType: result.rows[0].wait_event_type,
        waitEvent: result.rows[0].wait_event,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { observed: false, elapsedMs: Number((performance.now() - startedAt).toFixed(3)) };
}
