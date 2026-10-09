import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  assertAsOfNotFuture,
  assertContributionPlan,
  assertSavingsLocalDate,
  computeSavingsProgress,
  FinancialError,
  normalizeSavingsGoalName,
  normalizeSavingsReason,
  parseDatabaseBigint,
  parseNonNegativeSavingsMinor,
  parsePositiveSavingsMinor,
  savingsGoalArchived,
  savingsGoalInvalid,
  savingsGoalVersionConflict,
  unavailableError,
  validationError,
  type ContributionFrequency,
  type SavingsGoalStatus,
  type SavingsProgress,
} from '@kfin/domain';
import { digestCanonicalRequest, digestSecret } from './canonical.js';

/**
 * Milestone 06 — savings goals (PRD-SAV-01..07, DATABASE §9, UF-SAV-01).
 *
 * A goal's current amount is an absolute, user-declared reserve estimate. This
 * repository never reads or writes financial accounts, balance snapshots,
 * transactions, or monthly actuals. Every write is one READ COMMITTED
 * transaction that locks the owner (create) or the goal row (mutations),
 * resolves the user-scoped idempotency receipt, checks the optimistic version,
 * and commits the goal row, its immutable old/new amount-change row (when the
 * amount changes), the idempotency receipt, and an audit event together.
 */

export interface CreateSavingsGoalInput {
  readonly name: string;
  readonly targetAmountMinor: string;
  readonly currentAmountMinor: string;
  readonly currentAmountAsOf: string;
  readonly targetDate?: string | null;
  readonly plannedContributionMinor?: string | null;
  readonly contributionFrequency?: ContributionFrequency | null;
}

export interface UpdateSavingsGoalPlanInput {
  readonly expectedVersion: string;
  readonly name?: string;
  readonly targetAmountMinor?: string;
  readonly targetDate?: string | null;
  readonly plannedContributionMinor?: string | null;
  readonly contributionFrequency?: ContributionFrequency | null;
}

export interface UpdateSavingsCurrentAmountInput {
  readonly expectedVersion: string;
  readonly currentAmountMinor: string;
  readonly asOf: string;
  readonly reason?: string;
}

export interface ArchiveSavingsGoalInput {
  readonly expectedVersion: string;
}

export interface SavingsGoalView {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly targetAmountMinor: string;
  readonly currentAmountMinor: string;
  readonly currentAmountAsOf: string;
  readonly targetDate: string | null;
  readonly plannedContributionMinor: string | null;
  readonly contributionFrequency: ContributionFrequency | null;
  readonly status: SavingsGoalStatus;
  readonly archivedAt: string | null;
  readonly progress: SavingsProgress;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: string;
}

export interface SavingsAmountChangeView {
  readonly id: string;
  readonly goalVersion: string;
  readonly previousAmountMinor: string | null;
  readonly newAmountMinor: string;
  readonly asOf: string;
  readonly source: 'initial' | 'manual_update' | 'planned_purchase_use' | 'recovery_correction';
  readonly reason: string | null;
  readonly actorType: 'user' | 'operator';
  readonly createdAt: string;
}

export interface SavingsGoalAmountReceipt {
  readonly goalId: string;
  readonly version: string;
  readonly amountChangeId: string;
  readonly replayed: boolean;
}

export interface SavingsGoalReceipt {
  readonly goalId: string;
  readonly version: string;
  readonly replayed: boolean;
}

export interface SavingsGoalPage {
  readonly items: SavingsGoalView[];
  readonly nextCursor: string | null;
}

export interface SavingsAmountChangePage {
  readonly items: SavingsAmountChangeView[];
  readonly nextCursor: string | null;
}

export interface SavingsGoalRepositoryOptions {
  readonly idempotencyRetentionMs?: number;
  readonly now?: () => Date;
}

const OPERATION = {
  create: 'savings.goal.create',
  updatePlan: 'savings.goal.plan.update',
  updateAmount: 'savings.goal.current_amount.update',
  archive: 'savings.goal.archive',
} as const;

type Query = <Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
) => Promise<QueryResult<Row>>;

