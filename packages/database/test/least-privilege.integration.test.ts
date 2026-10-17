import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FinancialAccountBootstrapService,
  assertApplicationDatabaseRole,
  PostgresAuthRepository,
  PostgresFinancialRepository,
  PostgresInvitationRepository,
  PostgresSavingsGoalRepository,
  PostgresScheduleRepository,
  PostgresUserRepository,
  migrateDatabase,
  withUserContext,
  type AuthAccessPolicy,
} from '../src/index.js';

/**
 * SPEC-SEC-01 phase 1: the application role is not an owner and has exactly the
 * DML the runtime uses.
 *
 * Two scenarios pin both deployment paths:
 *
 *   1. fresh database — migrations run as `kfin_migrator`, which owns every
 *      object; `kfin_app` is granted only the allowlist from migration 0008.
 *   2. existing database — migrations run as the owner that already owns the
 *      schema (the platform `postgres` role here); migration 0008 applies the
 *      same allowlist without transferring ownership.
 *
 * The suite also drives real repositories (auth, financial, corrections,
 * schedule, savings) and the balance view through `kfin_app`, so a missing
 * grant is a failure rather than a code-reading assumption. It does not enable
 * or test RLS; that is phase 2.
 */

const RETENTION_MS = 86_400_000;
const PREVIEW_SIGNING_KEY = 'ef'.repeat(32);
const AUTH_SECRET = 'ef'.repeat(32);
const TIMEZONE = 'Asia/Ho_Chi_Minh';
const AGENT = 'Mozilla/5.0 (compatible; KFin least-privilege integration test)';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'another correct horse battery';

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

/**
 * The table/operation allowlist in 0008, derived from the SQL in
 * packages/database/src. A new table or a new operation must update both the
 * migration and this matrix, which is the review gate for future grants.
 */
const EXPECTED_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  users: ['SELECT', 'INSERT', 'UPDATE'],
  categories: ['SELECT'],
  financial_accounts: ['SELECT', 'INSERT', 'UPDATE'],
  balance_snapshots: ['SELECT', 'INSERT', 'UPDATE'],
  transactions: ['SELECT', 'INSERT', 'UPDATE'],
  idempotency_results: ['SELECT', 'INSERT'],
  audit_events: ['INSERT'],
  scheduled_items: ['SELECT', 'INSERT'],
  scheduled_occurrences: ['SELECT', 'INSERT', 'UPDATE'],
  savings_goals: ['SELECT', 'INSERT', 'UPDATE'],
  savings_amount_changes: ['SELECT', 'INSERT'],
  auth_attempt_counters: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  auth_challenges: ['SELECT', 'INSERT', 'UPDATE'],
  // SPEC-SEC-01 phase 2: the API role holds no invitation privilege at all.
  beta_invitations: [],
  password_credentials: ['SELECT', 'INSERT', 'UPDATE'],
  security_events: ['SELECT', 'INSERT'],
  sessions: ['SELECT', 'INSERT', 'UPDATE'],
  session_tokens: ['SELECT', 'INSERT', 'UPDATE'],
  kfin_migrations: [],
  financial_current_balances: ['SELECT'],
};

interface Scenario {
  readonly schema: string;
  readonly administration: Pool;
  readonly migration: Pool;
  readonly app: Pool;
  readonly operator: Pool;
}

