import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FinancialAccountBootstrapService,
  migrateDatabase,
  PostgresFinancialRepository,
  PostgresScheduleRepository,
  PostgresUserRepository,
  type UserRecord,
} from '../src/index.js';

/**
 * Cross-owner authorization for transaction corrections and schedule
 * occurrences, against real PostgreSQL.
 *
 * Authorization in this layer is carried by SQL predicates — there are no RLS
 * policies yet (`SPEC-SEC-01` is open) — so these tests pin the predicates on
 * the read *and* write paths of the two domains that had no dedicated isolation
 * suite. Every rejection is checked twice: the caller gets the same 404 it would
 * get for a resource that does not exist, and the database is byte-for-byte
 * unchanged afterwards. A positive control per domain proves the fixture works,
 * so a passing run cannot mean "every call failed anyway".
 *
 * The write cases replay a *real* preview signed for the owner. If ownership
 * were not checked, a valid preview would be enough to commit another account's
 * correction, so this is the strongest form of the test rather than a synthetic
 * invalid payload.
 */

const RETENTION_MS = 86_400_000;
const PREVIEW_SIGNING_KEY = 'ef'.repeat(32);
const TIMEZONE = 'Asia/Ho_Chi_Minh';

const integrationEnabled = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.KFIN_INTEGRATION_TARGET === 'non-production',
);
const integration = describe.skipIf(!integrationEnabled);

const UNAVAILABLE = { code: 'FINANCIAL_RESOURCE_UNAVAILABLE', statusCode: 404 };

