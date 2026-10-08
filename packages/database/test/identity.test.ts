import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { digestCanonicalRequest } from '../src/canonical.js';
import {
  FinancialAccountBootstrapService,
  PostgresUserRepository,
} from '../src/identity.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';

type FakeClient = PoolClient & { readonly queryMock: ReturnType<typeof vi.fn> };

interface ClientOptions {
  readonly commitUnknown?: boolean;
  readonly stored?: {
    readonly accountId: string;
    readonly snapshotId: string;
    readonly requestDigest: string;
  };
}

function client(name: string, events: string[], options: ClientOptions = {}): FakeClient {
  const query = vi.fn(async (text: string, values: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    events.push(`${name}:query:${normalized}`);
    if (normalized === 'COMMIT' && options.commitUnknown) throw new Error('socket closed');
    if (normalized.includes('FROM users') && normalized.includes('FOR UPDATE')) {
      return result([{ id: USER_ID, timezone: 'Asia/Ho_Chi_Minh', base_currency: 'VND' }]);
    }
    if (normalized.includes('FROM idempotency_results')) {
      if (!options.stored) return result([]);
      return result([{
        request_digest: options.stored.requestDigest,
        result: {
          accountId: options.stored.accountId,
          snapshotId: options.stored.snapshotId,
          financialStateVersion: '1',
        },
      }]);
    }
    if (normalized.includes('SELECT id FROM financial_accounts')) return result([]);
    return result([], normalized.startsWith('INSERT') ? 1 : 0);
  });
  const release = vi.fn((destroy?: boolean | Error) => {
    events.push(`${name}:release:${destroy === true || destroy instanceof Error ? 'destroy' : 'clean'}`);
  });
  return { query, release, queryMock: query } as unknown as FakeClient;
}

function pool(clients: PoolClient[]) {
  let index = 0;
  return {
    connect: vi.fn(async () => {
      const next = clients[index++];
      if (!next) throw new Error('No client');
      return next;
    }),
    connectedCount: () => index,
  };
}

function result<Row extends QueryResultRow>(rows: Row[], rowCount = rows.length): QueryResult<Row> {
  return { command: '', rowCount, oid: 0, fields: [], rows };
}

describe('user persistence validation', () => {
  it('rejects invalid owner context before querying PostgreSQL', async () => {
    const query = vi.fn();
    const repository = new PostgresUserRepository({ query } as unknown as Pick<Pool, 'query'>);
    await expect(repository.create({
      email: 'owner@example.invalid',
      locale: 'en-VN',
      timezone: 'not/a-timezone',
      baseCurrency: 'VND',
    })).rejects.toMatchObject({ code: 'FINANCIAL_VALIDATION_FAILED' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('financial account bootstrap', () => {
  it('locks the active verified user, creates account/snapshot atomically, and stores only a key digest', async () => {
    const events: string[] = [];
    const connection = client('bootstrap', events);
    const fakePool = pool([connection]);
    const service = new FinancialAccountBootstrapService(
      fakePool as unknown as Pick<Pool, 'connect'>,
      () => Date.parse('2026-10-08T12:00:00.000Z'),
    );
    const response = await service.bootstrap({
      ownerUserId: USER_ID,
      openingAmountMinor: '-100',
      effectiveAt: new Date('2026-10-08T11:00:00.000Z'),
      idempotencyKey: 'raw-bootstrap-key',
      correlationId: 'correlation',
      idempotencyRetentionMs: 86_400_000,
    });

    expect(response).toMatchObject({ financialStateVersion: '1', replayed: false });
    const userLock = events.findIndex((event) => event.includes('FROM users'));
    const idempotencyRead = events.findIndex((event) => event.includes('FROM idempotency_results'));
    const accountInsert = events.findIndex((event) => event.includes('INSERT INTO financial_accounts'));
    expect(userLock).toBeLessThan(idempotencyRead);
    expect(idempotencyRead).toBeLessThan(accountInsert);
    const parameters = connection.queryMock.mock.calls.flatMap((call: unknown[]) => (
      Array.isArray(call[1]) ? call[1] : []
    ));
    expect(parameters).not.toContain('raw-bootstrap-key');
    expect(events.at(-1)).toBe('bootstrap:release:clean');
  });

  it('performs one same-key recovery after an uncertain bootstrap commit', async () => {
    const events: string[] = [];
    const effectiveAt = new Date('2026-10-08T11:00:00.000Z');
    const original = client('original', events, { commitUnknown: true });
    const recovery = client('recovery', events, {
      stored: {
        accountId: '00000000-0000-4000-8000-000000000002',
        snapshotId: '00000000-0000-4000-8000-000000000003',
        requestDigest: digestCanonicalRequest({
          openingAmountMinor: 100n,
          effectiveAt: effectiveAt.toISOString(),
        }),
      },
    });
    const fakePool = pool([original, recovery]);
    const service = new FinancialAccountBootstrapService(
      fakePool as unknown as Pick<Pool, 'connect'>,
      () => Date.parse('2026-10-08T12:00:00.000Z'),
    );

    const response = await service.bootstrap({
      ownerUserId: USER_ID,
      openingAmountMinor: '100',
      effectiveAt,
      idempotencyKey: 'bootstrap-recovery-key',
      correlationId: 'correlation',
      idempotencyRetentionMs: 86_400_000,
    });
    expect(response).toMatchObject({
      accountId: '00000000-0000-4000-8000-000000000002',
      replayed: true,
    });
    expect(events).toContain('original:release:destroy');
    expect(events).toContain('recovery:release:clean');
    expect(fakePool.connectedCount()).toBe(2);
  });
});
