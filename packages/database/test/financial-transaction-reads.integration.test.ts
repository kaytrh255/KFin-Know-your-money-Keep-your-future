import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FinancialAccountBootstrapService,
  migrateDatabase,
  PostgresFinancialRepository,
  PostgresUserRepository,
} from '../src/index.js';

/**
 * Milestone 08 — transaction read path on real PostgreSQL.
 *
 * `listTransactions` was previously exercised only incidentally (one drilldown
 * assertion inside the correction suite). This suite proves the three read
 * properties that only a real database can prove: opaque keyset cursor
 * pagination is complete and non-repeating under the authoritative
 * `occurred_on DESC, id DESC` ordering, every filter narrows against persisted
 * rows, and owner isolation holds for the page, the cursor, and the object
 * lookup — including a cursor minted for another owner.
 */

const PREVIEW_SIGNING_KEY = 'ab'.repeat(32);
const RETENTION_MS = 86_400_000;
const NOW = new Date('2026-10-15T05:00:00.000Z');
const SNAPSHOT_EFFECTIVE_AT = new Date('2026-10-01T05:00:00.000Z');

const integrationEnabled = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.KFIN_INTEGRATION_TARGET === 'non-production',
);
const integration = describe.skipIf(!integrationEnabled);

interface Fixture {
  readonly ownerId: string;
  readonly repository: PostgresFinancialRepository;
  readonly snapshotId: string;
  version: string;
}

