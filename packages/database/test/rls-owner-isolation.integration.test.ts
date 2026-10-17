import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FinancialAccountBootstrapService,
  PostgresAuthRepository,
  PostgresFinancialRepository,
  PostgresInvitationRepository,
  PostgresUserRepository,
  assertApplicationDatabaseRole,
  assertOperatorDatabaseRole,
  migrateDatabase,
  withUserContext,
  type AuthAccessPolicy,
} from '../src/index.js';

/**
 * SPEC-SEC-01 phase 2: Row Level Security under the real application role.
 *
 * Every assertion below executes as `kfin_app` against a schema produced by the
 * shipped migrations; the owner connection is used only to inspect catalog state
 * and to prove that the owner path still sees both tenants. Nothing here is
 * skipped silently in CI: the integration job fails when this file has no
 * database.
 *
 * SECURITY NOTE: `kfin.user_id` is set by the application role in its own
 * transaction. RLS is a guardrail against application bugs that omit an owner
 * predicate; it is NOT a defence against arbitrary SQL executed as `kfin_app`,
 * because such an attacker can set the same setting. This suite proves the
 * former, not the latter.
 */

const RETENTION_MS = 86_400_000;
const PREVIEW_SIGNING_KEY = 'ef'.repeat(32);
const AUTH_SECRET = 'ef'.repeat(32);
const TIMEZONE = 'Asia/Ho_Chi_Minh';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a different correct horse';

const integrationEnabled = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.TEST_APP_DATABASE_URL
  && process.env.TEST_MIGRATION_DATABASE_URL
  && process.env.TEST_OPERATOR_DATABASE_URL
  && process.env.KFIN_INTEGRATION_TARGET === 'non-production',
);

const integration = describe.skipIf(!integrationEnabled);