interface MatrixRow {
  relname: string;
  sel: boolean;
  ins: boolean;
  upd: boolean;
  del: boolean;
  trunc: boolean;
  refs: boolean;
  trig: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the least-privilege integration test.`);
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function localToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const pick = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function localMonth(): string {
  return localToday().slice(0, 7);
}

function normalizeMatrix(matrix: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(matrix)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, privileges]) => [table, [...privileges].sort()]),
  );
}

async function setupScenario(mode: 'migrator' | 'owner'): Promise<Scenario> {
  const adminUrl = requireEnv('TEST_DATABASE_URL');
  const appUrl = requireEnv('TEST_APP_DATABASE_URL');
  const operatorUrl = requireEnv('TEST_OPERATOR_DATABASE_URL');
  const migrationUrl = mode === 'migrator' ? requireEnv('TEST_MIGRATION_DATABASE_URL') : adminUrl;
  const schema = `kfin_lp_${randomUUID().replaceAll('-', '')}`;
  const administration = new Pool({ connectionString: adminUrl, max: 1 });
  let migration: Pool | undefined;
  let app: Pool | undefined;
  let operator: Pool | undefined;
  try {
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
      connectionString: appUrl,
      max: 6,
      options: `-c search_path=${schema},public`,
    });
    operator = new Pool({
      connectionString: operatorUrl,
      max: 2,
      options: `-c search_path=${schema},public`,
    });
    return { schema, administration, migration, app, operator };
  } catch (error) {
    if (operator) await operator.end().catch(() => undefined);
    if (app) await app.end().catch(() => undefined);
    if (migration) await migration.end().catch(() => undefined);
    await administration.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined);
    await administration.end().catch(() => undefined);
    throw error;
  }
}

async function teardownScenario(scenario: Scenario | undefined): Promise<void> {
  if (!scenario) return;
  await scenario.operator.end().catch(() => undefined);
  await scenario.app.end().catch(() => undefined);
  await scenario.migration.end().catch(() => undefined);
  await scenario.administration
    .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(scenario.schema)} CASCADE`)
    .catch(() => undefined);
  await scenario.administration.end().catch(() => undefined);
}

async function createOwner(app: Pool, label: string): Promise<{
  readonly userId: string;
  readonly snapshotId: string;
  readonly version: string;
  readonly financial: PostgresFinancialRepository;
  readonly schedule: PostgresScheduleRepository;
}> {
  const users = new PostgresUserRepository(app);
  const user = await users.create({
    email: `${label}-${randomUUID()}@example.invalid`,
    locale: 'en-VN',
    timezone: TIMEZONE,
    baseCurrency: 'VND',
    emailVerifiedAt: new Date(Date.now() - 60_000),
  });
  const foundation = await new FinancialAccountBootstrapService(app).bootstrap({
    ownerUserId: user.id,
    openingAmountMinor: '1000000',
    effectiveAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000),
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
    idempotencyRetentionMs: RETENTION_MS,
  });
  return {
    userId: user.id,
    snapshotId: foundation.snapshotId,
    version: foundation.financialStateVersion,
    financial: new PostgresFinancialRepository(app, RETENTION_MS, PREVIEW_SIGNING_KEY),
    schedule: new PostgresScheduleRepository(app, RETENTION_MS),
  };
}