interface GoalRow extends QueryResultRow {
  id: string;
  name: string;
  currency: string;
  target_amount_minor: string;
  current_amount_minor: string;
  current_amount_as_of: string;
  target_date: string | null;
  planned_contribution_minor: string | null;
  contribution_frequency: ContributionFrequency | null;
  status: SavingsGoalStatus;
  archived_at: Date | null;
  created_at: Date;
  created_at_cursor: string;
  updated_at: Date;
  version: string;
}

interface LockedGoalRow extends GoalRow {
  timezone: string;
}

interface ChangeRow extends QueryResultRow {
  id: string;
  goal_version: string;
  previous_amount_minor: string | null;
  new_amount_minor: string;
  as_of: string;
  source: SavingsAmountChangeView['source'];
  reason: string | null;
  actor_user_id: string | null;
  created_at: Date;
}

interface ReceiptRow extends QueryResultRow {
  request_digest: string;
  result: Record<string, unknown>;
}

const GOAL_COLUMNS = `
  g.id, g.name, g.currency, g.target_amount_minor, g.current_amount_minor,
  g.current_amount_as_of::text AS current_amount_as_of, g.target_date::text AS target_date,
  g.planned_contribution_minor, g.contribution_frequency, g.status, g.archived_at,
  g.created_at,
  to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
  g.updated_at, g.version
`;

