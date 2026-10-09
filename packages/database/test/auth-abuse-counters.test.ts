import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresAuthRepository, type AuthAccessPolicy } from '../src/index.js';

/**
 * Abuse-counter connection discipline.
 *
 * Regression for a review finding: the counter used to be written on a second
 * connection acquired *while* an operation transaction was already holding one,
 * so a saturated pool would end up with every connection waiting for a
 * connection and none left to commit (SEC-ABUSE-08/09). These tests use a fake
 * pool that refuses a nested checkout, which is the shape of the deadlock.
 */

const SECRET = 'ef'.repeat(32);

const POLICY: AuthAccessPolicy = {
  password: {
    minimumLength: 12,
    maximumLength: 128,
    hashPolicyVersion: 1,
    argon2: { memoryCost: 19_456, timeCost: 2, parallelism: 1 },
  },
  invitation: {
    codeEntropyBytes: 20,
    codeGroupLength: 8,
    defaultLifetimeMs: 14 * 24 * 60 * 60 * 1_000,
  },
  challenge: {
    otpDigits: 6,
    otpLifetimeMs: 10 * 60 * 1_000,
    maximumAttempts: 5,
    resendCooldownMs: 60 * 1_000,
    resetSecretEntropyBytes: 32,
    resetLifetimeMs: 30 * 60 * 1_000,
    hourlyIssuanceCap: 5,
    dailyIssuanceCap: 12,
  },
  session: {
    tokenEntropyBytes: 32,
    csrfEntropyBytes: 32,
    idleLifetimeMs: 30 * 24 * 60 * 60 * 1_000,
    absoluteLifetimeMs: 90 * 24 * 60 * 60 * 1_000,
    rotationGraceMs: 30 * 1_000,
    lastSeenThrottleMs: 60 * 1_000,
  },
  abuse: {
    windowMs: 15 * 60 * 1_000,
    loginMaximumFailures: 10,
    verificationMaximumAttempts: 20,
    resetMaximumRequests: 10,
    registrationMaximumPerWindow: 20,
    retentionWindows: 8,
  },
};

function labelOf(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (flat.startsWith('insert into auth_attempt_counters')) return 'counter-write';
  if (flat.startsWith('insert into security_events')) return 'event-write';
  if (flat.startsWith('begin')) return 'begin';
  if (flat.startsWith('commit')) return 'commit';
  if (flat.startsWith('rollback')) return 'rollback';
  if (flat.startsWith('select')) return 'select';
  return `other:${flat.slice(0, 24)}`;
}

/**
 * A pool that throws on the exact pattern that deadlocks: asking for a
 * connection while another one is still checked out by the same caller.
 */
class SingleCheckoutPool {
  readonly log: string[] = [];
  maximumConcurrentCheckouts = 0;
  nestedCheckoutAttempts = 0;
  /** Value returned by the counter upsert; above the policy limit it blocks. */
  counterCount = 1;

  private checkedOut = 0;
  private nextId = 1;

  connect(): Promise<PoolClient> {
    if (this.checkedOut > 0) {
      this.nestedCheckoutAttempts += 1;
      this.log.push('nested-checkout-refused');
      return Promise.reject(new Error('nested pool checkout: an operation connection is still held'));
    }
    this.checkedOut += 1;
    this.maximumConcurrentCheckouts = Math.max(this.maximumConcurrentCheckouts, this.checkedOut);
    const id = this.nextId;
    this.nextId += 1;
    this.log.push(`connect:${id}`);
    const pool = this;
    const client = {
      query: async (sql: string): Promise<QueryResult<QueryResultRow>> => {
        const label = labelOf(sql);
        pool.log.push(`query:${label}`);
        const rows = label === 'counter-write' ? [{ count: pool.counterCount }] : [];
        return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
      },
      release: (): void => {
        pool.checkedOut -= 1;
        pool.log.push(`release:${id}`);
      },
    };
    return Promise.resolve(client as unknown as PoolClient);
  }

  async query(): Promise<QueryResult<QueryResultRow>> {
    throw new Error('the abuse-counter path must use a dedicated connection, not pool.query');
  }
}

function repositoryWith(pool: SingleCheckoutPool): PostgresAuthRepository {
  return new PostgresAuthRepository(pool as unknown as Pick<Pool, 'query' | 'connect'>, {
    secret: SECRET,
    policy: POLICY,
    now: () => Date.UTC(2026, 9, 8, 2, 0, 0),
  });
}

const context = {
  correlationId: randomUUID(),
  ipAddress: '198.51.100.9',
  userAgent: 'Mozilla/5.0 (Macintosh)',
};

describe('auth abuse counters never nest a pool checkout', () => {
  it('records both counters before the operation transaction is opened', async () => {
    const pool = new SingleCheckoutPool();
    const repository = repositoryWith(pool);

    // Unknown account: two counters, one lookup, one failure event, commit.
    await expect(repository.login({
      email: 'nobody@example.invalid',
      password: 'a-passphrase-value-12',
      ...context,
    })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });

    expect(pool.nestedCheckoutAttempts).toBe(0);
    expect(pool.maximumConcurrentCheckouts).toBe(1);

    const firstBegin = pool.log.indexOf('query:begin');
    const counterWrites = pool.log
      .map((entry, index) => ({ entry, index }))
      .filter((item) => item.entry === 'query:counter-write')
      .map((item) => item.index);
    expect(counterWrites).toHaveLength(2);
    expect(Math.max(...counterWrites)).toBeLessThan(firstBegin);
    // The counter connection is released before the transaction connection is taken.
    expect(pool.log[counterWrites[0]! - 1]).toBe('connect:1');
    expect(pool.log.indexOf('release:1')).toBeLessThan(pool.log.indexOf('connect:2'));
  });

  it('keeps the reset and registration counters off the transaction connection too', async () => {
    const pool = new SingleCheckoutPool();
    const repository = repositoryWith(pool);

    const reset = await repository.requestPasswordReset({
      email: 'nobody@example.invalid',
      ...context,
    });
    expect(reset).toMatchObject({ accepted: true, issued: false });

    expect(pool.nestedCheckoutAttempts).toBe(0);
    expect(pool.maximumConcurrentCheckouts).toBe(1);
    expect(pool.log.indexOf('query:counter-write')).toBeLessThan(pool.log.indexOf('query:begin'));
  });

  it('blocks an exhausted window without ever opening the operation transaction', async () => {
    const pool = new SingleCheckoutPool();
    pool.counterCount = POLICY.abuse.loginMaximumFailures + 1;
    const repository = repositoryWith(pool);

    await expect(repository.login({
      email: 'nobody@example.invalid',
      password: 'a-passphrase-value-12',
      ...context,
    })).rejects.toMatchObject({ code: 'AUTH_RATE_LIMITED' });

    expect(pool.nestedCheckoutAttempts).toBe(0);
    expect(pool.log).toContain('query:counter-write');
    expect(pool.log).not.toContain('query:begin');
    expect(pool.log.filter((entry) => entry.startsWith('connect:'))).toHaveLength(1);
    expect(pool.log.at(-1)).toBe('release:1');
  });
});