integration('transaction reads on real PostgreSQL', () => {
  let administration: Pool;
  let database: Pool;
  let schema: string;

  beforeAll(async () => {
    schema = `kfin_txn_read_it_${randomUUID().replaceAll('-', '')}`;
    administration = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await administration.query(`CREATE SCHEMA ${schema}`);
    database = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 8,
      options: `-c search_path=${schema},public`,
    });
    await migrateDatabase(database);
  }, 60_000);

  afterAll(async () => {
    if (database) await database.end();
    if (administration && schema) {
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administration.end();
    }
  }, 30_000);

  async function fixture(): Promise<Fixture> {
    const user = await new PostgresUserRepository(database, () => NOW.getTime()).create({
      email: `txn-read-${randomUUID()}@example.invalid`,
      locale: 'en-VN',
      timezone: 'Asia/Ho_Chi_Minh',
      baseCurrency: 'VND',
      emailVerifiedAt: new Date(NOW.getTime() - 1_000),
    });
    const foundation = await new FinancialAccountBootstrapService(
      database,
      () => NOW.getTime(),
    ).bootstrap({
      ownerUserId: user.id,
      openingAmountMinor: '1000000',
      effectiveAt: SNAPSHOT_EFFECTIVE_AT,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      idempotencyRetentionMs: RETENTION_MS,
    });
    return {
      ownerId: user.id,
      repository: new PostgresFinancialRepository(database, RETENTION_MS, PREVIEW_SIGNING_KEY, () => NOW),
      snapshotId: foundation.snapshotId,
      version: foundation.financialStateVersion,
    };
  }

  /** Posts a transaction and advances the fixture's optimistic version. */
  async function post(
    target: Fixture,
    input: {
      occurredOn: string;
      amountMinor: string;
      kind?: 'income' | 'expense';
      categoryCode?: string;
      expenseClass?: 'essential_fixed' | 'essential_variable' | 'daily';
      alreadyIncludedInSnapshot?: boolean;
    },
  ): Promise<string> {
    const kind = input.kind ?? 'expense';
    const result = await target.repository.createTransaction(target.ownerId, {
      kind,
      amountMinor: input.amountMinor,
      occurredOn: input.occurredOn,
      categoryCode: input.categoryCode ?? (kind === 'income' ? 'income_other' : 'food'),
      isUnexpected: false,
      expectedFinancialStateVersion: target.version,
      reviewedLatestSnapshotId: target.snapshotId,
      ...(kind === 'income' || input.expenseClass === undefined
        ? {}
        : { expenseClass: input.expenseClass }),
      ...(input.alreadyIncludedInSnapshot === undefined
        ? {}
        : { alreadyIncludedInSnapshot: input.alreadyIncludedInSnapshot }),
    }, randomUUID(), randomUUID());
    target.version = result.financialStateVersion;
    return result.transactionId;
  }

  /**
   * A declarative dataset so every expectation is derived from the same source
   * of truth as the rows actually persisted. Six rows share the local date
   * 2026-10-08: that is what makes the `id DESC` keyset tie-break observable,
   * because a page break inside a same-day group must resume by identifier
   * rather than repeat or skip rows.
   */
  const OWNER_DATASET = [
    { occurredOn: '2026-09-10', amountMinor: '100000', kind: 'expense' as const, categoryCode: 'food', expenseClass: 'daily' as const, alreadyIncludedInSnapshot: true, balanceEffect: 'historical' as const, month: '2026-09' },
    { occurredOn: '2026-09-20', amountMinor: '200000', kind: 'expense' as const, categoryCode: 'rent', expenseClass: 'essential_fixed' as const, alreadyIncludedInSnapshot: true, balanceEffect: 'historical' as const, month: '2026-09' },
    { occurredOn: '2026-10-05', amountMinor: '30000', kind: 'expense' as const, categoryCode: 'food', expenseClass: 'daily' as const, balanceEffect: 'current' as const, month: '2026-10' },
    { occurredOn: '2026-10-06', amountMinor: '40000', kind: 'expense' as const, categoryCode: 'transportation', expenseClass: 'daily' as const, balanceEffect: 'current' as const, month: '2026-10' },
    { occurredOn: '2026-10-07', amountMinor: '50000', kind: 'expense' as const, categoryCode: 'rent', expenseClass: 'essential_fixed' as const, balanceEffect: 'current' as const, month: '2026-10' },
    { occurredOn: '2026-10-08', amountMinor: '60000', kind: 'income' as const, categoryCode: 'income_other', balanceEffect: 'current' as const, month: '2026-10' },
    { occurredOn: '2026-10-08', amountMinor: '70000', kind: 'expense' as const, categoryCode: 'food', expenseClass: 'daily' as const, balanceEffect: 'current' as const, month: '2026-10' },
    { occurredOn: '2026-10-08', amountMinor: '71000', kind: 'expense' as const, categoryCode: 'food', expenseClass: 'daily' as const, balanceEffect: 'current' as const, month: '2026-10' },
    { occurredOn: '2026-10-08', amountMinor: '72000', kind: 'expense' as const, categoryCode: 'transportation', expenseClass: 'daily' as const, balanceEffect: 'current' as const, month: '2026-10' },
    { occurredOn: '2026-10-08', amountMinor: '73000', kind: 'expense' as const, categoryCode: 'rent', expenseClass: 'essential_fixed' as const, balanceEffect: 'current' as const, month: '2026-10' },
    { occurredOn: '2026-10-08', amountMinor: '74000', kind: 'expense' as const, categoryCode: 'food', expenseClass: 'daily' as const, balanceEffect: 'current' as const, month: '2026-10' },
  ];

  /** Two owners with persisted, overlapping-but-distinct transaction sets. */
  async function seededFixture() {
    const owner = await fixture();
    const other = await fixture();

    const persisted: { id: string; occurredOn: string; kind: string; categoryCode: string; balanceEffect: string; month: string }[] = [];
    for (const row of OWNER_DATASET) {
      const id = await post(owner, {
        occurredOn: row.occurredOn,
        amountMinor: row.amountMinor,
        kind: row.kind,
        categoryCode: row.categoryCode,
        ...(row.kind === 'income' || row.expenseClass === undefined ? {} : { expenseClass: row.expenseClass }),
        ...(row.alreadyIncludedInSnapshot === undefined ? {} : { alreadyIncludedInSnapshot: row.alreadyIncludedInSnapshot }),
      });
      persisted.push({ id, occurredOn: row.occurredOn, kind: row.kind, categoryCode: row.categoryCode, balanceEffect: row.balanceEffect, month: row.month });
    }

    const otherTransaction = await post(other, {
      occurredOn: '2026-10-05', amountMinor: '999000', categoryCode: 'food', expenseClass: 'daily',
    });

    /** Expected identifiers for any subset of the dataset, order-insensitively. */
    const expected = (predicate: (row: typeof persisted[number]) => boolean) => (
      persisted.filter(predicate).map((row) => row.id).sort()
    );

    return { owner, other, persisted, expected, otherTransaction, allOwnerIds: persisted.map((row) => row.id) };
  }

  it('paginates with an opaque keyset cursor: complete, ordered, and never repeating', async () => {
    const { owner, persisted, allOwnerIds } = await seededFixture();

    const full = await owner.repository.listTransactions(owner.ownerId, { limit: 100 });
    expect(full.items).toHaveLength(persisted.length);
    expect(full.nextCursor).toBeNull();
    expect(new Set(full.items.map((item) => item.id))).toEqual(new Set(allOwnerIds));

    const authoritativeOrder = full.items.map((item) => item.id);

    // Walk the same set in pages of two, with page breaks landing inside the
    // six-row same-day group. The concatenation must be identical to the
    // unpaginated ordering: no skips, no repeats, no re-shuffled tie-break.
    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await owner.repository.listTransactions(owner.ownerId, {
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      pages += 1;
      expect(page.items.length).toBeLessThanOrEqual(2);
      walked.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      // A cursor is owed if and only if rows remain. Page fullness alone cannot
      // decide that: a final page may hold exactly `limit` items and must still
      // report `nextCursor: null`. So the assertion keys on the number of rows
      // left to walk rather than on `page.items.length === 2`, which was only
      // incidentally correct for an odd-sized dataset.
      const remaining = persisted.length - walked.length;
      if (remaining > 0) {
        // Rows remain, so this page must be full and must hand back a cursor.
        expect(page.items).toHaveLength(2);
        expect(cursor).not.toBeNull();
      } else {
        // Final page — including the exactly-full one.
        expect(cursor).toBeNull();
      }
    } while (cursor !== null && pages < 40);

    expect(pages).toBe(Math.ceil(persisted.length / 2));
    expect(walked).toEqual(authoritativeOrder);
    expect(new Set(walked).size).toBe(walked.length);

    // Ordering contract: occurred_on DESC, then id DESC as the stable tie-break.
    for (let index = 1; index < full.items.length; index += 1) {
      const previous = full.items[index - 1]!;
      const current = full.items[index]!;
      expect(previous.occurredOn >= current.occurredOn).toBe(true);
      if (previous.occurredOn === current.occurredOn) {
        expect(previous.id > current.id).toBe(true);
      }
    }
    const sameDay = full.items.filter((item) => item.occurredOn === '2026-10-08');
    expect(sameDay).toHaveLength(6);
    expect(sameDay.map((item) => item.id)).toEqual(
      [...sameDay.map((item) => item.id)].sort().reverse(),
    );
  }, 60_000);

  it('reports a next cursor only when another page exists', async () => {
    const { owner, allOwnerIds } = await seededFixture();

    const exact = await owner.repository.listTransactions(owner.ownerId, { limit: allOwnerIds.length });
    expect(exact.items).toHaveLength(allOwnerIds.length);
    expect(exact.nextCursor).toBeNull();

    const short = await owner.repository.listTransactions(owner.ownerId, { limit: allOwnerIds.length - 1 });
    expect(short.items).toHaveLength(allOwnerIds.length - 1);
    expect(short.nextCursor).not.toBeNull();

    const remainder = await owner.repository.listTransactions(owner.ownerId, {
      limit: allOwnerIds.length - 1,
      cursor: short.nextCursor!,
    });
    expect(remainder.items).toHaveLength(1);
    expect(remainder.nextCursor).toBeNull();
    // The oldest persisted row is the only one left after a DESC page.
    expect(remainder.items[0]!.occurredOn).toBe('2026-09-10');
  }, 60_000);

  it('narrows persisted rows by month, category, kind, and balance effect', async () => {
    const { owner, expected, persisted } = await seededFixture();
    const listed = async (options: Parameters<PostgresFinancialRepository['listTransactions']>[1]) => {
      const page = await owner.repository.listTransactions(owner.ownerId, options);
      return page.items.map((item) => item.id).sort();
    };

    expect(persisted).toHaveLength(11);
    expect(await listed({ limit: 100, month: '2026-10' })).toEqual(expected((row) => row.month === '2026-10'));
    expect(await listed({ limit: 100, month: '2026-09' })).toEqual(expected((row) => row.month === '2026-09'));
    expect(await listed({ limit: 100, categoryCode: 'food' })).toEqual(expected((row) => row.categoryCode === 'food'));
    expect(await listed({ limit: 100, categoryCode: 'rent' })).toEqual(expected((row) => row.categoryCode === 'rent'));
    expect(await listed({ limit: 100, categoryCode: 'transportation' }))
      .toEqual(expected((row) => row.categoryCode === 'transportation'));
    expect(await listed({ limit: 100, kind: 'income' })).toEqual(expected((row) => row.kind === 'income'));
    expect(await listed({ limit: 100, kind: 'expense' })).toEqual(expected((row) => row.kind === 'expense'));
    expect(await listed({ limit: 100, balanceEffect: 'historical' }))
      .toEqual(expected((row) => row.balanceEffect === 'historical'));
    expect(await listed({ limit: 100, balanceEffect: 'current' }))
      .toEqual(expected((row) => row.balanceEffect === 'current'));
    expect(await listed({ limit: 100, month: '2026-10', categoryCode: 'food', kind: 'expense' }))
      .toEqual(expected((row) => row.month === '2026-10' && row.categoryCode === 'food' && row.kind === 'expense'));

    // Each filter must actually narrow: a subset, never the whole set.
    expect((await listed({ limit: 100, month: '2026-09' })).length).toBeLessThan(persisted.length);
    expect((await listed({ limit: 100, kind: 'income' })).length).toBe(1);
    expect((await listed({ limit: 100, balanceEffect: 'historical' })).length).toBe(2);

    // Filters compose with pagination.
    const filteredPage = await owner.repository.listTransactions(owner.ownerId, {
      limit: 1, month: '2026-10', categoryCode: 'food', kind: 'expense',
    });
    expect(filteredPage.items).toHaveLength(1);
    expect(filteredPage.nextCursor).not.toBeNull();
    const walked: string[] = [filteredPage.items[0]!.id];
    let cursor = filteredPage.nextCursor;
    while (cursor !== null) {
      const page = await owner.repository.listTransactions(owner.ownerId, {
        limit: 1, month: '2026-10', categoryCode: 'food', kind: 'expense', cursor,
      });
      walked.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    }
    expect(walked.sort()).toEqual(
      expected((row) => row.month === '2026-10' && row.categoryCode === 'food' && row.kind === 'expense'),
    );
    expect(new Set(walked).size).toBe(walked.length);

    // A filter with no persisted match is an empty page, not an error.
    const empty = await owner.repository.listTransactions(owner.ownerId, { limit: 100, categoryCode: 'emergency' });
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBeNull();
  }, 60_000);

  it('isolates owners for the page, the cursor, and the object lookup', async () => {
    const { owner, other, persisted, allOwnerIds, otherTransaction } = await seededFixture();
    const ownerRow = persisted.find((row) => row.occurredOn === '2026-10-05')!;

    const ownerPage = await owner.repository.listTransactions(owner.ownerId, { limit: 100 });
    expect(ownerPage.items.map((item) => item.id)).not.toContain(otherTransaction);
    expect(new Set(ownerPage.items.map((item) => item.id))).toEqual(new Set(allOwnerIds));

    const otherPage = await other.repository.listTransactions(other.ownerId, { limit: 100 });
    expect(otherPage.items.map((item) => item.id)).toEqual([otherTransaction]);

    // A cursor keyed on one owner's row cannot widen another owner's page: the
    // owner predicate is applied together with the keyset comparison.
    const forgedCursor = Buffer.from(
      JSON.stringify({ occurredOn: '2026-10-08', id: persisted[0]!.id }),
      'utf8',
    ).toString('base64url');
    const crossCursor = await other.repository.listTransactions(other.ownerId, {
      limit: 100,
      cursor: forgedCursor,
    });
    expect(crossCursor.items.map((item) => item.id)).toEqual([otherTransaction]);

    // Same-month, same-category, same-effect probe by the other owner still
    // returns only the other owner's row, never the matching owner row.
    const probe = await other.repository.listTransactions(other.ownerId, {
      limit: 100, month: '2026-10', categoryCode: 'food', kind: 'expense', balanceEffect: 'current',
    });
    expect(probe.items.map((item) => item.id)).toEqual([otherTransaction]);
    expect(probe.items.map((item) => item.id)).not.toContain(ownerRow.id);

    await expect(owner.repository.getTransaction(owner.ownerId, otherTransaction))
      .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE' });
    await expect(other.repository.getTransaction(other.ownerId, ownerRow.id))
      .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE' });
    await expect(owner.repository.getTransaction(other.ownerId, ownerRow.id))
      .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE' });
    await expect(owner.repository.getTransaction(owner.ownerId, randomUUID()))
      .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE' });
  }, 60_000);

  it('rejects invalid limits and forged cursors at the repository boundary', async () => {
    const { owner, persisted } = await seededFixture();

    for (const limit of [0, 101, -1, 1.5]) {
      await expect(owner.repository.listTransactions(owner.ownerId, { limit }))
        .rejects.toMatchObject({ code: 'FINANCIAL_VALIDATION_FAILED' });
    }

    await expect(owner.repository.listTransactions(owner.ownerId, { limit: 10, cursor: 'not-a-cursor' }))
      .rejects.toMatchObject({ code: 'FINANCIAL_VALIDATION_FAILED' });
    await expect(owner.repository.listTransactions(owner.ownerId, {
      limit: 10,
      cursor: Buffer.from(JSON.stringify({ occurredOn: '2026-10-05', id: 'not-a-uuid' }), 'utf8').toString('base64url'),
    })).rejects.toMatchObject({ code: 'FINANCIAL_VALIDATION_FAILED' });
    await expect(owner.repository.listTransactions(owner.ownerId, {
      limit: 10,
      cursor: Buffer.from(JSON.stringify({ occurredOn: '2026-13-45', id: persisted[0]!.id }), 'utf8').toString('base64url'),
    })).rejects.toMatchObject({ code: 'FINANCIAL_VALIDATION_FAILED' });
    await expect(owner.repository.listTransactions(owner.ownerId, {
      limit: 10,
      cursor: Buffer.from(JSON.stringify([persisted[0]!.id]), 'utf8').toString('base64url'),
    })).rejects.toMatchObject({ code: 'FINANCIAL_VALIDATION_FAILED' });

    // Accepted bounds still work, and a well-formed cursor for a key with no
    // later rows yields an empty page rather than failing.
    const minimum = await owner.repository.listTransactions(owner.ownerId, { limit: 1 });
    expect(minimum.items).toHaveLength(1);
    expect(minimum.nextCursor).not.toBeNull();
    const maximum = await owner.repository.listTransactions(owner.ownerId, { limit: 100 });
    expect(maximum.items).toHaveLength(persisted.length);
    const exhausted = await owner.repository.listTransactions(owner.ownerId, {
      limit: 100,
      cursor: Buffer.from(JSON.stringify({ occurredOn: '2026-01-01', id: randomUUID() }), 'utf8').toString('base64url'),
    });
    expect(exhausted.items).toEqual([]);
    expect(exhausted.nextCursor).toBeNull();
  }, 60_000);
});