integration('cross-owner authorization on real PostgreSQL', () => {
  let administration: Pool;
  let database: Pool;
  let schema: string;
  let users: PostgresUserRepository;

  interface Owner {
    readonly id: string;
    readonly snapshotId: string;
    readonly financial: PostgresFinancialRepository;
    readonly schedule: PostgresScheduleRepository;
    version: string;
  }

  const createOwner = async (label: string): Promise<Owner> => {
    const user: UserRecord = await users.create({
      email: `${label}-${randomUUID()}@example.invalid`,
      locale: 'en-VN',
      timezone: TIMEZONE,
      baseCurrency: 'VND',
      emailVerifiedAt: new Date(Date.now() - 60_000),
    });
    const foundation = await new FinancialAccountBootstrapService(database).bootstrap({
      ownerUserId: user.id,
      openingAmountMinor: '1000000',
      effectiveAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000),
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      idempotencyRetentionMs: RETENTION_MS,
    });
    return {
      id: user.id,
      snapshotId: foundation.snapshotId,
      financial: new PostgresFinancialRepository(database, RETENTION_MS, PREVIEW_SIGNING_KEY),
      schedule: new PostgresScheduleRepository(database, RETENTION_MS),
      version: foundation.financialStateVersion,
    };
  };

  const localToday = (): string => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const pick = (type: string) => parts.find((part) => part.type === type)!.value;
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  };

  const postExpense = async (owner: Owner, amountMinor = '300000'): Promise<string> => {
    const created = await owner.financial.createTransaction(owner.id, {
      kind: 'expense',
      amountMinor,
      occurredOn: localToday(),
      categoryCode: 'food',
      expenseClass: 'daily',
      isUnexpected: false,
      expectedFinancialStateVersion: owner.version,
      reviewedLatestSnapshotId: owner.snapshotId,
    }, randomUUID(), randomUUID());
    owner.version = created.financialStateVersion;
    return created.transactionId;
  };

  const createOneOff = async (owner: Owner): Promise<{ occurrenceId: string }> => {
    const created = await owner.schedule.createOneOff(owner.id, {
      title: 'Rent',
      kind: 'expense',
      expectedAmountMinor: '300000',
      dueOn: localToday(),
      categoryCode: 'rent',
      expenseClass: 'essential_fixed',
      expectedFinancialStateVersion: owner.version,
      reviewedLatestSnapshotId: owner.snapshotId,
    }, randomUUID(), randomUUID());
    owner.version = created.financialStateVersion;
    return { occurrenceId: created.occurrenceId };
  };

  /** Everything a rejected call must leave untouched, for one owner. */
  const snapshot = async (owner: Owner, subjectId?: string) => {
    const result = await database.query<Record<string, string | null>>(`
      SELECT
        (SELECT count(*) FROM transactions WHERE user_id = $1) AS transactions,
        (SELECT status || ':' || version FROM transactions WHERE user_id = $1 AND id = $2) AS subject,
        (SELECT current_balance_minor FROM financial_current_balances WHERE user_id = $1) AS balance,
        (SELECT financial_state_version FROM financial_current_balances WHERE user_id = $1) AS state_version,
        (SELECT count(*) FROM idempotency_results WHERE user_id = $1) AS receipts,
        (SELECT count(*) FROM audit_events WHERE user_id = $1) AS audits,
        (SELECT state || ':' || version || ':' || COALESCE(confirmed_transaction_id::text, 'null')
           FROM scheduled_occurrences WHERE user_id = $1 AND id = $3) AS occurrence
    `, [owner.id, subjectId ?? null, subjectId ?? null]);
    const row = result.rows[0]!;
    return {
      transactions: Number(row.transactions),
      subject: row.subject,
      balance: row.balance,
      stateVersion: row.state_version,
      receipts: Number(row.receipts),
      audits: Number(row.audits),
      occurrence: row.occurrence,
    };
  };

  const correctionRequest = (occurredOn: string) => ({
    reason: 'Correct entered financial fact',
    replacement: {
      amountMinor: '250000',
      occurredOn,
      categoryCode: 'food',
      expenseClass: 'daily' as const,
      isUnexpected: false,
    },
  });

  beforeAll(async () => {
    schema = `kfin_cross_owner_${randomUUID().replaceAll('-', '')}`;
    administration = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await administration.query(`CREATE SCHEMA ${schema}`);
    database = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 8,
      options: `-c search_path=${schema},public`,
    });
    await migrateDatabase(database);
    users = new PostgresUserRepository(database);
  }, 60_000);

  afterAll(async () => {
    if (database) await database.end();
    if (administration && schema) {
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administration.end();
    }
  }, 30_000);

  // ── transaction corrections ────────────────────────────────────────────────

  it('refuses every cross-owner read of a transaction and its correction history', async () => {
    const owner = await createOwner('corr-read-owner');
    const stranger = await createOwner('corr-read-stranger');
    const transactionId = await postExpense(owner);
    const before = await snapshot(owner, transactionId);
    const strangerBefore = await snapshot(stranger);

    await expect(stranger.financial.getTransaction(stranger.id, transactionId))
      .rejects.toMatchObject(UNAVAILABLE);
    await expect(stranger.financial.getTransactionCorrectionHistory(stranger.id, transactionId, { limit: 10 }))
      .rejects.toMatchObject(UNAVAILABLE);

    expect(await snapshot(owner, transactionId)).toEqual(before);
    expect(await snapshot(stranger)).toEqual(strangerBefore);
  }, 30_000);

  it('refuses a cross-owner correction even when the owner signed the preview', async () => {
    const owner = await createOwner('corr-write-owner');
    const stranger = await createOwner('corr-write-stranger');
    const transactionId = await postExpense(owner);
    const preview = await owner.financial.previewTransactionCorrection(
      owner.id,
      transactionId,
      correctionRequest(localToday()),
    );

    // A real, signed preview plus the attacker's own optimistic version: the
    // only thing standing between the stranger and the commit is ownership.
    const attackerContext = {
      ...preview.context,
      expectedFinancialStateVersion: stranger.version,
      reviewedLatestSnapshotId: stranger.snapshotId,
    };
    const ownerBefore = await snapshot(owner, transactionId);
    const strangerBefore = await snapshot(stranger);

    await expect(stranger.financial.correctTransaction(
      stranger.id,
      transactionId,
      { ...correctionRequest(localToday()), context: attackerContext },
      randomUUID(),
      randomUUID(),
    )).rejects.toMatchObject(UNAVAILABLE);

    await expect(stranger.financial.voidTransaction(
      stranger.id,
      transactionId,
      { reason: 'Void entered financial fact', context: attackerContext },
      randomUUID(),
      randomUUID(),
    )).rejects.toMatchObject(UNAVAILABLE);

    expect(await snapshot(owner, transactionId)).toEqual(ownerBefore);
    expect(await snapshot(stranger)).toEqual(strangerBefore);
    expect(ownerBefore.subject).toBe('posted:1');
  }, 30_000);

  it('lets the owner perform the same correction the stranger was refused', async () => {
    const owner = await createOwner('corr-control');
    const transactionId = await postExpense(owner);
    const preview = await owner.financial.previewTransactionCorrection(owner.id, transactionId, {
      reason: 'Correct entered financial fact',
      replacement: {
        amountMinor: '250000',
        occurredOn: localToday(),
        categoryCode: 'food',
        expenseClass: 'daily',
        isUnexpected: false,
      },
    });
    const result = await owner.financial.correctTransaction(
      owner.id,
      transactionId,
      { ...correctionRequest(localToday()), context: preview.context },
      randomUUID(),
      randomUUID(),
    );
    expect(result.sourceTransactionId).toBe(transactionId);
    expect(result.replacementTransactionId).not.toBeNull();
    const state = await snapshot(owner, transactionId);
    expect(state.subject).toBe('voided:2');
    expect(state.balance).toBe('750000');
  }, 30_000);

  // ── schedule occurrences ──────────────────────────────────────────────────

  it('refuses every cross-owner read of a schedule occurrence', async () => {
    const owner = await createOwner('occ-read-owner');
    const stranger = await createOwner('occ-read-stranger');
    const occurrence = await createOneOff(owner);
    const before = await snapshot(owner, occurrence.occurrenceId);
    const strangerBefore = await snapshot(stranger);

    await expect(stranger.schedule.getOccurrence(stranger.id, occurrence.occurrenceId))
      .rejects.toMatchObject(UNAVAILABLE);

    expect(await stranger.schedule.listOccurrences(stranger.id, { limit: 100 })).toEqual({
      items: [], nextCursor: null,
    });
    expect(await owner.schedule.listOccurrences(owner.id, { limit: 100 }))
      .toMatchObject({ items: [{ id: occurrence.occurrenceId }] });

    expect(await snapshot(owner, occurrence.occurrenceId)).toEqual(before);
    expect(await snapshot(stranger)).toEqual(strangerBefore);
  }, 30_000);

  it('refuses cross-owner confirmation and transitions and leaves the row unchanged', async () => {
    const owner = await createOwner('occ-write-owner');
    const stranger = await createOwner('occ-write-stranger');
    const occurrence = await createOneOff(owner);
    const before = await snapshot(owner, occurrence.occurrenceId);
    const strangerBefore = await snapshot(stranger);

    const confirmInput = {
      amountMinor: '300000',
      occurredOn: localToday(),
      categoryCode: 'rent',
      expenseClass: 'essential_fixed' as const,
      isUnexpected: false,
      expectedFinancialStateVersion: stranger.version,
      reviewedLatestSnapshotId: stranger.snapshotId,
      reviewedOccurrenceVersion: '1',
    };
    const transitionInput = {
      reason: 'Skipped by the account owner',
      expectedFinancialStateVersion: stranger.version,
      reviewedLatestSnapshotId: stranger.snapshotId,
      reviewedOccurrenceVersion: '1',
    };

    await expect(stranger.schedule.confirmOccurrence(
      stranger.id,
      occurrence.occurrenceId,
      confirmInput,
      randomUUID(),
      randomUUID(),
    )).rejects.toMatchObject(UNAVAILABLE);

    for (const target of ['skipped', 'cancelled'] as const) {
      await expect(stranger.schedule.transitionOccurrence(
        stranger.id,
        occurrence.occurrenceId,
        target,
        transitionInput,
        randomUUID(),
        randomUUID(),
      )).rejects.toMatchObject(UNAVAILABLE);
    }

    expect(await snapshot(owner, occurrence.occurrenceId)).toEqual(before);
    expect(await snapshot(stranger)).toEqual(strangerBefore);
    expect(before.occurrence).toBe('scheduled:1:null');
  }, 30_000);

  it('lets the owner confirm the occurrence the stranger was refused', async () => {
    const owner = await createOwner('occ-control');
    const occurrence = await createOneOff(owner);
    const confirmed = await owner.schedule.confirmOccurrence(owner.id, occurrence.occurrenceId, {
      amountMinor: '300000',
      occurredOn: localToday(),
      categoryCode: 'rent',
      expenseClass: 'essential_fixed',
      isUnexpected: false,
      expectedFinancialStateVersion: owner.version,
      reviewedLatestSnapshotId: owner.snapshotId,
      reviewedOccurrenceVersion: '1',
    }, randomUUID(), randomUUID());
    expect(confirmed).toMatchObject({ state: 'confirmed', occurrenceVersion: '2' });
    const state = await snapshot(owner, occurrence.occurrenceId);
    expect(state.occurrence).toMatch(`confirmed:2:${confirmed.transactionId}`);
    expect(state.transactions).toBe(1);
  }, 30_000);
});
