import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { FinancialError, validationError } from '@kfin/domain';
import {
  AccountFinancialSerializer,
  StableIdempotentFinancialError,
  type SerializedOperation,
} from '../src/serialization.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000003';

type Value = { referenceId: string };

function operation(overrides: Partial<SerializedOperation<Value>> = {}): SerializedOperation<Value> {
  return {
    ownerUserId: OWNER_ID,
    accountId: ACCOUNT_ID,
    operation: 'financial.test.create',
    idempotencyKey: 'raw-secret-idempotency-key',
    requestDigest: 'a'.repeat(64),
    expectedFinancialStateVersion: 1n,
    reviewedLatestSnapshotId: SNAPSHOT_ID,
    staleCode: 'FINANCIAL_STATE_STALE',
    successStatus: 201,
    correlationId: 'correlation-test',
    idempotencyRetentionMs: 86_400_000,
    work: async () => ({
      value: { referenceId: '00000000-0000-4000-8000-000000000004' },
      audit: {
        action: 'financial.test.create',
        resourceType: 'test',
        resourceId: '00000000-0000-4000-8000-000000000004',
      },
    }),
    ...overrides,
  };
}

type FakeClient = PoolClient & { readonly queryMock: ReturnType<typeof vi.fn> };

interface FakeOptions {
  readonly accountFailureCode?: string;
  readonly onAccountFailure?: () => void;
  readonly rollbackFails?: boolean;
  readonly commitUnknown?: boolean;
  readonly hangingAccountQuery?: boolean;
  readonly stored?: {
    readonly requestDigest: string;
    readonly status: number;
    readonly resultCode: string;
    readonly result: Record<string, unknown>;
    readonly committedVersion: string | null;
  };
}

function fakeClient(name: string, events: string[], options: FakeOptions = {}): FakeClient {
  let accountFailed = false;
  const query = vi.fn(async (text: string, values: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    events.push(`${name}:query:${normalized}`);
    if (/^ROLLBACK$/i.test(normalized) && options.rollbackFails) throw new Error('rollback acknowledgement lost');
    if (/^COMMIT$/i.test(normalized) && options.commitUnknown) throw new Error('socket closed');
    if (normalized.includes('FROM financial_accounts') && normalized.includes('FOR UPDATE')) {
      if (options.hangingAccountQuery) return new Promise(() => undefined);
      if (options.accountFailureCode && !accountFailed) {
        accountFailed = true;
        options.onAccountFailure?.();
        throw Object.assign(new Error('synthetic PostgreSQL error'), { code: options.accountFailureCode });
      }
      return result([{
        id: ACCOUNT_ID,
        user_id: OWNER_ID,
        currency: 'VND',
        financial_state_version: '1',
        timezone: 'Asia/Ho_Chi_Minh',
        user_version: '1',
      }]);
    }
    if (normalized.includes('FROM users') && normalized.includes('FOR SHARE')) {
      return result([{ timezone: 'Asia/Ho_Chi_Minh', version: '1' }]);
    }
    if (normalized.includes('FROM idempotency_results')) {
      if (!options.stored) return result([]);
      return result([{
        request_digest: options.stored.requestDigest,
        response_status: options.stored.status,
        result_code: options.stored.resultCode,
        result: options.stored.result,
        committed_financial_state_version: options.stored.committedVersion,
      }]);
    }
    if (normalized.includes('FROM balance_snapshots')) {
      return result([{
        id: SNAPSHOT_ID,
        amount_minor: '1000',
        effective_at: new Date('2026-10-08T00:00:00.000Z'),
        effective_local_date: '2026-10-08',
        timezone: 'Asia/Ho_Chi_Minh',
      }]);
    }
    if (normalized.startsWith('UPDATE financial_accounts')) return result([], 1);
    return result([], 0);
  });
  const release = vi.fn((destroy?: boolean | Error) => {
    events.push(`${name}:release:${destroy === true || destroy instanceof Error ? 'destroy' : 'clean'}`);
  });
  return { query, release, queryMock: query } as unknown as FakeClient;
}

