import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  FinancialError,
  isIanaTimezone,
  localDateAt,
  parseSignedMinor,
  validationError,
} from '@kfin/domain';
import { digestCanonicalRequest, digestSecret } from './canonical.js';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateUserInput {
  readonly email: string;
  readonly displayName?: string;
  readonly locale: string;
  readonly timezone: string;
  readonly baseCurrency: string;
  readonly emailVerifiedAt?: Date;
}

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly locale: string;
  readonly timezone: string;
  readonly baseCurrency: string;
  readonly status: 'pending_verification' | 'active';
}

export class PostgresUserRepository {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: CreateUserInput): Promise<UserRecord> {
    const email = input.email.trim();
    const emailNormalized = email.toLocaleLowerCase('en-US');
    if (!EMAIL_PATTERN.test(emailNormalized) || email.length > 320) {
      throw validationError('Email address is invalid.');
    }
    if (!isIanaTimezone(input.timezone)) throw validationError('Timezone is invalid.');
    if (!isLocale(input.locale)) throw validationError('Locale is invalid.');
    if (!CURRENCY_PATTERN.test(input.baseCurrency) || !isIsoCurrency(input.baseCurrency)) {
      throw validationError('Base currency is invalid.');
    }
    if (input.emailVerifiedAt && (
      Number.isNaN(input.emailVerifiedAt.getTime())
      || input.emailVerifiedAt.getTime() > this.now()
    )) throw validationError('Email verification time is invalid.');
    if (input.displayName !== undefined && (input.displayName.trim().length < 1 || input.displayName.length > 120)) {
      throw validationError('Display name is invalid.');
    }