function leastPrivilegeSuite(label: string, mode: 'migrator' | 'owner'): void {
  integration(`least privilege (${label})`, () => {
    let scenario: Scenario | undefined;

    const current = (): Scenario => {
      if (!scenario) throw new Error('scenario is not ready');
      return scenario;
    };

    beforeAll(async () => {
      scenario = await setupScenario(mode);
    }, 60_000);

    afterAll(async () => {
      await teardownScenario(scenario);
    }, 30_000);

    it('connects as a non-owner, non-superuser application role', async () => {
      const s = current();
      const identity = (await s.app.query<{
        role: string;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
        rolcanlogin: boolean;
      }>(`
        SELECT current_user AS role, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
               r.rolbypassrls, r.rolinherit, r.rolcanlogin
          FROM pg_roles r
         WHERE r.rolname = current_user
      `)).rows[0]!;
      expect(identity).toEqual({
        role: 'kfin_app',
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
        rolinherit: false,
        rolcanlogin: true,
      });

      const schemaPrivileges = (await s.app.query<{ usage: boolean; create: boolean }>(`
        SELECT has_schema_privilege(current_user, $1::text, 'USAGE') AS usage,
               has_schema_privilege(current_user, $1::text, 'CREATE') AS create
      `, [s.schema])).rows[0]!;
      expect(schemaPrivileges).toEqual({ usage: true, create: false });

      const schemaOwner = (await s.administration.query<{ owned: boolean }>(`
        SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'kfin_app') AS owned
          FROM pg_namespace WHERE nspname = $1::text
      `, [s.schema])).rows[0]!;
      expect(schemaOwner.owned).toBe(false);

      const ownedRelations = (await s.administration.query<{ relname: string }>(`
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1::text
           AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'kfin_app')
      `, [s.schema])).rows;
      expect(ownedRelations).toEqual([]);

      const ownedFunctions = (await s.administration.query<{ proname: string }>(`
        SELECT p.proname
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1::text
           AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'kfin_app')
      `, [s.schema])).rows;
      expect(ownedFunctions).toEqual([]);

      const migrationRole = (await s.migration.query<{ role: string; rolsuper: boolean }>(`
        SELECT current_user AS role, r.rolsuper
          FROM pg_roles r WHERE r.rolname = current_user
      `)).rows[0]!;
      if (mode === 'migrator') {
        expect(migrationRole).toEqual({ role: 'kfin_migrator', rolsuper: false });
      }
      const migrationOwner = (await s.administration.query<{ owner: string }>(`
        SELECT pg_get_userbyid(c.relowner) AS owner
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1::text AND c.relname = 'kfin_migrations'
      `, [s.schema])).rows[0]!;
      expect(migrationOwner.owner).toBe(migrationRole.role);
    });

    it('grants exactly the runtime DML allowlist and nothing more', async () => {
      const s = current();
      const currentSchema = (await s.app.query<{ schema: string }>(
        'SELECT current_schema() AS schema',
      )).rows[0]!.schema;
      expect(currentSchema).toBe(s.schema);

      const rows = (await s.app.query<MatrixRow>(`
        SELECT c.relname,
               has_table_privilege(current_user, c.oid, 'SELECT') AS sel,
               has_table_privilege(current_user, c.oid, 'INSERT') AS ins,
               has_table_privilege(current_user, c.oid, 'UPDATE') AS upd,
               has_table_privilege(current_user, c.oid, 'DELETE') AS del,
               has_table_privilege(current_user, c.oid, 'TRUNCATE') AS trunc,
               has_table_privilege(current_user, c.oid, 'REFERENCES') AS refs,
               has_table_privilege(current_user, c.oid, 'TRIGGER') AS trig
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema()
           AND c.relkind IN ('r', 'p', 'v')
         ORDER BY c.relname
      `)).rows;

      const actual: Record<string, string[]> = {};
      for (const row of rows) {
        const privileges: string[] = [];
        if (row.sel) privileges.push('SELECT');
        if (row.ins) privileges.push('INSERT');
        if (row.upd) privileges.push('UPDATE');
        if (row.del) privileges.push('DELETE');
        actual[row.relname] = privileges;
      }
      expect(normalizeMatrix(actual)).toEqual(normalizeMatrix(EXPECTED_PRIVILEGES));

      for (const row of rows) {
        expect(row.trunc, `${row.relname}: TRUNCATE`).toBe(false);
        expect(row.refs, `${row.relname}: REFERENCES`).toBe(false);
        expect(row.trig, `${row.relname}: TRIGGER`).toBe(false);
      }
    });

    it('revokes PUBLIC EXECUTE from every KFin function', async () => {
      const s = current();
      const exposed = (await s.administration.query<{ proname: string }>(`
        SELECT p.proname
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1::text
           AND p.proname LIKE 'kfin\_%'
           AND (
             p.proacl IS NULL
             OR EXISTS (
               SELECT 1 FROM aclexplode(p.proacl) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             )
           )
      `, [s.schema])).rows;
      expect(exposed).toEqual([]);

      const notExecutable = (await s.administration.query<{ proname: string }>(`
        SELECT p.proname
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1::text
           AND p.proname LIKE 'kfin\_%'
           AND NOT has_function_privilege('kfin_app', p.oid, 'EXECUTE')
      `, [s.schema])).rows;
      expect(notExecutable).toEqual([]);
    });

    it('refuses to start as an owner or superuser connection', async () => {
      const s = current();
      await expect(assertApplicationDatabaseRole(s.administration)).rejects.toThrow(/Refusing to start/);
      await expect(assertApplicationDatabaseRole(s.app)).resolves.toBeUndefined();
    });

    it('cannot administer the schema, read migration state, or escalate', async () => {
      const s = current();
      const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
      const denied = async (sql: string): Promise<void> => {
        await expect(s.app.query(sql)).rejects.toMatchObject({ code: '42501' });
      };

      await denied(`CREATE TABLE ${quoteIdentifier(s.schema)}.kfin_probe_${suffix} (id integer)`);
      await denied(`CREATE SCHEMA kfin_probe_${suffix}`);
      await denied(`CREATE ROLE kfin_probe_${suffix}`);
      await denied(`ALTER TABLE ${quoteIdentifier(s.schema)}.transactions ADD COLUMN kfin_probe_${suffix} integer`);
      await denied(`DROP TABLE ${quoteIdentifier(s.schema)}.transactions`);
      await denied(`TRUNCATE ${quoteIdentifier(s.schema)}.transactions`);
      await denied('SET ROLE kfin_migrator');
      await denied(`SELECT count(*) FROM ${quoteIdentifier(s.schema)}.kfin_migrations`);

      const probe = (await s.administration.query<{ name: string | null }>(`
        SELECT to_regclass(format('%I.%I', $1::text, $2::text)) AS name
      `, [s.schema, `kfin_probe_${suffix}`])).rows[0]!;
      expect(probe.name).toBeNull();
    });

    it('runs the authentication flows through the application role', async () => {
      const s = current();
      const auth = new PostgresAuthRepository(s.app, { secret: AUTH_SECRET, policy: AUTH_POLICY });
      const email = `lp-auth-${randomUUID()}@example.invalid`;

      const invitations = new PostgresInvitationRepository(s.operator, {
        secret: AUTH_SECRET,
        policy: {
          codeEntropyBytes: AUTH_POLICY.invitation.codeEntropyBytes,
          codeGroupLength: AUTH_POLICY.invitation.codeGroupLength,
          defaultLifetimeMs: AUTH_POLICY.invitation.defaultLifetimeMs,
        },
      });
      const invitation = await invitations.issueInvitation({
        invitedEmail: email,
        createdByOperatorId: randomUUID(),
        correlationId: randomUUID(),
      });
      const registered = await auth.register({
        email,
        password: PASSWORD,
        invitationCode: invitation.code,
        locale: 'en-VN',
        timezone: TIMEZONE,
        baseCurrency: 'VND',
        correlationId: randomUUID(),
        ipAddress: '198.51.100.11',
        userAgent: AGENT,
      });
      expect(registered.userId).toBeTruthy();
      const userId = registered.userId!;

      const login = await auth.login({
        email,
        password: PASSWORD,
        correlationId: randomUUID(),
        ipAddress: '198.51.100.12',
        userAgent: AGENT,
      });
      expect(login.userId).toBe(userId);

      const principal = await auth.authenticate(login.session.sessionToken);
      expect(principal?.userId).toBe(userId);

      const sessions = await auth.listSessions(userId, {
        limit: 10,
        currentSessionId: login.session.session.id,
      });
      expect(sessions.items.length).toBeGreaterThan(0);

      const events = await auth.listSecurityEvents(userId, { limit: 10 });
      expect(Array.isArray(events.items)).toBe(true);

      const profile = await auth.getProfile(userId);
      expect(profile?.userId).toBe(userId);

      const reset = await auth.requestPasswordReset({
        email,
        correlationId: randomUUID(),
        ipAddress: '198.51.100.13',
        userAgent: AGENT,
      });
      expect(reset.accepted).toBe(true);

      await auth.pruneAbuseCounters();

      const changed = await auth.changePassword({
        userId,
        sessionId: login.session.session.id,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        correlationId: randomUUID(),
        ipAddress: '198.51.100.14',
        userAgent: AGENT,
      });
      expect(changed.session.sessionToken).toBeTruthy();

      await auth.logout(userId, changed.session.session.id, {
        correlationId: randomUUID(),
        ipAddress: '198.51.100.14',
        userAgent: AGENT,
      });
    }, 30_000);

    it('runs financial, correction, schedule and savings flows through the application role', async () => {
      const s = current();
      const owner = await createOwner(s.app, 'lp-financial');
      const savings = new PostgresSavingsGoalRepository(s.app, {
        idempotencyRetentionMs: RETENTION_MS,
      });
      let version = owner.version;

      const created = await owner.financial.createTransaction(owner.userId, {
        kind: 'expense',
        amountMinor: '300000',
        occurredOn: localToday(),
        categoryCode: 'food',
        expenseClass: 'daily',
        isUnexpected: false,
        expectedFinancialStateVersion: version,
        reviewedLatestSnapshotId: owner.snapshotId,
      }, randomUUID(), randomUUID());
      version = created.financialStateVersion;

      const transaction = await owner.financial.getTransaction(owner.userId, created.transactionId);
      expect(transaction.id).toBe(created.transactionId);
      const page = await owner.financial.listTransactions(owner.userId, { limit: 10 });
      expect(page.items.map((item) => item.id)).toContain(created.transactionId);

      const categories = await owner.financial.listCategories(owner.userId);
      expect(categories.items.length).toBeGreaterThan(0);

      const correction = {
        reason: 'Correct entered financial fact',
        replacement: {
          amountMinor: '250000',
          occurredOn: localToday(),
          categoryCode: 'food',
          expenseClass: 'daily' as const,
          isUnexpected: false,
        },
      };
      const preview = await owner.financial.previewTransactionCorrection(
        owner.userId,
        created.transactionId,
        correction,
      );
      const corrected = await owner.financial.correctTransaction(
        owner.userId,
        created.transactionId,
        { ...correction, context: preview.context },
        randomUUID(),
        randomUUID(),
      );
      version = corrected.financialStateVersion;
      expect(corrected.replacementTransactionId).not.toBeNull();

      const balanceAfterCorrection = await owner.financial.getCurrentBalance(owner.userId);
      expect(balanceAfterCorrection.currentBalanceMinor).toBe('750000');

      const oneOff = await owner.schedule.createOneOff(owner.userId, {
        title: 'Rent',
        kind: 'expense',
        expectedAmountMinor: '300000',
        dueOn: localToday(),
        categoryCode: 'rent',
        expenseClass: 'essential_fixed',
        expectedFinancialStateVersion: version,
        reviewedLatestSnapshotId: owner.snapshotId,
      }, randomUUID(), randomUUID());
      version = oneOff.financialStateVersion;

      const confirmed = await owner.schedule.confirmOccurrence(owner.userId, oneOff.occurrenceId, {
        amountMinor: '300000',
        occurredOn: localToday(),
        categoryCode: 'rent',
        expenseClass: 'essential_fixed',
        isUnexpected: false,
        expectedFinancialStateVersion: version,
        reviewedLatestSnapshotId: owner.snapshotId,
        reviewedOccurrenceVersion: '1',
      }, randomUUID(), randomUUID());
      version = confirmed.financialStateVersion;
      expect(confirmed.state).toBe('confirmed');

      const balanceAfterSchedule = await owner.financial.getCurrentBalance(owner.userId);
      expect(balanceAfterSchedule.currentBalanceMinor).toBe('450000');

      const actuals = await owner.financial.getMonthlyActuals(owner.userId, localMonth());
      expect(actuals.month).toBe(localMonth());

      const goal = await savings.createGoal(owner.userId, {
        name: 'Emergency fund',
        targetAmountMinor: '5000000',
        currentAmountMinor: '0',
        currentAmountAsOf: localToday(),
        plannedContributionMinor: '500000',
        contributionFrequency: 'monthly',
      }, randomUUID(), randomUUID());
      const goalView = await savings.getGoal(owner.userId, goal.goalId);
      expect(goalView.id).toBe(goal.goalId);
      const goals = await savings.listGoals(owner.userId, { status: 'all', limit: 10 });
      expect(goals.items.map((item) => item.id)).toContain(goal.goalId);
      const changes = await savings.listAmountChanges(owner.userId, goal.goalId, { limit: 10 });
      expect(changes.items.length).toBeGreaterThan(0);

      const view = await withUserContext(s.app, owner.userId, (client) => client.query<{ current_balance_minor: string }>(`
        SELECT current_balance_minor
          FROM ${quoteIdentifier(s.schema)}.financial_current_balances
         WHERE user_id = $1
      `, [owner.userId]));
      expect(view.rows[0]?.current_balance_minor).toBe('450000');
    }, 30_000);

    it('applies default privileges to future tables, sequences and functions', async () => {
      const s = current();
      const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
      const table = `kfin_probe_table_${suffix}`;
      const sequence = `kfin_probe_seq_${suffix}`;
      const fn = `kfin_probe_fn_${suffix}`;
      const qualifiedTable = `${quoteIdentifier(s.schema)}.${quoteIdentifier(table)}`;
      const qualifiedSequence = `${quoteIdentifier(s.schema)}.${quoteIdentifier(sequence)}`;
      const qualifiedFunction = `${quoteIdentifier(s.schema)}.${quoteIdentifier(fn)}`;

      await s.migration.query(`CREATE TABLE ${qualifiedTable} (id integer NOT NULL)`);
      await s.migration.query(`CREATE SEQUENCE ${qualifiedSequence}`);
      await s.migration.query(`CREATE FUNCTION ${qualifiedFunction}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);

      await s.app.query(`INSERT INTO ${qualifiedTable} (id) VALUES (1)`);
      await s.app.query(`UPDATE ${qualifiedTable} SET id = 2`);
      const rows = await s.app.query<{ id: number }>(`SELECT id FROM ${qualifiedTable}`);
      expect(rows.rows).toEqual([{ id: 2 }]);
      await expect(s.app.query(`DELETE FROM ${qualifiedTable}`)).rejects.toMatchObject({ code: '42501' });

      const next = await s.app.query<{ value: string }>(`SELECT nextval('${s.schema}.${sequence}') AS value`);
      expect(next.rows[0]?.value).toBe('1');
      const last = await s.app.query(`SELECT last_value FROM ${qualifiedSequence}`);
      expect(last.rows.length).toBe(1);

      const called = await s.app.query<{ value: number }>(`SELECT ${qualifiedFunction}() AS value`);
      expect(called.rows[0]?.value).toBe(1);
    });

    it('executes the balance view with the caller privileges', async () => {
      const s = current();
      const metadata = (await s.administration.query<{ reloptions: string[] | null }>(`
        SELECT c.reloptions
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1::text AND c.relname = 'financial_current_balances'
      `, [s.schema])).rows[0]!;
      expect(metadata.reloptions).toContain('security_invoker=true');

      const owner = await createOwner(s.app, 'lp-view');
      const view = await withUserContext(s.app, owner.userId, (client) => client.query<{ current_balance_minor: string }>(`
        SELECT current_balance_minor
          FROM ${quoteIdentifier(s.schema)}.financial_current_balances
         WHERE user_id = $1
      `, [owner.userId]));
      expect(view.rows[0]?.current_balance_minor).toBe('1000000');
    });
  });
}

leastPrivilegeSuite('fresh database, migrations as kfin_migrator', 'migrator');
leastPrivilegeSuite('existing database, migrations as the object owner', 'owner');
