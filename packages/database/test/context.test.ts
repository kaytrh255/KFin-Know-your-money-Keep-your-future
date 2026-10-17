import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  APPLICATION_DATABASE_ROLE,
  DatabaseRoleError,
  USER_CONTEXT_SETTING,
  assertApplicationDatabaseRole,
  assertUserId,
  withUserContext,
} from '../src/context.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';

function result<Row extends QueryResultRow>(rows: Row[] = [], rowCount = rows.length): QueryResult<Row> {
  return { command: '', rowCount, oid: 0, fields: [], rows };
}

function fakeClient() {
  const events: string[] = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    events.push(`${text.replace(/\s+/g, ' ').trim()} ${JSON.stringify(values)}`.trim());
    return result();
  });
  const release = vi.fn();
  return { client: { query, release } as unknown as PoolClient, query, release, events };
}

describe('owner context', () => {
  it('accepts canonical UUIDs only', () => {
    expect(assertUserId(USER_ID)).toBe(USER_ID);
    expect(() => assertUserId('not-a-uuid')).toThrow(DatabaseRoleError);
    expect(() => assertUserId("' OR 1=1 --")).toThrow(DatabaseRoleError);
  });

  it('sets the context inside the transaction and commits before release', async () => {
    const { client, events, release } = fakeClient();
    const pool = { connect: vi.fn(async () => client) } as unknown as Pick<Pool, 'connect'>;
    const value = await withUserContext(pool, USER_ID, async () => 'done');
    expect(value).toBe('done');
    expect(events[0]).toBe('BEGIN []');
    expect(events[1]).toContain(`SELECT set_config($1, $2, true) ["${USER_CONTEXT_SETTING}","${USER_ID}"]`);
    expect(events.at(-1)).toBe('COMMIT []');
    expect(release).toHaveBeenCalledWith();
  });

  it('sets no context for a pre-identity transaction', async () => {
    const { client, events } = fakeClient();
    const pool = { connect: vi.fn(async () => client) } as unknown as Pick<Pool, 'connect'>;
    await withUserContext(pool, null, async () => undefined);
    expect(events.some((event) => event.includes('set_config'))).toBe(false);
  });

  it('rolls back and rethrows so a failed unit of work never commits context', async () => {
    const { client, events, release } = fakeClient();
    const pool = { connect: vi.fn(async () => client) } as unknown as Pick<Pool, 'connect'>;
    await expect(withUserContext(pool, USER_ID, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(events).toContain('ROLLBACK []');
    expect(events).not.toContain('COMMIT []');
    expect(release).toHaveBeenCalledWith();
  });
});

describe('application role guard', () => {
  function rolePool(row: Record<string, unknown>) {
    return { query: vi.fn(async () => result([row])) } as unknown as Pick<Pool, 'query'>;
  }

  const clean = {
    role: APPLICATION_DATABASE_ROLE,
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    owned_relations: '0',
    owned_schemas: '0',
  };

  it('accepts the dedicated application role', async () => {
    await expect(assertApplicationDatabaseRole(rolePool(clean))).resolves.toBeUndefined();
  });

  it.each([
    ['another role', { ...clean, role: 'postgres' }, /connected as postgres/],
    ['superuser', { ...clean, rolsuper: true }, /SUPERUSER/],
    ['bypassrls', { ...clean, rolbypassrls: true }, /BYPASSRLS/],
    ['createdb', { ...clean, rolcreatedb: true }, /CREATEDB/],
    ['createrole', { ...clean, rolcreaterole: true }, /CREATEROLE/],
    ['relation owner', { ...clean, owned_relations: '3' }, /owns 3 relation/],
    ['schema owner', { ...clean, owned_schemas: '1' }, /owns 1 schema/],
  ])('refuses to start as %s', async (_label, row, message) => {
    await expect(assertApplicationDatabaseRole(rolePool(row))).rejects.toThrow(message);
  });

  it('fails closed when the role cannot be resolved', async () => {
    const pool = { query: vi.fn(async () => result([])) } as unknown as Pick<Pool, 'query'>;
    await expect(assertApplicationDatabaseRole(pool)).rejects.toThrow(/could not be resolved/);
  });
});