    const id = randomUUID();
    const status = input.emailVerifiedAt ? 'active' : 'pending_verification';
    try {
      await this.pool.query(`
        INSERT INTO users (
          id, email, email_normalized, email_verified_at, display_name,
          locale, timezone, base_currency, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        id,
        email,
        emailNormalized,
        input.emailVerifiedAt ?? null,
        input.displayName?.trim() ?? null,
        input.locale,
        input.timezone,
        input.baseCurrency,
        status,
      ]);
    } catch (error) {
      if (sqlstateOf(error) === '23505') {
        throw new FinancialError({
          code: 'FINANCIAL_VALIDATION_FAILED',
          statusCode: 409,
          safeMessage: 'The user cannot be created with those details.',
          cause: error,
        });
      }
      throw error;
    }
    return { id, email, locale: input.locale, timezone: input.timezone, baseCurrency: input.baseCurrency, status };
  }
}

interface BootstrapResultRow extends QueryResultRow {
  request_digest: string;
  result: { accountId: string; snapshotId: string; financialStateVersion: string };
}

interface BootstrapUserRow extends QueryResultRow {
  id: string;
  timezone: string;
  base_currency: string;
}

export interface BootstrapFinancialAccountInput {
  readonly ownerUserId: string;
  readonly openingAmountMinor: string;
  readonly effectiveAt: Date;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly idempotencyRetentionMs: number;
}

export interface BootstrapFinancialAccountResult {
  readonly accountId: string;
  readonly snapshotId: string;
  readonly financialStateVersion: '1';
  readonly replayed: boolean;
}

interface BootstrapContext extends BootstrapFinancialAccountInput {
  readonly accountId: string;
  readonly snapshotId: string;
  readonly openingAmount: bigint;
  readonly keyDigest: string;
  readonly requestDigest: string;
}

export class FinancialAccountBootstrapService {
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly now: () => number = Date.now,
  ) {}

  async bootstrap(input: BootstrapFinancialAccountInput): Promise<BootstrapFinancialAccountResult> {
    const openingAmount = parseSignedMinor(input.openingAmountMinor);
    if (Number.isNaN(input.effectiveAt.getTime()) || input.effectiveAt.getTime() > this.now()) {
      throw validationError('Initial snapshot time must not be in the future.');
    }
    const context: BootstrapContext = {
      ...input,
      accountId: randomUUID(),
      snapshotId: randomUUID(),
      openingAmount,
      keyDigest: digestSecret(input.idempotencyKey),
      requestDigest: digestCanonicalRequest({
        openingAmountMinor: openingAmount,
        effectiveAt: input.effectiveAt.toISOString(),
      }),
    };

    try {
      return await this.attempt(context, false);
    } catch (error) {
      if (!(error instanceof BootstrapCommitUnknown)) throw error;
      try {
        return await this.attempt(context, true);
      } catch (recoveryError) {
        if (recoveryError instanceof FinancialError && (
          recoveryError.code === 'IDEMPOTENCY_KEY_REUSED'
          || recoveryError.code === 'FIN_ACCOUNT_ALREADY_EXISTS'
          || recoveryError.code === 'FINANCIAL_RESOURCE_UNAVAILABLE'
        )) throw recoveryError;
        throw new FinancialError({
          code: 'FINANCIAL_RESULT_UNKNOWN',
          statusCode: 503,
          safeMessage: 'The financial result is not yet known. Retry with the same idempotency key.',
          retryAfterSeconds: 1,
          cause: recoveryError,
        });
      }
    }
  }

  private async attempt(
    input: BootstrapContext,
    recovery: boolean,
  ): Promise<BootstrapFinancialAccountResult> {
    const deadline = this.now() + (recovery ? 2_000 : 8_000);
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw databaseUnavailable(error);
    }
    let released = false;
    let committed = false;
    let commitSent = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(`SET LOCAL lock_timeout = '${recovery ? 1_900 : 2_000}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${recovery ? 1_900 : 5_000}ms'`);
      const userResult = await client.query<BootstrapUserRow>(`
        SELECT id, timezone, base_currency
        FROM users
        WHERE id = $1 AND status = 'active' AND email_verified_at IS NOT NULL
        FOR UPDATE
      `, [input.ownerUserId]);
      const user = userResult.rows[0];
      if (!user) throw new FinancialError({
        code: 'FINANCIAL_RESOURCE_UNAVAILABLE',
        statusCode: 404,
        safeMessage: 'The requested financial resource is unavailable.',
      });

      const existingResult = await client.query<BootstrapResultRow>(`
        SELECT request_digest, result
        FROM idempotency_results
        WHERE user_id = $1 AND account_id IS NULL
          AND operation = 'financial.account.bootstrap' AND key_digest = $2
      `, [input.ownerUserId, input.keyDigest]);
      const existing = existingResult.rows[0];
      if (existing) {
        commitSent = true;
        await commitBefore(client, deadline, this.now);
        committed = true;
        if (existing.request_digest.trim() !== input.requestDigest) throw idempotencyReused();
        return { ...existing.result, financialStateVersion: '1', replayed: true };
      }

      const priorAccount = await client.query('SELECT id FROM financial_accounts WHERE user_id = $1', [input.ownerUserId]);
      if (priorAccount.rowCount) throw new FinancialError({
        code: 'FIN_ACCOUNT_ALREADY_EXISTS',
        statusCode: 409,
        safeMessage: 'The aggregate financial account already exists.',
      });

      const result = {
        accountId: input.accountId,
        snapshotId: input.snapshotId,
        financialStateVersion: '1' as const,
      };
      await client.query(`
        INSERT INTO financial_accounts (
          id, user_id, name, account_type, currency, financial_state_version
        ) VALUES ($1, $2, 'Aggregate liquid account', 'aggregate_liquid', $3, 1)
      `, [input.accountId, input.ownerUserId, user.base_currency]);
      await client.query(`
        INSERT INTO balance_snapshots (
          id, user_id, account_id, amount_minor, currency, effective_at,
          effective_local_date, timezone, reason, created_by_user_id, correlation_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'onboarding', $2, $9)
      `, [
        input.snapshotId,
        input.ownerUserId,
        input.accountId,
        input.openingAmount.toString(),
        user.base_currency,
        input.effectiveAt,
        localDateAt(input.effectiveAt, user.timezone),
        user.timezone,
        input.correlationId,
      ]);
      await client.query(`
        INSERT INTO idempotency_results (
          id, user_id, account_id, operation, key_digest, request_digest,
          prior_financial_state_version, committed_financial_state_version,
          response_status, result_code, result, correlation_id, expires_at
        ) VALUES ($1, $2, NULL, 'financial.account.bootstrap', $3, $4,
                  NULL, 1, 201, 'OK', $5::jsonb, $6,
                  clock_timestamp() + ($7::bigint * interval '1 millisecond'))
      `, [
        randomUUID(),
        input.ownerUserId,
        input.keyDigest,
        input.requestDigest,
        JSON.stringify(result),
        input.correlationId,
        input.idempotencyRetentionMs,
      ]);
      await client.query(`
        INSERT INTO audit_events (
          id, user_id, actor_user_id, action, resource_type, resource_id,
          outcome, correlation_id, metadata
        ) VALUES ($1, $2, $2, 'financial.account.bootstrap', 'financial_account',
                  $3, 'committed', $4, $5::jsonb)
      `, [
        randomUUID(),
        input.ownerUserId,
        input.accountId,
        input.correlationId,
        JSON.stringify({ snapshotId: input.snapshotId }),
      ]);
      commitSent = true;
      await commitBefore(client, deadline, this.now);
      committed = true;
      return { ...result, replayed: false };
    } catch (error) {
      if (committed) throw error;
      if (commitSent && sqlstateOf(error) === null) {
        client.release(true);
        released = true;
        throw new BootstrapCommitUnknown(error);
      }
      try {
        await client.query('ROLLBACK');
        client.release();
        released = true;
      } catch (rollbackError) {
        client.release(true);
        released = true;
        throw databaseUnavailable(new AggregateError([error, rollbackError]));
      }
      if (error instanceof FinancialError) throw error;
      throw databaseUnavailable(error);
    } finally {
      if (!released) client.release(committed ? undefined : true);
    }
  }
}

async function commitBefore(
  client: PoolClient,
  deadline: number,
  now: () => number,
): Promise<void> {
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error('Bootstrap database deadline exceeded.');
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.query('COMMIT'),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Bootstrap database deadline exceeded.')), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isLocale(value: string): boolean {
  try {
    new Intl.Locale(value);
    return value.length <= 35;
  } catch {
    return false;
  }
}

function isIsoCurrency(value: string): boolean {
  return Intl.supportedValuesOf('currency').includes(value);
}

function idempotencyReused(): FinancialError {
  return new FinancialError({
    code: 'IDEMPOTENCY_KEY_REUSED',
    statusCode: 409,
    safeMessage: 'The idempotency key was already used for a different request.',
  });
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

class BootstrapCommitUnknown extends Error {
  constructor(cause: unknown) {
    super('Bootstrap commit acknowledgement was not established.', { cause });
    this.name = 'BootstrapCommitUnknown';
  }
}