function fakePool(clients: PoolClient[]) {
  let index = 0;
  const connect = vi.fn(async () => {
    const client = clients[index++];
    if (!client) throw new Error('No fake client available.');
    return client;
  });
  return { connect, connectedCount: () => index };
}

function result<Row extends QueryResultRow>(rows: Row[], rowCount = rows.length): QueryResult<Row> {
  return { command: '', rowCount, oid: 0, fields: [], rows };
}

describe('account financial serialization', () => {
  it('locks account first, checks idempotency before snapshot, and commits one version', async () => {
    const events: string[] = [];
    const client = fakeClient('one', events);
    const pool = fakePool([client]);
    const serializer = new AccountFinancialSerializer(
      pool as unknown as Pick<Pool, 'connect'>,
      () => 0,
      () => 25,
    );

    const response = await serializer.execute(operation());
    expect(response).toMatchObject({ financialStateVersion: 2n, replayed: false, attempts: 1 });

    const accountLock = events.findIndex((event) => event.includes('FROM financial_accounts'));
    const idempotencyRead = events.findIndex((event) => event.includes('FROM idempotency_results'));
    const snapshotLock = events.findIndex((event) => event.includes('FROM balance_snapshots'));
    const versionUpdate = events.findIndex((event) => event.includes('UPDATE financial_accounts'));
    expect(accountLock).toBeGreaterThan(-1);
    expect(accountLock).toBeLessThan(idempotencyRead);
    expect(idempotencyRead).toBeLessThan(snapshotLock);
    expect(snapshotLock).toBeLessThan(versionUpdate);
    expect(events.at(-1)).toBe('one:release:clean');

    const allParameters = client.queryMock.mock.calls.flatMap((call: unknown[]) => (
      Array.isArray(call[1]) ? call[1] : []
    ));
    expect(allParameters).not.toContain('raw-secret-idempotency-key');
  });

  it.each(['55P03', '40P01', '40001'])('retries %s once only after same-handle rollback', async (sqlstate) => {
    const events: string[] = [];
    const first = fakeClient('first', events, { accountFailureCode: sqlstate });
    const second = fakeClient('second', events);
    const pool = fakePool([first, second]);
    const serializer = new AccountFinancialSerializer(
      pool as unknown as Pick<Pool, 'connect'>,
      () => 0,
      () => 25,
    );

    const response = await serializer.execute(operation());
    expect(response.attempts).toBe(2);
    const rollback = events.indexOf('first:query:ROLLBACK');
    const release = events.indexOf('first:release:clean');
    const nextBegin = events.indexOf('second:query:BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(rollback).toBeGreaterThan(-1);
    expect(rollback).toBeLessThan(release);
    expect(release).toBeLessThan(nextBegin);
  });

  it('returns busy after a second transient and never starts a third attempt', async () => {
    const events: string[] = [];
    const first = fakeClient('first', events, { accountFailureCode: '40001' });
    const second = fakeClient('second', events, { accountFailureCode: '40001' });
    const unused = fakeClient('unused', events);
    const pool = fakePool([first, second, unused]);
    const serializer = new AccountFinancialSerializer(
      pool as unknown as Pick<Pool, 'connect'>,
      () => 0,
      () => 25,
    );

    await expect(serializer.execute(operation())).rejects.toMatchObject({
      code: 'FINANCIAL_CONCURRENCY_BUSY',
    });
    expect(pool.connectedCount()).toBe(2);
    expect(events.filter((event) => event.endsWith('query:ROLLBACK'))).toHaveLength(2);
  });

  it('does not start a retry when the remaining budget cannot contain it', async () => {
    const events: string[] = [];
    let clock = 0;
    const first = fakeClient('first', events, {
      accountFailureCode: '55P03',
      onAccountFailure: () => { clock = 3_000; },
    });
    const unused = fakeClient('unused', events);
    const pool = fakePool([first, unused]);
    const serializer = new AccountFinancialSerializer(
      pool as unknown as Pick<Pool, 'connect'>,
      () => clock,
      () => 25,
    );

    await expect(serializer.execute(operation())).rejects.toMatchObject({
      code: 'FINANCIAL_CONCURRENCY_BUSY',
    });
    expect(pool.connectedCount()).toBe(1);
    expect(events).not.toContain('unused:query:BEGIN ISOLATION LEVEL READ COMMITTED');
  });

  it('rolls back a domain validation failure without retry or receipt', async () => {
    const events: string[] = [];
    const client = fakeClient('invalid', events);
    const pool = fakePool([client]);
    const serializer = new AccountFinancialSerializer(pool as unknown as Pick<Pool, 'connect'>, () => 0);

    await expect(serializer.execute(operation({
      work: async () => { throw validationError('Synthetic invalid request.'); },
    }))).rejects.toMatchObject({ code: 'FINANCIAL_VALIDATION_FAILED' });
    expect(pool.connectedCount()).toBe(1);
    expect(events).toContain('invalid:query:ROLLBACK');
    expect(events.some((event) => event.includes('INSERT INTO idempotency_results'))).toBe(false);
  });

  it('commits a work-discovered stable correction-stale receipt without version or audit mutation', async () => {
    const events: string[] = [];
    const client = fakeClient('correction-stale', events);
    const pool = fakePool([client]);
    const serializer = new AccountFinancialSerializer(pool as unknown as Pick<Pool, 'connect'>, () => 0);

    await expect(serializer.execute(operation({
      staleCode: 'FIN_CORRECTION_STALE_STATE',
      work: async () => {
        throw new StableIdempotentFinancialError(new FinancialError({
          code: 'FIN_CORRECTION_STALE_STATE',
          statusCode: 409,
          safeMessage: 'The reviewed correction state is stale.',
        }));
      },
    }))).rejects.toMatchObject({ code: 'FIN_CORRECTION_STALE_STATE' });
    expect(events.some((event) => event.includes('INSERT INTO idempotency_results'))).toBe(true);
    expect(events.some((event) => event.includes('UPDATE financial_accounts'))).toBe(false);
    expect(events.some((event) => event.includes('INSERT INTO audit_events'))).toBe(false);
    expect(events).toContain('correction-stale:query:COMMIT');
    expect(events.at(-1)).toBe('correction-stale:release:clean');
  });

  it('bounds an application-level query hang and evicts the unconfirmed handle', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const client = fakeClient('hung-query', events, { hangingAccountQuery: true });
      const pool = fakePool([client]);
      const serializer = new AccountFinancialSerializer(
        pool as unknown as Pick<Pool, 'connect'>,
        Date.now,
      );
      const assertion = expect(serializer.execute(operation())).rejects.toMatchObject({
        code: 'FINANCIAL_OPERATION_TIMEOUT',
      });
      await vi.advanceTimersByTimeAsync(8_001);
      await assertion;
      expect(events).not.toContain('hung-query:query:ROLLBACK');
      expect(events.at(-1)).toBe('hung-query:release:destroy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry statement timeout and returns only after rollback', async () => {
    const events: string[] = [];
    const client = fakeClient('timeout', events, { accountFailureCode: '57014' });
    const pool = fakePool([client]);
    const serializer = new AccountFinancialSerializer(pool as unknown as Pick<Pool, 'connect'>, () => 0);

    await expect(serializer.execute(operation())).rejects.toMatchObject({
      code: 'FINANCIAL_OPERATION_TIMEOUT',
      statusCode: 503,
    });
    expect(pool.connectedCount()).toBe(1);
    expect(events).toContain('timeout:query:ROLLBACK');
    expect(events.at(-1)).toBe('timeout:release:clean');
  });

  it('evicts an unconfirmed handle and prohibits retry', async () => {
    const events: string[] = [];
    const first = fakeClient('unsafe', events, { accountFailureCode: '55P03', rollbackFails: true });
    const unused = fakeClient('unused', events);
    const pool = fakePool([first, unused]);
    const serializer = new AccountFinancialSerializer(pool as unknown as Pick<Pool, 'connect'>, () => 0);

    await expect(serializer.execute(operation())).rejects.toMatchObject({
      code: 'FINANCIAL_CONCURRENCY_BUSY',
    });
    expect(pool.connectedCount()).toBe(1);
    expect(events.at(-1)).toBe('unsafe:release:destroy');
  });

  it('uses one same-key recovery after uncertain commit and replays the stored result', async () => {
    const events: string[] = [];
    const original = fakeClient('original', events, { commitUnknown: true });
    const recovery = fakeClient('recovery', events, {
      stored: {
        requestDigest: 'a'.repeat(64),
        status: 201,
        resultCode: 'OK',
        result: { referenceId: '00000000-0000-4000-8000-000000000004' },
        committedVersion: '2',
      },
    });
    const pool = fakePool([original, recovery]);
    const serializer = new AccountFinancialSerializer(pool as unknown as Pick<Pool, 'connect'>, () => 0);

    const response = await serializer.execute(operation());
    expect(response).toMatchObject({ replayed: true, attempts: 2, financialStateVersion: 2n });
    expect(events).toContain('original:release:destroy');
    expect(events.filter((event) => event.includes('recovery:query:BEGIN')).length).toBe(1);
  });

  it('returns unknown rather than nesting a retry when recovery cannot resolve', async () => {
    const events: string[] = [];
    const original = fakeClient('original', events, { commitUnknown: true });
    const recovery = fakeClient('recovery', events, { accountFailureCode: '55P03' });
    const unused = fakeClient('unused', events);
    const pool = fakePool([original, recovery, unused]);
    const serializer = new AccountFinancialSerializer(pool as unknown as Pick<Pool, 'connect'>, () => 0);

    await expect(serializer.execute(operation())).rejects.toMatchObject({
      code: 'FINANCIAL_RESULT_UNKNOWN',
    });
    expect(pool.connectedCount()).toBe(2);
  });

  it('commits one bounded stale receipt and performs no domain/version/audit mutation', async () => {
    const events: string[] = [];
    const client = fakeClient('stale', events);
    const pool = fakePool([client]);
    const serializer = new AccountFinancialSerializer(pool as unknown as Pick<Pool, 'connect'>, () => 0);

    await expect(serializer.execute(operation({ expectedFinancialStateVersion: 9n }))).rejects.toMatchObject({
      code: 'FINANCIAL_STATE_STALE',
    });
    expect(events.some((event) => event.includes('INSERT INTO idempotency_results'))).toBe(true);
    expect(events.some((event) => event.includes('UPDATE financial_accounts'))).toBe(false);
    expect(events.some((event) => event.includes('INSERT INTO audit_events'))).toBe(false);
    expect(events).toContain('stale:query:COMMIT');
  });

  it('reconstructs a stored linked-domain error with its original stable code', async () => {
    const events: string[] = [];
    const client = fakeClient('linked-replay', events, {
      stored: {
        requestDigest: 'a'.repeat(64),
        status: 409,
        resultCode: 'FIN_CORRECTION_LINKED_DOMAIN_REQUIRED',
        result: {},
        committedVersion: null,
      },
    });
    const pool = fakePool([client]);
    const serializer = new AccountFinancialSerializer(pool as unknown as Pick<Pool, 'connect'>, () => 0);

    await expect(serializer.execute(operation())).rejects.toMatchObject({
      code: 'FIN_CORRECTION_LINKED_DOMAIN_REQUIRED',
      statusCode: 409,
      safeMessage: 'This transaction must be changed through its owning schedule workflow.',
    });
    expect(events).toContain('linked-replay:query:COMMIT');
  });

  it('rejects key reuse with a different digest before stale comparison', async () => {
    const events: string[] = [];
    const client = fakeClient('conflict', events, {
      stored: {
        requestDigest: 'b'.repeat(64),
        status: 201,
        resultCode: 'OK',
        result: { referenceId: '00000000-0000-4000-8000-000000000004' },
        committedVersion: '2',
      },
    });
    const pool = fakePool([client]);
    const serializer = new AccountFinancialSerializer(pool as unknown as Pick<Pool, 'connect'>, () => 0);

    await expect(serializer.execute(operation())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    // The conflict is committed without reading/locking a snapshot.
    expect(events.some((event) => event.includes('FROM balance_snapshots'))).toBe(false);
  });
});