const RETRYABLE_SQLSTATES = new Set(['55P03', '40P01', '40001', '23505']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[1-9][0-9]{0,18}$/;

export class PostgresSavingsGoalRepository {
  private readonly idempotencyRetentionMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pick<Pool, 'connect' | 'query'>,
    options: SavingsGoalRepositoryOptions = {},
  ) {
    this.idempotencyRetentionMs = options.idempotencyRetentionMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  /** PRD-SAV-01/02: create a goal and its `initial` amount-change row atomically. */
  async createGoal(
    ownerUserId: string,
    input: CreateSavingsGoalInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<SavingsGoalAmountReceipt> {
    const name = normalizeSavingsGoalName(input.name);
    const target = parsePositiveSavingsMinor(input.targetAmountMinor, 'Target amount');
    const current = parseNonNegativeSavingsMinor(input.currentAmountMinor, 'Current amount');
    const asOf = assertSavingsLocalDate(input.currentAmountAsOf, 'As-of date');
    const targetDate = input.targetDate == null
      ? null
      : assertSavingsLocalDate(input.targetDate, 'Target date');
    const contribution = input.plannedContributionMinor == null
      ? null
      : parsePositiveSavingsMinor(input.plannedContributionMinor, 'Planned contribution');
    const frequency = input.contributionFrequency ?? null;
    assertContributionPlan(contribution, frequency);
    const keyDigest = digestSecret(idempotencyKey);
    const requestDigest = digestCanonicalRequest({
      name, target, current, asOf, targetDate, contribution, frequency,
    });

    return this.runIdempotent(async (query) => {
      const userResult = await query<{ timezone: string; base_currency: string }>(`
        SELECT timezone, base_currency
        FROM users
        WHERE id = $1 AND status = 'active' AND email_verified_at IS NOT NULL
        FOR UPDATE
      `, [ownerUserId]);
      const user = userResult.rows[0];
      if (!user) throw unavailableError();

      const replay = await this.findReceipt(query, ownerUserId, OPERATION.create, keyDigest, requestDigest);
      if (replay) return amountReceipt(replay);

      assertAsOfNotFuture(asOf, this.now(), user.timezone);
      const goalId = randomUUID();
      const changeId = randomUUID();
      await query(`
        INSERT INTO savings_goals (
          id, user_id, name, target_amount_minor, current_amount_minor, currency,
          current_amount_as_of, target_date, planned_contribution_minor, contribution_frequency
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        goalId, ownerUserId, name, target.toString(), current.toString(), user.base_currency,
        asOf, targetDate, contribution?.toString() ?? null, frequency,
      ]);
      await insertAmountChange(query, {
        id: changeId,
        ownerUserId,
        goalId,
        goalVersion: '1',
        previous: null,
        next: current,
        asOf,
        source: 'initial',
        reason: null,
        correlationId,
      });
      const result = { goalId, version: '1', amountChangeId: changeId };
      await this.writeReceiptAndAudit(query, {
        ownerUserId,
        operation: OPERATION.create,
        keyDigest,
        requestDigest,
        responseStatus: 201,
        result,
        goalId,
        correlationId,
        metadata: { amountChangeId: changeId },
      });
      return { ...result, replayed: false };
    });
  }

  /** PRD-SAV-03: absolute replacement of the current amount with one old/new history row. */
  async updateCurrentAmount(
    ownerUserId: string,
    goalId: string,
    input: UpdateSavingsCurrentAmountInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<SavingsGoalAmountReceipt> {
    assertGoalId(goalId);
    const expectedVersion = parseVersion(input.expectedVersion);
    const next = parseNonNegativeSavingsMinor(input.currentAmountMinor, 'Current amount');
    const asOf = assertSavingsLocalDate(input.asOf, 'As-of date');
    const reason = normalizeSavingsReason(input.reason);
    const keyDigest = digestSecret(idempotencyKey);
    const requestDigest = digestCanonicalRequest({ goalId, expectedVersion, next, asOf, reason });

    return this.runIdempotent(async (query) => {
      const goal = await lockGoal(query, ownerUserId, goalId);
      const replay = await this.findReceipt(
        query, ownerUserId, OPERATION.updateAmount, keyDigest, requestDigest,
      );
      if (replay) return amountReceipt(replay);
      assertMutable(goal, expectedVersion);
      assertAsOfNotFuture(asOf, this.now(), goal.timezone);

      const nextVersion = (expectedVersion + 1n).toString();
      await query(`
        UPDATE savings_goals
        SET current_amount_minor = $3, current_amount_as_of = $4,
            version = version + 1, updated_at = clock_timestamp()
        WHERE user_id = $1 AND id = $2 AND version = $5
      `, [ownerUserId, goalId, next.toString(), asOf, expectedVersion.toString()]);
      const changeId = randomUUID();
      await insertAmountChange(query, {
        id: changeId,
        ownerUserId,
        goalId,
        goalVersion: nextVersion,
        previous: parseDatabaseBigint(goal.current_amount_minor),
        next,
        asOf,
        source: 'manual_update',
        reason,
        correlationId,
      });
      const result = { goalId, version: nextVersion, amountChangeId: changeId };
      await this.writeReceiptAndAudit(query, {
        ownerUserId,
        operation: OPERATION.updateAmount,
        keyDigest,
        requestDigest,
        responseStatus: 200,
        result,
        goalId,
        correlationId,
        metadata: { amountChangeId: changeId, version: nextVersion },
      });
      return { ...result, replayed: false };
    });
  }

  /** PRD-SAV-04 / SAV-04: edit plan details without touching the current amount. */
  async updatePlan(
    ownerUserId: string,
    goalId: string,
    input: UpdateSavingsGoalPlanInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<SavingsGoalReceipt> {
    assertGoalId(goalId);
    const expectedVersion = parseVersion(input.expectedVersion);
    const patch = {
      name: input.name === undefined ? undefined : normalizeSavingsGoalName(input.name),
      target: input.targetAmountMinor === undefined
        ? undefined
        : parsePositiveSavingsMinor(input.targetAmountMinor, 'Target amount'),
      targetDate: input.targetDate === undefined
        ? undefined
        : input.targetDate === null ? null : assertSavingsLocalDate(input.targetDate, 'Target date'),
      contribution: input.plannedContributionMinor === undefined
        ? undefined
        : input.plannedContributionMinor === null
          ? null
          : parsePositiveSavingsMinor(input.plannedContributionMinor, 'Planned contribution'),
      frequency: input.contributionFrequency,
    };
    const changedFields = Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field);
    if (changedFields.length === 0) throw validationError('At least one plan field must be provided.');
    const keyDigest = digestSecret(idempotencyKey);
    const requestDigest = digestCanonicalRequest({ goalId, expectedVersion, ...patch });

    return this.runIdempotent(async (query) => {
      const goal = await lockGoal(query, ownerUserId, goalId);
      const replay = await this.findReceipt(
        query, ownerUserId, OPERATION.updatePlan, keyDigest, requestDigest,
      );
      if (replay) return receipt(replay);
      assertMutable(goal, expectedVersion);

      const contribution = patch.contribution !== undefined
        ? patch.contribution
        : goal.planned_contribution_minor === null
          ? null
          : parseDatabaseBigint(goal.planned_contribution_minor);
      const frequency = patch.frequency !== undefined ? patch.frequency : goal.contribution_frequency;
      assertContributionPlan(contribution, frequency);

      const nextVersion = (expectedVersion + 1n).toString();
      await query(`
        UPDATE savings_goals
        SET name = $3, target_amount_minor = $4, target_date = $5,
            planned_contribution_minor = $6, contribution_frequency = $7,
            version = version + 1, updated_at = clock_timestamp()
        WHERE user_id = $1 AND id = $2 AND version = $8
      `, [
        ownerUserId,
        goalId,
        patch.name ?? goal.name,
        (patch.target ?? parseDatabaseBigint(goal.target_amount_minor)).toString(),
        patch.targetDate !== undefined ? patch.targetDate : goal.target_date,
        contribution?.toString() ?? null,
        frequency,
        expectedVersion.toString(),
      ]);
      const result = { goalId, version: nextVersion };
      await this.writeReceiptAndAudit(query, {
        ownerUserId,
        operation: OPERATION.updatePlan,
        keyDigest,
        requestDigest,
        responseStatus: 200,
        result,
        goalId,
        correlationId,
        metadata: { changedFields, version: nextVersion },
      });
      return { ...result, replayed: false };
    });
  }

  /** PRD-SAV-07: archive keeps the latest value and history; archive is terminal. */
  async archiveGoal(
    ownerUserId: string,
    goalId: string,
    input: ArchiveSavingsGoalInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<SavingsGoalReceipt> {
    assertGoalId(goalId);
    const expectedVersion = parseVersion(input.expectedVersion);
    const keyDigest = digestSecret(idempotencyKey);
    const requestDigest = digestCanonicalRequest({ goalId, expectedVersion });

    return this.runIdempotent(async (query) => {
      const goal = await lockGoal(query, ownerUserId, goalId);
      const replay = await this.findReceipt(query, ownerUserId, OPERATION.archive, keyDigest, requestDigest);
      if (replay) return receipt(replay);
      assertMutable(goal, expectedVersion);
      const nextVersion = (expectedVersion + 1n).toString();
      await query(`
        UPDATE savings_goals
        SET status = 'archived', archived_at = clock_timestamp(),
            version = version + 1, updated_at = clock_timestamp()
        WHERE user_id = $1 AND id = $2 AND version = $3
      `, [ownerUserId, goalId, expectedVersion.toString()]);
      const result = { goalId, version: nextVersion };
      await this.writeReceiptAndAudit(query, {
        ownerUserId,
        operation: OPERATION.archive,
        keyDigest,
        requestDigest,
        responseStatus: 200,
        result,
        goalId,
        correlationId,
        metadata: { version: nextVersion },
      });
      return { ...result, replayed: false };
    });
  }

  async getGoal(ownerUserId: string, goalId: string): Promise<SavingsGoalView> {
    assertGoalId(goalId);
    const result = await this.read(() => this.pool.query<GoalRow>(`
      SELECT ${GOAL_COLUMNS}
      FROM savings_goals AS g
      WHERE g.user_id = $1 AND g.id = $2
    `, [ownerUserId, goalId]));
    const row = result.rows[0];
    if (!row) throw unavailableError();
    return goalView(row);
  }

  /** SAV-01: owner-only list, filtered by status, ordered oldest first. */
  async listGoals(
    ownerUserId: string,
    options: {
      readonly status: 'active' | 'archived' | 'all';
      readonly limit: number;
      readonly cursor?: string;
    },
  ): Promise<SavingsGoalPage> {
    const limit = boundedLimit(options.limit);
    const values: unknown[] = [ownerUserId];
    const where = ['g.user_id = $1'];
    if (options.status !== 'all') {
      values.push(options.status);
      where.push(`g.status = $${values.length}`);
    }
    if (options.cursor) {
      const cursor = decodeGoalCursor(options.cursor);
      values.push(cursor.createdAt, cursor.id);
      where.push(`(g.created_at, g.id) > ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const result = await this.read(() => this.pool.query<GoalRow>(`
      SELECT ${GOAL_COLUMNS}
      FROM savings_goals AS g
      WHERE ${where.join(' AND ')}
      ORDER BY g.created_at ASC, g.id ASC
      LIMIT $${values.length}
    `, values));
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map(goalView),
      nextCursor: result.rows.length > limit && last
        ? encodeCursor({ createdAt: last.created_at_cursor, id: last.id })
        : null,
    };
  }

  /** SAV-05: immutable amount history, newest goal version first. */
  async listAmountChanges(
    ownerUserId: string,
    goalId: string,
    options: { readonly limit: number; readonly cursor?: string },
  ): Promise<SavingsAmountChangePage> {
    assertGoalId(goalId);
    const limit = boundedLimit(options.limit);
    const owned = await this.read(() => this.pool.query(
      'SELECT 1 FROM savings_goals WHERE user_id = $1 AND id = $2',
      [ownerUserId, goalId],
    ));
    if (!owned.rowCount) throw unavailableError();
    const values: unknown[] = [ownerUserId, goalId];
    let cursorClause = '';
    if (options.cursor) {
      values.push(decodeVersionCursor(options.cursor));
      cursorClause = `AND c.goal_version < $${values.length}`;
    }
    values.push(limit + 1);
    const result = await this.read(() => this.pool.query<ChangeRow>(`
      SELECT c.id, c.goal_version, c.previous_amount_minor, c.new_amount_minor,
             c.as_of::text AS as_of, c.source, c.reason, c.actor_user_id, c.created_at
      FROM savings_amount_changes AS c
      WHERE c.user_id = $1 AND c.savings_goal_id = $2 ${cursorClause}
      ORDER BY c.goal_version DESC
      LIMIT $${values.length}
    `, values));
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map(changeView),
      nextCursor: result.rows.length > limit && last
        ? encodeCursor({ goalVersion: String(last.goal_version) })
        : null,
    };
  }

  private async findReceipt(
    query: Query,
    ownerUserId: string,
    operation: string,
    keyDigest: string,
    requestDigest: string,
  ): Promise<Record<string, unknown> | null> {
    const existing = await query<ReceiptRow>(`
      SELECT request_digest, result
      FROM idempotency_results
      WHERE user_id = $1 AND account_id IS NULL AND operation = $2 AND key_digest = $3
    `, [ownerUserId, operation, keyDigest]);
    const row = existing.rows[0];
    if (!row) return null;
    if (row.request_digest.trim() !== requestDigest) {
      throw new FinancialError({
        code: 'IDEMPOTENCY_KEY_REUSED',
        statusCode: 409,
        safeMessage: 'The idempotency key was already used for a different request.',
      });
    }
    return row.result;
  }

  private async writeReceiptAndAudit(
    query: Query,
    input: {
      readonly ownerUserId: string;
      readonly operation: string;
      readonly keyDigest: string;
      readonly requestDigest: string;
      readonly responseStatus: number;
      readonly result: Record<string, string>;
      readonly goalId: string;
      readonly correlationId: string;
      readonly metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await query(`
      INSERT INTO idempotency_results (
        id, user_id, account_id, operation, key_digest, request_digest,
        response_status, result_code, result, correlation_id, expires_at
      ) VALUES ($1, $2, NULL, $3, $4, $5, $6, 'OK', $7::jsonb, $8,
                clock_timestamp() + ($9::bigint * interval '1 millisecond'))
    `, [
      randomUUID(),
      input.ownerUserId,
      input.operation,
      input.keyDigest,
      input.requestDigest,
      input.responseStatus,
      JSON.stringify(input.result),
      input.correlationId,
      this.idempotencyRetentionMs,
    ]);
    await query(`
      INSERT INTO audit_events (
        id, user_id, actor_user_id, action, resource_type, resource_id,
        outcome, correlation_id, metadata
      ) VALUES ($1, $2, $2, $3, 'savings_goal', $4, 'committed', $5, $6::jsonb)
    `, [
      randomUUID(),
      input.ownerUserId,
      input.operation,
      input.goalId,
      input.correlationId,
      JSON.stringify(input.metadata),
    ]);
  }

  /**
   * Runs an idempotent write. If COMMIT fails without a SQLSTATE the outcome is
   * unknown; one bounded recovery attempt replays through the receipt (or
   * performs the write if it never committed) before reporting
   * FINANCIAL_RESULT_UNKNOWN.
   */
  private async runIdempotent<T>(work: (query: Query) => Promise<T>): Promise<T> {
    try {
      return await this.attempt(work);
    } catch (error) {
      if (!(error instanceof CommitOutcomeUnknown)) throw error;
      try {
        return await this.attempt(work);
      } catch (recoveryError) {
        if (recoveryError instanceof FinancialError && recoveryError.statusCode < 500) {
          throw recoveryError;
        }
        throw new FinancialError({
          code: 'FINANCIAL_RESULT_UNKNOWN',
          statusCode: 503,
          safeMessage: 'The result is not yet known. Retry with the same idempotency key.',
          retryAfterSeconds: 1,
          cause: recoveryError,
        });
      }
    }
  }

  private async attempt<T>(work: (query: Query) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw databaseUnavailable(error);
    }
    let commitSent = false;
    let destroy = false;
    const query: Query = (text, values = []) => client.query(text, [...values]);
    try {
      await query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await query("SELECT set_config('lock_timeout', '2000ms', true)");
      await query("SELECT set_config('statement_timeout', '5000ms', true)");
      const value = await work(query);
      commitSent = true;
      await query('COMMIT');
      return value;
    } catch (error) {
      if (commitSent && sqlstateOf(error) === null) {
        destroy = true;
        throw new CommitOutcomeUnknown(error);
      }
      try {
        await client.query('ROLLBACK');
      } catch {
        destroy = true;
      }
      throw mapDatabaseError(error);
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  private async read<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }
}

async function lockGoal(query: Query, ownerUserId: string, goalId: string): Promise<LockedGoalRow> {
  const result = await query<LockedGoalRow>(`
    SELECT ${GOAL_COLUMNS}, u.timezone
    FROM savings_goals AS g
    JOIN users AS u ON u.id = g.user_id
    WHERE g.user_id = $1 AND g.id = $2
      AND u.status = 'active' AND u.email_verified_at IS NOT NULL
    FOR UPDATE OF g
  `, [ownerUserId, goalId]);
  const goal = result.rows[0];
  if (!goal) throw unavailableError();
  return goal;
}

function assertMutable(goal: GoalRow, expectedVersion: bigint): void {
  if (goal.status === 'archived') throw savingsGoalArchived();
  if (parseDatabaseBigint(goal.version) !== expectedVersion) throw savingsGoalVersionConflict();
}

async function insertAmountChange(
  query: Query,
  input: {
    readonly id: string;
    readonly ownerUserId: string;
    readonly goalId: string;
    readonly goalVersion: string;
    readonly previous: bigint | null;
    readonly next: bigint;
    readonly asOf: string;
    readonly source: 'initial' | 'manual_update';
    readonly reason: string | null;
    readonly correlationId: string;
  },
): Promise<void> {
  await query(`
    INSERT INTO savings_amount_changes (
      id, user_id, savings_goal_id, goal_version, previous_amount_minor, new_amount_minor,
      as_of, source, reason, actor_user_id, correlation_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $2, $10)
  `, [
    input.id,
    input.ownerUserId,
    input.goalId,
    input.goalVersion,
    input.previous?.toString() ?? null,
    input.next.toString(),
    input.asOf,
    input.source,
    input.reason,
    input.correlationId,
  ]);
}

function goalView(row: GoalRow): SavingsGoalView {
  const target = parseDatabaseBigint(row.target_amount_minor);
  const current = parseDatabaseBigint(row.current_amount_minor);
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    targetAmountMinor: target.toString(),
    currentAmountMinor: current.toString(),
    currentAmountAsOf: row.current_amount_as_of,
    targetDate: row.target_date,
    plannedContributionMinor: row.planned_contribution_minor === null
      ? null
      : parseDatabaseBigint(row.planned_contribution_minor).toString(),
    contributionFrequency: row.contribution_frequency,
    status: row.status,
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at).toISOString(),
    progress: computeSavingsProgress(current, target),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    version: parseDatabaseBigint(row.version).toString(),
  };
}

function changeView(row: ChangeRow): SavingsAmountChangeView {
  return {
    id: row.id,
    goalVersion: parseDatabaseBigint(row.goal_version).toString(),
    previousAmountMinor: row.previous_amount_minor === null
      ? null
      : parseDatabaseBigint(row.previous_amount_minor).toString(),
    newAmountMinor: parseDatabaseBigint(row.new_amount_minor).toString(),
    asOf: row.as_of,
    source: row.source,
    reason: row.reason,
    actorType: row.actor_user_id === null ? 'operator' : 'user',
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function amountReceipt(result: Record<string, unknown>): SavingsGoalAmountReceipt {
  const { goalId, version, amountChangeId } = result;
  if (typeof goalId !== 'string' || typeof version !== 'string' || typeof amountChangeId !== 'string') {
    throw databaseUnavailable(new Error('Malformed savings idempotency receipt.'));
  }
  return { goalId, version, amountChangeId, replayed: true };
}

function receipt(result: Record<string, unknown>): SavingsGoalReceipt {
  const { goalId, version } = result;
  if (typeof goalId !== 'string' || typeof version !== 'string') {
    throw databaseUnavailable(new Error('Malformed savings idempotency receipt.'));
  }
  return { goalId, version, replayed: true };
}

function assertGoalId(goalId: string): void {
  if (!UUID_PATTERN.test(goalId)) throw unavailableError();
}

function parseVersion(value: string): bigint {
  if (!VERSION_PATTERN.test(value)) throw validationError('Expected version is invalid.');
  return BigInt(value);
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw validationError('Limit must be an integer from 1 to 100.');
  }
  return value;
}

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursorObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw validationError('Cursor is invalid.');
}

function decodeGoalCursor(value: string): { readonly createdAt: string; readonly id: string } {
  const { createdAt, id } = decodeCursorObject(value);
  if (
    typeof createdAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt)
    || Number.isNaN(Date.parse(createdAt))
    || typeof id !== 'string'
    || !UUID_PATTERN.test(id)
  ) throw validationError('Cursor is invalid.');
  return { createdAt, id };
}

function decodeVersionCursor(value: string): string {
  const { goalVersion } = decodeCursorObject(value);
  if (typeof goalVersion !== 'string' || !VERSION_PATTERN.test(goalVersion)) {
    throw validationError('Cursor is invalid.');
  }
  return goalVersion;
}

function mapDatabaseError(error: unknown): unknown {
  if (error instanceof FinancialError) return error;
  const sqlstate = sqlstateOf(error);
  if (sqlstate !== null && RETRYABLE_SQLSTATES.has(sqlstate)) {
    return new FinancialError({
      code: 'FINANCIAL_CONCURRENCY_BUSY',
      statusCode: 409,
      safeMessage: 'The savings goal is busy. Retry with the same idempotency key.',
      retryAfterSeconds: 1,
      cause: error,
    });
  }
  if (sqlstate === '57014') {
    return new FinancialError({
      code: 'FINANCIAL_OPERATION_TIMEOUT',
      statusCode: 503,
      safeMessage: 'The operation timed out. Retry safely with the same idempotency key.',
      retryAfterSeconds: 1,
      cause: error,
    });
  }
  if (sqlstate === '22003' || sqlstate === '22008') {
    return savingsGoalInvalid('A savings goal value is outside the supported range.');
  }
  if (sqlstate === '22021') {
    // QA F-1 defense in depth: a character PostgreSQL TEXT cannot store (NUL)
    // slipped past input normalization. It is an invalid value (422), never a
    // database outage (503 FIN_DATABASE_UNAVAILABLE).
    return savingsGoalInvalid('A savings goal value contains a character that cannot be stored.');
  }
  return databaseUnavailable(error);
}

function databaseUnavailable(cause: unknown): FinancialError {
  return new FinancialError({
    code: 'FIN_DATABASE_UNAVAILABLE',
    statusCode: 503,
    safeMessage: 'Financial data is temporarily unavailable.',
    retryAfterSeconds: 1,
    cause,
  });
}

function sqlstateOf(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

class CommitOutcomeUnknown extends Error {
  constructor(cause: unknown) {
    super('Savings goal commit outcome unknown.', { cause });
    this.name = 'CommitOutcomeUnknown';
  }
}