const AUTH_POLICY: AuthAccessPolicy = {
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
    hourlyIssuanceCap: 3,
    dailyIssuanceCap: 6,
    verifyCumulativeMaximum: 10,
    verifyCumulativeWindowMs: 60 * 60 * 1_000,
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
    resetMaximumRequests: 10,
    registrationMaximumPerWindow: 20,
    retentionWindows: 8,
  },
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the RLS integration test.`);
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const RLS_ENABLED_TABLES = [
  'audit_events', 'auth_challenges', 'balance_snapshots', 'beta_invitations',
  'categories', 'financial_accounts', 'idempotency_results', 'password_credentials',
  'savings_amount_changes', 'savings_goals', 'scheduled_items',
  'scheduled_occurrences', 'security_events', 'session_tokens', 'sessions',
  'transactions', 'users',
];

interface Tenant {
  readonly userId: string;
  readonly email: string;
  readonly accountId: string;
  readonly snapshotId: string;
  readonly transactionId: string;
}

integration('row level security under kfin_app', () => {
  let administration: Pool;
  let migration: Pool;
  let app: Pool;
  let operator: Pool;
  let schema: string;
  let tenantA: Tenant;
  let tenantB: Tenant;

  async function createTenant(label: string): Promise<Tenant> {
    const users = new PostgresUserRepository(app);
    const email = `${label}-${randomUUID()}@example.invalid`;
    const user = await users.create({
      email,
      locale: 'en-VN',
      timezone: TIMEZONE,
      baseCurrency: 'VND',
      emailVerifiedAt: new Date(Date.now() - 60_000),
    });
    const opened = await new FinancialAccountBootstrapService(app).bootstrap({
      ownerUserId: user.id,
      openingAmountMinor: '1000000',
      effectiveAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000),
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      idempotencyRetentionMs: RETENTION_MS,
    });
    const financial = new PostgresFinancialRepository(app, RETENTION_MS, PREVIEW_SIGNING_KEY);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const expense = await financial.createTransaction(user.id, {
      kind: 'expense',
      amountMinor: '250000',
      occurredOn: today,
      categoryCode: 'food',
      expenseClass: 'daily',
      isUnexpected: false,
      expectedFinancialStateVersion: '1',
      reviewedLatestSnapshotId: opened.snapshotId,
    }, randomUUID(), randomUUID());
    const rows = await administration.query<{ id: string }>(
      `SELECT id FROM ${quoteIdentifier(schema)}.transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    );
    return {
      userId: user.id,
      email,
      accountId: opened.accountId,
      snapshotId: opened.snapshotId,
      transactionId: rows.rows[0]?.id ?? expense.transactionId,
    };
  }

  function invitedRepository(): PostgresInvitationRepository {
    return new PostgresInvitationRepository(operator, {
      secret: AUTH_SECRET,
      policy: {
        codeEntropyBytes: AUTH_POLICY.invitation.codeEntropyBytes,
        codeGroupLength: AUTH_POLICY.invitation.codeGroupLength,
        defaultLifetimeMs: AUTH_POLICY.invitation.defaultLifetimeMs,
      },
    });
  }

  beforeAll(async () => {
    const adminUrl = requireEnv('TEST_DATABASE_URL');
    const migrationUrl = requireEnv('TEST_MIGRATION_DATABASE_URL');
    schema = `kfin_rls_${randomUUID().replaceAll('-', '')}`;
    administration = new Pool({ connectionString: adminUrl, max: 1 });
    await administration.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await administration.query(`REVOKE ALL ON SCHEMA ${quoteIdentifier(schema)} FROM PUBLIC`);
    await administration.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO kfin_app, kfin_operator`);
    await administration.query(`GRANT CREATE, USAGE ON SCHEMA ${quoteIdentifier(schema)} TO kfin_migrator`);

    migration = new Pool({
      connectionString: migrationUrl,
      max: 1,
      options: `-c search_path=${schema},public`,
    });
    await migrateDatabase(migration);

    app = new Pool({
      connectionString: requireEnv('TEST_APP_DATABASE_URL'),
      max: 6,
      options: `-c search_path=${schema},public`,
    });
    operator = new Pool({
      connectionString: requireEnv('TEST_OPERATOR_DATABASE_URL'),
      max: 2,
      options: `-c search_path=${schema},public`,
    });

    tenantA = await createTenant('rls-a');
    tenantB = await createTenant('rls-b');
  }, 120_000);

  afterAll(async () => {
    await operator?.end().catch(() => undefined);
    await app?.end().catch(() => undefined);
    await migration?.end().catch(() => undefined);
    if (administration && schema) {
      await administration.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined);
      await administration.end().catch(() => undefined);
    }
  }, 60_000);

  describe('deployment shape', () => {
    it('enables RLS on every tenant table and leaves only the global counters outside', async () => {
      const rows = (await administration.query<{ relname: string; rls: boolean; forced: boolean }>(`
        SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1::text AND c.relkind = 'r'
      `, [schema])).rows;
      const byName = new Map(rows.map((row) => [row.relname, row]));
      for (const table of RLS_ENABLED_TABLES) {
        expect(byName.get(table)?.rls, `${table}: RLS`).toBe(true);
      }
      expect(byName.get('auth_attempt_counters')?.rls).toBe(false);
      for (const row of rows.filter((entry) => entry.relname !== 'kfin_migrations')) {
        expect(row.forced, `${row.relname}: FORCE is intentionally off so the owner role can migrate`).toBe(false);
      }
    });

    it('pins every SECURITY DEFINER function to a safe search_path and grants only kfin_app', async () => {
      const names = [
        'kfin_account_lookup', 'kfin_token_lookup', 'kfin_reset_challenge_lookup',
        'kfin_invitation_lookup', 'kfin_consume_invitation',
      ];
      const rows = (await administration.query<{
        proname: string; owner: string; secdef: boolean; config: string[] | null;
        acl: string | null; public_execute: boolean; app_execute: boolean;
      }>(`
        SELECT p.proname,
               pg_get_userbyid(p.proowner) AS owner,
               p.prosecdef AS secdef,
               p.proconfig AS config,
               p.proacl::text AS acl,
               EXISTS (
                 SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
               ) AS public_execute,
               has_function_privilege('kfin_app', p.oid, 'EXECUTE') AS app_execute
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1::text AND p.proname = ANY($2::text[])
      `, [schema, names])).rows;
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.secdef, `${row.proname}: SECURITY DEFINER`).toBe(true);
        expect(row.owner, `${row.proname}: owned by the migration role`).toBe('kfin_migrator');
        expect(row.config ?? [], `${row.proname}: pinned search_path`)
          .toContain(`search_path=pg_catalog, ${schema}`);
        expect(row.public_execute, `${row.proname}: PUBLIC EXECUTE`).toBe(false);
        expect(row.app_execute, `${row.proname}: kfin_app EXECUTE`).toBe(true);
      }
    });

    it('keeps the balance view security_invoker', async () => {
      const options = (await administration.query<{ reloptions: string[] | null }>(`
        SELECT reloptions FROM pg_class
         WHERE relnamespace = $1::regnamespace AND relname = 'financial_current_balances'
      `, [schema])).rows[0]?.reloptions ?? [];
      expect(options).toContain('security_invoker=true');
    });
  });

  describe('fail-closed context', () => {
    it('returns no tenant rows when no context is set', async () => {
      for (const table of ['users', 'financial_accounts', 'transactions', 'sessions']) {
        const result = await app.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
        );
        expect(result.rows[0]!.count, `${table}: rows without context`).toBe('0');
      }
      // No table privilege at all: the API role cannot even ask for invitations.
      await expect(app.query(`SELECT count(*) FROM ${quoteIdentifier(schema)}.beta_invitations`))
        .rejects.toMatchObject({ code: '42501' });
    });

    it('rejects inserts that have no owner context', async () => {
      const email = `no-context-${randomUUID()}@example.invalid`;
      await expect(withUserContext(app, null, (client) => client.query(
        `INSERT INTO ${quoteIdentifier(schema)}.users
           (id, email, email_normalized, locale, timezone, base_currency, status, email_verification_state)
         VALUES ($1, $2, $3, 'en-VN', 'Asia/Ho_Chi_Minh', 'VND', 'active', 'unverified')`,
        [randomUUID(), email, email],
      ))).rejects.toMatchObject({ code: '42501' });

      await expect(withUserContext(app, null, (client) => client.query(
        `INSERT INTO ${quoteIdentifier(schema)}.financial_accounts (id, user_id, name, currency)
         VALUES ($1, $2, 'Probe', 'VND')`,
        [randomUUID(), tenantA.userId],
      ))).rejects.toMatchObject({ code: '42501' });
    });

    it('treats an unknown or malformed context as no context', async () => {
      const stranger = randomUUID();
      const rows = await withUserContext(app, stranger, (client) => client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quoteIdentifier(schema)}.users`,
      ));
      expect(rows.rows[0]!.count).toBe('0');

      const malformed = await withUserContext(app, 'not-a-uuid' as unknown as string, (client) => client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quoteIdentifier(schema)}.users`,
      )).catch((error: unknown) => error);
      expect(malformed).toMatchObject({ name: 'DatabaseRoleError' });

      // A caller that sets the raw setting to a non-UUID gets NULL from the
      // policy helper, never a match.
      const raw = await withUserContext(app, null, async (client) => {
        await client.query("SELECT set_config('kfin.user_id', 'not-a-uuid', true)");
        return client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${quoteIdentifier(schema)}.transactions`,
        );
      });
      expect(raw.rows[0]!.count).toBe('0');
    });
  });

  describe('cross-owner isolation as kfin_app', () => {
    it('shows each user exactly one tenant when both exist', async () => {
      const forA = await withUserContext(app, tenantA.userId, (client) => client.query<{ id: string }>(
        `SELECT id FROM ${quoteIdentifier(schema)}.users ORDER BY id`,
      ));
      expect(forA.rows.map((row) => row.id)).toEqual([tenantA.userId]);

      const accounts = await withUserContext(app, tenantA.userId, (client) => client.query<{ user_id: string }>(
        `SELECT user_id FROM ${quoteIdentifier(schema)}.financial_accounts`,
      ));
      expect(accounts.rows).toEqual([{ user_id: tenantA.userId }]);
    });

    it('cannot read or modify another owner by direct SQL', async () => {
      const seen = await withUserContext(app, tenantA.userId, (client) => client.query(
        `SELECT id FROM ${quoteIdentifier(schema)}.users WHERE id = $1`, [tenantB.userId],
      ));
      expect(seen.rowCount).toBe(0);

      const transactions = await withUserContext(app, tenantA.userId, (client) => client.query(
        `SELECT id FROM ${quoteIdentifier(schema)}.transactions WHERE user_id = $1`, [tenantB.userId],
      ));
      expect(transactions.rowCount).toBe(0);

      const updated = await withUserContext(app, tenantA.userId, (client) => client.query(
        `UPDATE ${quoteIdentifier(schema)}.financial_accounts SET name = name WHERE user_id = $1`, [tenantB.userId],
      ));
      expect(updated.rowCount).toBe(0);

      // Reassigning an account to another owner is refused by the guard trigger
      // before RLS, or by the WITH CHECK when the guard is bypassed.
      await expect(withUserContext(app, tenantA.userId, (client) => client.query(
        `UPDATE ${quoteIdentifier(schema)}.financial_accounts SET user_id = $1 WHERE user_id = $2`,
        [tenantB.userId, tenantA.userId],
      ))).rejects.toBeTruthy();

      // Writing an event for another owner is refused by the INSERT policy.
      await expect(withUserContext(app, tenantA.userId, (client) => client.query(
        `INSERT INTO ${quoteIdentifier(schema)}.security_events
           (id, user_id, event_type, outcome, visibility, correlation_id)
         VALUES ($1, $2, 'login_failed', 'failure', 'operator', $3)`,
        [randomUUID(), tenantB.userId, randomUUID()],
      ))).rejects.toMatchObject({ code: '42501' });

      await expect(withUserContext(app, tenantA.userId, (client) => client.query(
        `DELETE FROM ${quoteIdentifier(schema)}.transactions`,
      ))).rejects.toMatchObject({ code: '42501' });
    });

    it('never leaks through the repository when the wrong owner id is resolved', async () => {
      const financial = new PostgresFinancialRepository(app, RETENTION_MS, PREVIEW_SIGNING_KEY);
      await expect(financial.getTransaction(tenantA.userId, tenantB.transactionId))
        .rejects.toMatchObject({ code: 'FINANCIAL_RESOURCE_UNAVAILABLE' });
      const auth = new PostgresAuthRepository(app, { secret: AUTH_SECRET, policy: AUTH_POLICY });
      expect(await auth.getProfile(tenantA.userId)).toMatchObject({ userId: tenantA.userId });
      expect(await auth.getProfile(randomUUID())).toBeNull();
      const sessions = await auth.listSessions(tenantA.userId, { limit: 10 });
      expect(sessions.items).toEqual([]);
    });

    it('does not leak one request into the next on a reused connection', async () => {
      const single = new Pool({
        connectionString: requireEnv('TEST_APP_DATABASE_URL'),
        max: 1,
        options: `-c search_path=${schema},public`,
      });
      try {
        const first = await withUserContext(single, tenantA.userId, async (client) => {
          const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
          const ids = (await client.query<{ id: string }>(`SELECT id FROM ${quoteIdentifier(schema)}.users`)).rows;
          return { pid, ids: ids.map((row) => row.id) };
        });
        const between = await single.query<{ value: string | null }>(
          "SELECT NULLIF(current_setting('kfin.user_id', true), '') AS value",
        );
        expect(between.rows[0]!.value).toBeNull();

        const second = await withUserContext(single, tenantB.userId, async (client) => {
          const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
          const ids = (await client.query<{ id: string }>(`SELECT id FROM ${quoteIdentifier(schema)}.users`)).rows;
          return { pid, ids: ids.map((row) => row.id) };
        });
        expect(second.pid).toBe(first.pid);
        expect(first.ids).toEqual([tenantA.userId]);
        expect(second.ids).toEqual([tenantB.userId]);
      } finally {
        await single.end();
      }
    });

    it('scopes the balance view to the caller', async () => {
      const forA = await withUserContext(app, tenantA.userId, (client) => client.query<{
        user_id: string; current_balance_minor: string;
      }>(`SELECT user_id, current_balance_minor::text FROM ${quoteIdentifier(schema)}.financial_current_balances`));
      expect(forA.rowCount).toBe(1);
      expect(forA.rows[0]!.user_id).toBe(tenantA.userId);
      expect(forA.rows[0]!.current_balance_minor).toBe('750000');

      const none = await app.query(`SELECT * FROM ${quoteIdentifier(schema)}.financial_current_balances`);
      expect(none.rowCount).toBe(0);
    });

    it('keeps audit events insert-only and invisible to the application role', async () => {
      await expect(app.query(`SELECT count(*) FROM ${quoteIdentifier(schema)}.audit_events`))
        .rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`UPDATE ${quoteIdentifier(schema)}.audit_events SET outcome = outcome`))
        .rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`DELETE FROM ${quoteIdentifier(schema)}.audit_events`))
        .rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('authentication flows', () => {
    it('registers, signs in, authenticates and resets a password through the definer functions', async () => {
      const email = `rls-auth-${randomUUID()}@example.invalid`;
      const invitation = await invitedRepository().issueInvitation({
        invitedEmail: email,
        createdByOperatorId: randomUUID(),
        correlationId: randomUUID(),
      });
      const auth = new PostgresAuthRepository(app, { secret: AUTH_SECRET, policy: AUTH_POLICY });

      const registered = await auth.register({
        email,
        password: PASSWORD,
        invitationCode: invitation.code,
        locale: 'en-VN',
        timezone: TIMEZONE,
        baseCurrency: 'VND',
        correlationId: randomUUID(),
        ipAddress: '198.51.100.21',
        userAgent: 'RLS integration test',
      });
      expect(registered.userId).toBeTruthy();

      const login = await auth.login({
        email,
        password: PASSWORD,
        correlationId: randomUUID(),
        ipAddress: '198.51.100.22',
        userAgent: 'RLS integration test',
      });
      const principal = await auth.authenticate(login.session.sessionToken);
      expect(principal?.userId).toBe(registered.userId);

      const reset = await auth.requestPasswordReset({
        email,
        correlationId: randomUUID(),
        ipAddress: '198.51.100.23',
        userAgent: 'RLS integration test',
      });
      expect(reset.delivery?.oneTimeCode).toBeTruthy();
      await auth.resetPassword({
        email,
        oneTimeCode: reset.delivery!.oneTimeCode,
        newPassword: NEW_PASSWORD,
        correlationId: randomUUID(),
        ipAddress: '198.51.100.24',
        userAgent: 'RLS integration test',
      });
      // Every session for the account is revoked by the reset.
      expect(await auth.authenticate(login.session.sessionToken)).toBeNull();

      const relogin = await auth.login({
        email,
        password: NEW_PASSWORD,
        correlationId: randomUUID(),
        ipAddress: '198.51.100.25',
        userAgent: 'RLS integration test',
      });
      expect(relogin.userId).toBe(registered.userId);
    });

    it('consumes an invitation exactly once, also under a concurrent replay', async () => {
      const first = `rls-replay-${randomUUID()}@example.invalid`;
      const second = `rls-replay-${randomUUID()}@example.invalid`;
      const invitation = await invitedRepository().issueInvitation({
        createdByOperatorId: randomUUID(),
        correlationId: randomUUID(),
      });
      const auth = new PostgresAuthRepository(app, { secret: AUTH_SECRET, policy: AUTH_POLICY });
      const attempt = (email: string) => auth.register({
        email,
        password: PASSWORD,
        invitationCode: invitation.code,
        locale: 'en-VN',
        timezone: TIMEZONE,
        baseCurrency: 'VND',
        correlationId: randomUUID(),
        ipAddress: '198.51.100.31',
        userAgent: 'RLS integration test',
      });

      const results = await Promise.allSettled([attempt(first), attempt(second)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({ reason: { code: 'AUTH_INVITATION_INVALID' } });

      const stored = await administration.query<{ status: string; consumed_by_user_id: string | null }>(
        `SELECT status, consumed_by_user_id FROM ${quoteIdentifier(schema)}.beta_invitations WHERE id = $1`,
        [invitation.invitationId],
      );
      expect(stored.rows[0]).toMatchObject({ status: 'consumed' });
      expect(stored.rows[0]!.consumed_by_user_id).toBeTruthy();

      // The API role can neither read the invitation nor mint another one.
      await expect(app.query(`SELECT * FROM ${quoteIdentifier(schema)}.beta_invitations`))
        .rejects.toMatchObject({ code: '42501' });
      await expect(app.query(
        `INSERT INTO ${quoteIdentifier(schema)}.beta_invitations (id, code_digest, expires_at, created_by_operator_id)
         VALUES ($1, $2, now() + interval '1 day', $3)`,
        [randomUUID(), Buffer.alloc(32), randomUUID()],
      )).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('operator and background paths', () => {
    it('keeps the operator role to INSERT on invitations', async () => {
      const issued = await invitedRepository().issueInvitation({
        createdByOperatorId: randomUUID(),
        correlationId: randomUUID(),
      });
      const stored = await administration.query<{ status: string }>(
        `SELECT status FROM ${quoteIdentifier(schema)}.beta_invitations WHERE id = $1`,
        [issued.invitationId],
      );
      expect(stored.rows[0]!.status).toBe('active');

      await expect(operator.query(`SELECT 1 FROM ${quoteIdentifier(schema)}.beta_invitations LIMIT 1`))
        .rejects.toMatchObject({ code: '42501' });
      await expect(operator.query(`UPDATE ${quoteIdentifier(schema)}.beta_invitations SET status = status`))
        .rejects.toMatchObject({ code: '42501' });
      await expect(operator.query(`DELETE FROM ${quoteIdentifier(schema)}.beta_invitations`))
        .rejects.toMatchObject({ code: '42501' });
    });

    it('lets the operator CLI mint one invitation without the API role', async () => {
      const before = (await administration.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quoteIdentifier(schema)}.beta_invitations`,
      )).rows[0]!.count;
      const url = new URL(requireEnv('TEST_OPERATOR_DATABASE_URL'));
      url.searchParams.set('options', `-c search_path=${schema},public`);
      try {
        execFileSync('./node_modules/.bin/tsx', [
          'apps/api/tools/provision-invitation.ts',
          '--operator', randomUUID(),
        ], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPERATOR_DATABASE_URL: url.toString(),
            AUTH_SECRET,
            DATABASE_SSL_MODE: 'disable',
          },
          stdio: 'pipe',
        });
      } catch (error) {
        const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8').slice(0, 300) ?? '';
        // Never echo stdout: on a partial failure it can contain the plaintext code.
        throw new Error(`operator CLI failed: ${stderr}`);
      }
      const after = (await administration.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quoteIdentifier(schema)}.beta_invitations`,
      )).rows[0]!.count;
      expect(Number(after)).toBe(Number(before) + 1);
    });

    it('refuses to run the CLI or the API as the wrong role', async () => {
      await expect(assertApplicationDatabaseRole(administration)).rejects.toThrow(/Refusing to start/);
      await expect(assertApplicationDatabaseRole(migration)).rejects.toThrow(/Refusing to start/);
      await expect(assertOperatorDatabaseRole(app)).rejects.toThrow(/Refusing to run/);
      await expect(assertOperatorDatabaseRole(operator)).resolves.toBeUndefined();
    });

    it('keeps brute-force counters usable without a user context', async () => {
      const auth = new PostgresAuthRepository(app, { secret: AUTH_SECRET, policy: AUTH_POLICY });
      // Unknown-account logins write to auth_attempt_counters before any identity exists.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(auth.login({
          email: `missing-${randomUUID()}@example.invalid`,
          password: PASSWORD,
          correlationId: randomUUID(),
          ipAddress: '198.51.100.41',
          userAgent: 'RLS integration test',
        })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
      }
      await expect(auth.pruneAbuseCounters()).resolves.toBeGreaterThanOrEqual(0);
    });

    it('keeps the migration role able to see every tenant and the API unable to read migration state', async () => {
      const all = await migration.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quoteIdentifier(schema)}.users`,
      );
      expect(Number(all.rows[0]!.count)).toBeGreaterThanOrEqual(4);
      await expect(app.query(`SELECT * FROM ${quoteIdentifier(schema)}.kfin_migrations`))
        .rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`TRUNCATE ${quoteIdentifier(schema)}.transactions`))
        .rejects.toMatchObject({ code: '42501' });
    });
  });
});
