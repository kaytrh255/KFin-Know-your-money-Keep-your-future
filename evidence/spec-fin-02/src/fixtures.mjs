import { deleteSyntheticUser } from './schema.mjs';
import { safeToken, syntheticEmailToken, uuid } from './util.mjs';

const INITIAL_SNAPSHOT_AT = '2026-01-01T00:00:00.000Z';
const INITIAL_LOCAL_DATE = '2026-01-01';

export async function createBaseFixture(pool, { withSourceTransaction = false, linkedOccurrence = false } = {}) {
  const lease = await pool.checkout('fixture.create');
  const fixture = {
    userId: uuid(),
    accountId: uuid(),
    initialSnapshotId: uuid(),
    sourceTransactionId: null,
    occurrenceId: null,
    initialVersion: withSourceTransaction ? 2n : 1n,
  };
  try {
    await lease.query('BEGIN');
    await lease.query(
      `INSERT INTO synthetic_users(id, email_token, timezone, base_currency)
       VALUES ($1, $2, 'UTC', 'VND')`,
      [fixture.userId, syntheticEmailToken()],
    );
    await lease.query(
      `INSERT INTO financial_accounts(
         id, user_id, currency, financial_state_version
       ) VALUES ($1, $2, 'VND', $3)`,
      [fixture.accountId, fixture.userId, fixture.initialVersion.toString()],
    );
    await lease.query(
      `INSERT INTO balance_snapshots(
         id, user_id, account_id, amount_minor, currency,
         effective_at, effective_local_date, timezone, reason, correlation_token
       ) VALUES ($1, $2, $3, 1000000, 'VND', $4, $5, 'UTC', 'onboarding', $6)`,
      [
        fixture.initialSnapshotId,
        fixture.userId,
        fixture.accountId,
        INITIAL_SNAPSHOT_AT,
        INITIAL_LOCAL_DATE,
        safeToken('fixture'),
      ],
    );

    if (withSourceTransaction) {
      fixture.sourceTransactionId = uuid();
      await lease.query(
        `INSERT INTO transactions(
           id, user_id, account_id, balance_snapshot_id, kind, amount_minor,
           currency, occurred_on, balance_effect, already_included_in_snapshot,
           status, correlation_token
         ) VALUES ($1, $2, $3, $4, 'expense', 300000, 'VND',
                   DATE '2026-01-02', 'current', false, 'posted', $5)`,
        [
          fixture.sourceTransactionId,
          fixture.userId,
          fixture.accountId,
          fixture.initialSnapshotId,
          safeToken('fixture'),
        ],
      );
    }

    if (linkedOccurrence) {
      if (!fixture.sourceTransactionId) throw new Error('Linked occurrence requires source transaction');
      fixture.occurrenceId = uuid();
      await lease.query(
        `INSERT INTO scheduled_occurrences(
           id, user_id, account_id, state, confirmed_transaction_id
         ) VALUES ($1, $2, $3, 'confirmed', $4)`,
        [fixture.occurrenceId, fixture.userId, fixture.accountId, fixture.sourceTransactionId],
      );
    }
    await lease.query('COMMIT');
    return fixture;
  } catch (error) {
    await lease.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    lease.release();
  }
}

export async function destroyFixture(pool, fixture) {
  const lease = await pool.checkout('fixture.destroy');
  try {
    await deleteSyntheticUser(lease.client, fixture.userId);
  } finally {
    lease.release();
  }
}

export async function readFixtureState(pool, fixture) {
  const lease = await pool.checkout('fixture.observe');
  try {
    const result = await lease.query(
      `SELECT
         a.financial_state_version::text AS financial_state_version,
         (SELECT count(*)::int FROM balance_snapshots s
           WHERE s.user_id = a.user_id AND s.account_id = a.id) AS snapshot_count,
         (SELECT count(*)::int FROM transactions t
           WHERE t.user_id = a.user_id AND t.account_id = a.id) AS transaction_count,
         (SELECT count(*)::int FROM transactions t
           WHERE t.user_id = a.user_id AND t.account_id = a.id AND t.status = 'posted') AS posted_count,
         (SELECT count(*)::int FROM transactions t
           WHERE t.user_id = a.user_id AND t.account_id = a.id AND t.status = 'voided') AS voided_count,
         (SELECT count(*)::int FROM transactions t
           WHERE t.user_id = a.user_id AND t.account_id = a.id
             AND t.supersedes_transaction_id IS NOT NULL) AS replacement_count,
         (SELECT count(*)::int FROM idempotency_keys i
           WHERE i.user_id = a.user_id AND i.account_id = a.id) AS idempotency_count,
         (SELECT count(*)::int FROM audit_events e
           WHERE e.user_id = a.user_id AND e.account_id = a.id) AS audit_count,
         (SELECT id FROM balance_snapshots s
           WHERE s.user_id = a.user_id AND s.account_id = a.id
           ORDER BY effective_at DESC, id DESC LIMIT 1) AS latest_snapshot_id
       FROM financial_accounts a
       WHERE a.id = $1 AND a.user_id = $2`,
      [fixture.accountId, fixture.userId],
    );
    if (result.rowCount !== 1) throw new Error('Synthetic fixture account disappeared');
    return {
      version: BigInt(result.rows[0].financial_state_version),
      snapshotCount: result.rows[0].snapshot_count,
      transactionCount: result.rows[0].transaction_count,
      postedCount: result.rows[0].posted_count,
      voidedCount: result.rows[0].voided_count,
      replacementCount: result.rows[0].replacement_count,
      idempotencyCount: result.rows[0].idempotency_count,
      auditCount: result.rows[0].audit_count,
      latestSnapshotId: result.rows[0].latest_snapshot_id,
    };
  } finally {
    lease.release();
  }
}

export function recordFixtureState(recorder, caseId, scenario, state) {
  recorder.event('database.final_state', {
    caseId,
    scenario,
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

export async function readTransactions(pool, fixture) {
  const lease = await pool.checkout('fixture.transactions_observe');
  try {
    const result = await lease.query(
      `SELECT id, balance_snapshot_id, status, supersedes_transaction_id
       FROM transactions
       WHERE user_id = $1 AND account_id = $2
       ORDER BY created_at, id`,
      [fixture.userId, fixture.accountId],
    );
    return result.rows;
  } finally {
    lease.release();
  }
}

export async function readOccurrence(pool, occurrenceId) {
  const lease = await pool.checkout('fixture.occurrence_observe');
  try {
    const result = await lease.query(
      `SELECT state, confirmed_transaction_id
       FROM scheduled_occurrences
       WHERE id = $1`,
      [occurrenceId],
    );
    return result.rows[0] || null;
  } finally {
    lease.release();
  }
}

export function nextSnapshotAt(sequence = 1) {
  const day = String(Math.min(27, sequence + 1)).padStart(2, '0');
  return {
    effectiveAt: `2026-01-${day}T00:00:00.000Z`,
    effectiveLocalDate: `2026-01-${day}`,
  };
}
