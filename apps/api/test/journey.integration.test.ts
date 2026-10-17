import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authPolicy } from '@kfin/config';
import {
  PostgresAuthRepository,
  PostgresFinancialRepository,
  PostgresInvitationRepository,
  PostgresSavingsGoalRepository,
  PostgresScheduleRepository,
  migrateDatabase,
} from '@kfin/database';
import { buildApp } from '../src/app.js';
import { RecordingEmailAdapter } from '../src/email-delivery.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  readCookie,
  sessionCookieName,
} from '../src/session-transport.js';

/**
 * End-to-end journey over real HTTP semantics and real PostgreSQL.
 *
 * Every other API suite (`app.test.ts`, `financial-accounts.test.ts`,
 * `savings-goals.test.ts`, …) drives `buildApp` with in-memory fakes: they prove the
 * HTTP contract, and they cannot prove that the contract survives contact with the
 * database. The `packages/database` integration suites prove the opposite half —
 * repositories against real PostgreSQL, with no HTTP layer above them. Nothing in
 * the repository walks the whole stack, which is exactly what the MVP outcomes in
 * `docs/product/MVP-SCOPE.md` §3 are written about ("a user can …", "sign in with
 * the credentials just chosen", "current balance reconciles …").
 *
 * This suite closes that gap. It boots the **production wiring** — the same
 * `buildApp` call as `apps/api/src/server.ts`, the same shipped `authPolicy`, the
 * same repositories, the same cookie and CSRF transport — over a disposable
 * schema, and then walks the journeys a real beta user performs:
 *
 *   invitation → register → sign in → bootstrap account → post an expense →
 *   idempotent replay → correct it → void it → schedule → confirm →
 *   savings goal → monthly actuals → cross-user isolation → password change →
 *   password reset through the mailed OTP
 *
 * Each step asserts the HTTP answer **and** the persisted row, so a passing test
 * means "the database really contains this", not "a fake agreed with the handler".
 *
 * Safety: it runs only when the `TEST_*_DATABASE_URL` variables and
 * `KFIN_INTEGRATION_TARGET=non-production` are set, exactly like the
 * `packages/database` suites, and it confines itself to a schema it creates and
 * drops. Since SPEC-SEC-01 phase 2 the API side of the journey runs as
 * `kfin_app` under RLS; only the fixture/assertion connection keeps owner
 * rights. Nothing here is a mock, and nothing here is skipped silently in CI: the
 * `assert-integration-ran.mjs` guard fails the job if any case in this file skips.
 */

const integrationEnabled = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.TEST_APP_DATABASE_URL
  && process.env.TEST_OPERATOR_DATABASE_URL
  && process.env.KFIN_INTEGRATION_TARGET === 'non-production',
);

const journey = describe.skipIf(!integrationEnabled);

/** Same-origin pair: `isBrowserSafeRequest` accepts an Origin that matches the Host. */
const HOST = 'kfin.test';
const ORIGIN = `http://${HOST}`;

const AUTH_SECRET = 'ab'.repeat(32);
const PREVIEW_SIGNING_KEY = 'cd'.repeat(32);
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

/** VND, six figures of minor units — the shape a real beta user's account has. */
const OPENING_BALANCE_MINOR = '5000000';
const EXPENSE_MINOR = '250000';
const CORRECTED_EXPENSE_MINOR = '310000';
const VOID_EXPENSE_MINOR = '42000';
const SAVINGS_TARGET_MINOR = '2000000';
const SAVINGS_CURRENT_MINOR = '500000';

interface CookieJar {
  readonly values: Map<string, string>;
}

function jarFrom(cookies: readonly { name: string; value: string }[]): CookieJar {
  const values = new Map<string, string>();
  for (const cookie of cookies) values.set(cookie.name, cookie.value);
  return { values };
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.values.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

journey('a complete user journey over HTTP and real PostgreSQL', () => {
  let administration: Pool;
  let pool: Pool;
  let appPool: Pool;
  let operatorPool: Pool;
  let schema: string;
  let app: FastifyInstance;
  let authService: PostgresAuthRepository;
  let invitations: PostgresInvitationRepository;
  let email: RecordingEmailAdapter;

  const cookieName = sessionCookieName({ secure: false, prefixHost: authPolicy.session.cookiePrefixHost });

  /** Requests are same-origin browser requests unless a test says otherwise. */
  function browserHeaders(jar?: CookieJar, csrf?: string, idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = { host: HOST, origin: ORIGIN };
    if (jar) headers.cookie = cookieHeader(jar);
    if (csrf) headers[CSRF_HEADER_NAME] = csrf;
    // The idempotency key travels as a required request header, not a query parameter.
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return headers;
  }

  async function register(invitedEmail: string): Promise<{ userId: string; email: string; password: string }> {
    const issued = await invitations.issueInvitation({
      invitedEmail,
      createdByOperatorId: '00000000-0000-4000-8000-0000000000aa',
      correlationId: randomUUID(),
    });
    const password = 'journey-password-1';
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: browserHeaders(),
      payload: {
        email: invitedEmail,
        password,
        invitationCode: issued.code,
        locale: 'vi',
        timezone: 'Asia/Ho_Chi_Minh',
        baseCurrency: 'VND',
      },
    });
    expect(response.statusCode, `register answered ${response.body}`).toBe(202);
    const userId = (await pool.query<{ id: string }>(
      'SELECT id FROM users WHERE email_normalized = $1',
      [invitedEmail],
    )).rows[0]!.id;
    return { userId, email: invitedEmail, password };
  }

  async function signIn(email: string, password: string): Promise<{ jar: CookieJar; csrf: string; sessionId: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: browserHeaders(),
      payload: { email, password },
    });
    expect(response.statusCode, `login answered ${response.body}`).toBe(200);
    const body = response.json() as { session: { id: string }; csrfToken: string };
    const jar = jarFrom(response.cookies);
    expect(jar.values.get(cookieName), 'session cookie must be set').toBeTruthy();
    expect(jar.values.get(CSRF_COOKIE_NAME), 'csrf cookie must be set').toBeTruthy();
    expect(jar.values.get(cookieName)).toBe(readCookie(cookieHeader(jar), cookieName));
    return { jar, csrf: body.csrfToken, sessionId: body.session.id };
  }

  async function balance(jar: CookieJar, csrf?: string): Promise<{
    financialStateVersion: string;
    snapshot: { id: string; amountMinor: string };
    postedCurrentIncomeMinor: string;
    postedCurrentExpenseMinor: string;
    currentBalanceMinor: string;
  }> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/financial-account',
      headers: browserHeaders(jar, csrf),
    });
    expect(response.statusCode, `balance answered ${response.body}`).toBe(200);
    return response.json() as never;
  }

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await operatorPool?.end();
    await pool?.end();
    if (administration && schema) await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await administration?.end();
  });

  beforeAll(async () => {
    schema = `kfin_journey_${randomUUID().replaceAll('-', '')}`;
    administration = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await administration.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 6,
      options: `-c search_path=${schema},public`,
    });
    await migrateDatabase(pool);
    await administration.query(`GRANT USAGE ON SCHEMA ${schema} TO kfin_app, kfin_operator`);

    const transport = { secure: false, prefixHost: authPolicy.session.cookiePrefixHost };
    appPool = new Pool({
      connectionString: process.env.TEST_APP_DATABASE_URL,
      max: 6,
      options: `-c search_path=${schema},public`,
    });
    operatorPool = new Pool({
      connectionString: process.env.TEST_OPERATOR_DATABASE_URL,
      max: 2,
      options: `-c search_path=${schema},public`,
    });
    authService = new PostgresAuthRepository(appPool, { secret: AUTH_SECRET, policy: authPolicy });
    invitations = new PostgresInvitationRepository(operatorPool, {
      secret: AUTH_SECRET,
      policy: {
        codeEntropyBytes: authPolicy.invitation.codeEntropyBytes,
        codeGroupLength: authPolicy.invitation.codeGroupLength,
        defaultLifetimeMs: authPolicy.invitation.defaultLifetimeMs,
      },
    });
    email = new RecordingEmailAdapter();

    // The wiring below mirrors `apps/api/src/server.ts` line for line, minus the
    // environment loading and the network listener. If production wiring drifts,
    // this suite stops being evidence, so it is deliberately explicit.
    app = await buildApp({
      financialService: new PostgresFinancialRepository(appPool, IDEMPOTENCY_RETENTION_MS, PREVIEW_SIGNING_KEY),
      scheduleService: new PostgresScheduleRepository(appPool, IDEMPOTENCY_RETENTION_MS),
      savingsService: new PostgresSavingsGoalRepository(appPool, { idempotencyRetentionMs: IDEMPOTENCY_RETENTION_MS }),
      authService,
      emailDelivery: email,
      authTransport: transport,
      authAbsoluteLifetimeSeconds: Math.floor(authPolicy.session.absoluteLifetimeMs / 1_000),
      authenticate: async (request) => {
        const token = readCookie(request.headers.cookie, cookieName);
        if (!token) return null;
        return authService.authenticate(token);
      },
      readinessPool: appPool,
    });
    await app.ready();
  }, 60_000);

  // Shared across the ordered steps: the journeys build on each other the way a
  // real session does.
  const state: {
    primary?: { userId: string; email: string; password: string };
    session?: { jar: CookieJar; csrf: string; sessionId: string };
    transactionId?: string;
    voidedTransactionId?: string;
    occurrenceId?: string;
    goalId?: string;
  } = {};

  it('1. admits an invited person and creates a usable, unverified account with no session and no mail', async () => {
    const invited = `journey-primary-${randomUUID()}@example.invalid`;
    state.primary = await register(invited);

    const row = (await pool.query<{
      status: string; email_verification_state: string; email_verified_at: Date | null; version: string;
    }>('SELECT status, email_verification_state, email_verified_at, version FROM users WHERE id = $1', [state.primary.userId])).rows[0]!;
    expect(row.status).toBe('active');
    expect(row.email_verification_state).toBe('unverified');
    expect(row.email_verified_at).toBeNull();

    const sessions = await pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [state.primary.userId]);
    expect(sessions.rowCount).toBe(0);
    const challenges = await pool.query('SELECT 1 FROM auth_challenges WHERE target_digest IS NOT NULL');
    expect(challenges.rowCount, 'registration issues no challenge at all (OQ-20)').toBe(0);
    expect(email.messages.filter((message) => message.to === invited)).toHaveLength(0);
  });

  it('2. signs that person in and resolves the session from the cookie only', async () => {
    state.session = await signIn(state.primary!.email, state.primary!.password);
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: browserHeaders(state.session.jar),
    });
    expect(me.statusCode, me.body).toBe(200);
    const profile = me.json() as { userId: string; emailVerifiedAt: string | null; baseCurrency: string };
    expect(profile.userId).toBe(state.primary!.userId);
    expect(profile.emailVerifiedAt).toBeNull();
    expect(profile.baseCurrency).toBe('VND');

    // A caller with no cookie is nobody, and a cookie-less read is 401 rather than a guess.
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { host: HOST } });
    expect(anonymous.statusCode).toBe(401);
  });

  it('3. bootstraps the money account exactly once and reconciles the balance to its snapshot', async () => {
    const key = randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/financial-account`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, key),
      payload: { openingBalanceMinor: OPENING_BALANCE_MINOR, effectiveAt: '2026-10-01T00:00:00.000Z' },
    });
    expect(created.statusCode, created.body).toBe(201);

    // The same key and payload is a replay, not a second account.
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/financial-account`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, key),
      payload: { openingBalanceMinor: OPENING_BALANCE_MINOR, effectiveAt: '2026-10-01T00:00:00.000Z' },
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(created.json());

    const accounts = await pool.query('SELECT id FROM financial_accounts WHERE user_id = $1', [state.primary!.userId]);
    expect(accounts.rowCount, 'one account per owner').toBe(1);

    const current = await balance(state.session!.jar);
    expect(current.currentBalanceMinor).toBe(OPENING_BALANCE_MINOR);
    expect(current.postedCurrentExpenseMinor).toBe('0');

    const snapshot = await pool.query<{ amount_minor: string }>(
      'SELECT amount_minor FROM balance_snapshots WHERE account_id = $1 ORDER BY effective_at DESC, created_at DESC LIMIT 1',
      [accounts.rows[0]!.id],
    );
    expect(snapshot.rows[0]!.amount_minor).toBe(OPENING_BALANCE_MINOR);
  });

  it('4. posts an expense, refuses a stale write, and treats a replayed key as the same expense', async () => {
    const before = await balance(state.session!.jar);
    const key = randomUUID();
    const body = {
      kind: 'expense',
      amountMinor: EXPENSE_MINOR,
      occurredOn: '2026-10-02',
      categoryCode: 'food',
      expenseClass: 'essential_variable',
      expectedFinancialStateVersion: before.financialStateVersion,
      reviewedLatestSnapshotId: before.snapshot.id,
    };

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, key),
      payload: body,
    });
    expect(created.statusCode, created.body).toBe(201);
    state.transactionId = (created.json() as { transactionId: string }).transactionId;

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, key),
      payload: body,
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect((replay.json() as { transactionId: string }).transactionId).toBe(state.transactionId);

    const rows = await pool.query('SELECT 1 FROM transactions WHERE id = $1', [state.transactionId]);
    expect(rows.rowCount).toBe(1);

    const after = await balance(state.session!.jar);
    expect(after.currentBalanceMinor).toBe(String(Number(OPENING_BALANCE_MINOR) - Number(EXPENSE_MINOR)));
    expect(after.postedCurrentExpenseMinor).toBe(EXPENSE_MINOR);

    // The reviewed version is now stale, so the same body must be refused rather
    // than silently applied twice.
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, randomUUID()),
      payload: { ...body, occurredOn: '2026-10-03' },
    });
    expect(stale.statusCode, stale.body).toBe(409);
  });

  it('5. corrects the expense through its preview, moving the balance and keeping append-only history', async () => {
    const preview = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${state.transactionId}/correction-preview`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf),
      payload: {
        replacement: {
          amountMinor: CORRECTED_EXPENSE_MINOR,
          occurredOn: '2026-10-02',
          categoryCode: 'food',
          expenseClass: 'essential_variable',
          isUnexpected: false,
        },
        reason: 'Receipt was higher than the amount I entered first.',
      },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const previewBody = preview.json() as { context: Record<string, unknown>; currentBalance: { beforeMinor: string; afterMinor: string } };
    expect(previewBody.currentBalance.beforeMinor).toBe(String(Number(OPENING_BALANCE_MINOR) - Number(EXPENSE_MINOR)));
    expect(previewBody.currentBalance.afterMinor).toBe(String(Number(OPENING_BALANCE_MINOR) - Number(CORRECTED_EXPENSE_MINOR)));

    const committed = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${state.transactionId}/corrections`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, randomUUID()),
      payload: {
        replacement: {
          amountMinor: CORRECTED_EXPENSE_MINOR,
          occurredOn: '2026-10-02',
          categoryCode: 'food',
          expenseClass: 'essential_variable',
          isUnexpected: false,
        },
        reason: 'Receipt was higher than the amount I entered first.',
        context: previewBody.context,
      },
    });
    expect(committed.statusCode, committed.body).toBe(201);

    const after = await balance(state.session!.jar);
    expect(after.currentBalanceMinor).toBe(String(Number(OPENING_BALANCE_MINOR) - Number(CORRECTED_EXPENSE_MINOR)));

    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/transactions/${state.transactionId}/correction-history`,
      headers: browserHeaders(state.session!.jar),
    });
    expect(history.statusCode, history.body).toBe(200);
    const chain = history.json() as { items: { sourceTransactionId: string; replacementTransactionId: string }[] };
    expect(chain.items.length, 'the chain records the correction').toBeGreaterThan(0);

    // Append-only evidence: the source row keeps its original value and is voided
    // rather than rewritten, and the replacement names it through
    // `supersedes_transaction_id` — that pair is the correction chain.
    const source = (await pool.query<{ status: string; amount_minor: string; void_reason: string | null }>(
      'SELECT status, amount_minor, void_reason FROM transactions WHERE id = $1',
      [state.transactionId],
    )).rows[0]!;
    expect(source.amount_minor, 'the original amount is never rewritten').toBe(EXPENSE_MINOR);
    expect(source.status).toBe('voided');
    expect(source.void_reason).toBeTruthy();

    const successor = (await pool.query<{ amount_minor: string }>(
      'SELECT amount_minor FROM transactions WHERE supersedes_transaction_id = $1',
      [state.transactionId],
    )).rows[0];
    expect(successor?.amount_minor, 'the replacement carries the corrected amount').toBe(CORRECTED_EXPENSE_MINOR);

    const posted = (await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM transactions WHERE user_id = $1 AND status = 'posted'",
      [state.primary!.userId],
    )).rows[0]!;
    expect(posted.count, 'exactly the replacement is posted').toBe('1');
  });

  it('6. voids a second expense and removes it from the authoritative balance', async () => {
    const before = await balance(state.session!.jar);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, randomUUID()),
      payload: {
        kind: 'expense',
        amountMinor: VOID_EXPENSE_MINOR,
        occurredOn: '2026-10-04',
        categoryCode: 'transportation',
        expenseClass: 'daily',
        expectedFinancialStateVersion: before.financialStateVersion,
        reviewedLatestSnapshotId: before.snapshot.id,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    state.voidedTransactionId = (created.json() as { transactionId: string }).transactionId;

    const mid = await balance(state.session!.jar);
    expect(mid.currentBalanceMinor).toBe(String(Number(before.currentBalanceMinor) - Number(VOID_EXPENSE_MINOR)));

    const preview = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${state.voidedTransactionId}/void-preview`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf),
      payload: { reason: 'I entered a ride that my employer reimbursed.' },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const context = (preview.json() as { context: Record<string, unknown> }).context;

    const voided = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${state.voidedTransactionId}/void`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, randomUUID()),
      payload: { reason: 'I entered a ride that my employer reimbursed.', context },
    });
    expect(voided.statusCode, voided.body).toBe(200);

    const after = await balance(state.session!.jar);
    expect(after.currentBalanceMinor).toBe(before.currentBalanceMinor);

    const row = (await pool.query<{ status: string; voided_at: Date | null }>(
      'SELECT status, voided_at FROM transactions WHERE id = $1',
      [state.voidedTransactionId],
    )).rows[0]!;
    expect(row.status).toBe('voided');
    expect(row.voided_at).not.toBeNull();
  });

  it('7. keeps a one-off occurrence projected until it is explicitly confirmed, then posts it', async () => {
    const before = await balance(state.session!.jar);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/schedule/one-off`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, randomUUID()),
      payload: {
        title: 'Electricity bill',
        kind: 'expense',
        expectedAmountMinor: '480000',
        dueOn: '2026-10-20',
        categoryCode: 'electricity',
        expenseClass: 'essential_fixed',
        expectedFinancialStateVersion: before.financialStateVersion,
        reviewedLatestSnapshotId: before.snapshot.id,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    state.occurrenceId = (created.json() as { occurrenceId: string }).occurrenceId;

    // Projected means projected: the balance has not moved yet.
    const projected = await balance(state.session!.jar);
    expect(projected.currentBalanceMinor).toBe(before.currentBalanceMinor);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/schedule/occurrences?state=scheduled',
      headers: browserHeaders(state.session!.jar),
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const items = (listed.json() as { items: { id: string; state: string; presentation: string }[] }).items;
    expect(items.map((item) => item.id)).toContain(state.occurrenceId);
    expect(items.find((item) => item.id === state.occurrenceId)!.state).toBe('scheduled');

    const stillCurrent = await balance(state.session!.jar);
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/schedule/occurrences/${state.occurrenceId}/confirm`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, randomUUID()),
      payload: {
        amountMinor: '487500',
        occurredOn: '2026-10-12',
        categoryCode: 'electricity',
        expenseClass: 'essential_fixed',
        expectedFinancialStateVersion: stillCurrent.financialStateVersion,
        reviewedLatestSnapshotId: stillCurrent.snapshot.id,
        reviewedOccurrenceVersion: '1',
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);

    const after = await balance(state.session!.jar);
    expect(after.currentBalanceMinor).toBe(String(Number(before.currentBalanceMinor) - 487_500));

    const occurrence = (await pool.query<{ state: string; confirmed_transaction_id: string | null }>(
      'SELECT state, confirmed_transaction_id FROM scheduled_occurrences WHERE id = $1',
      [state.occurrenceId],
    )).rows[0]!;
    expect(occurrence.state).toBe('confirmed');
    expect(occurrence.confirmed_transaction_id).not.toBeNull();
  });

  it('8. tracks a savings goal without ever touching the authoritative account balance', async () => {
    const before = await balance(state.session!.jar);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/savings-goals`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, randomUUID()),
      payload: {
        name: 'Emergency fund',
        targetAmountMinor: SAVINGS_TARGET_MINOR,
        currentAmountMinor: SAVINGS_CURRENT_MINOR,
        currentAmountAsOf: '2026-10-05',
        plannedContributionMinor: '200000',
        contributionFrequency: 'monthly',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    state.goalId = (created.json() as { goalId: string }).goalId;

    const updated = await app.inject({
      method: 'POST',
      url: `/api/v1/savings-goals/${state.goalId}/current-amount`,
      headers: browserHeaders(state.session!.jar, state.session!.csrf, randomUUID()),
      payload: { expectedVersion: '1', currentAmountMinor: '750000', asOf: '2026-10-06', reason: 'Monthly transfer' },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/savings-goals/${state.goalId}/amount-changes`,
      headers: browserHeaders(state.session!.jar),
    });
    expect(history.statusCode, history.body).toBe(200);
    const changes = (history.json() as { items: unknown[] }).items;
    expect(changes.length).toBeGreaterThanOrEqual(2);

    const after = await balance(state.session!.jar);
    expect(after.currentBalanceMinor, 'savings never move the account balance').toBe(before.currentBalanceMinor);
    expect(after.financialStateVersion).toBe(before.financialStateVersion);
  });

  it('9. reports monthly actuals that reconcile to the posted terminal transactions', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/monthly-actuals?month=2026-10',
      headers: browserHeaders(state.session!.jar),
    });
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json() as { month: string; expenseMinor: string; incomeMinor: string; netMinor: string; groups: { amountMinor: string; transactionCount: number }[] };

    expect(report.month).toBe('2026-10');
    expect(report.incomeMinor).toBe('0');
    // Corrected (310000) + confirmed occurrence (487500); the voided row is gone.
    expect(report.expenseMinor).toBe(String(310_000 + 487_500));
    expect(report.netMinor).toBe(`-${String(310_000 + 487_500)}`);
    const grouped = report.groups.reduce((total, group) => total + Number(group.amountMinor), 0);
    expect(grouped, 'group totals equal the reported total').toBe(Number(report.expenseMinor));

    const posted = (await pool.query<{ total: string; count: string }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS total, COUNT(*)::text AS count
         FROM transactions
        WHERE user_id = $1 AND status = 'posted' AND kind = 'expense'
          AND occurred_on >= '2026-10-01' AND occurred_on < '2026-11-01'`,
      [state.primary!.userId],
    )).rows[0]!;
    expect(posted.total).toBe(report.expenseMinor);
  });

  it('10. isolates two owners across every object the journey touched', async () => {
    const other = await register(`journey-other-${randomUUID()}@example.invalid`);
    const otherSession = await signIn(other.email, other.password);

    const theirs = await app.inject({
      method: 'GET',
      url: `/api/v1/transactions/${state.transactionId}`,
      headers: browserHeaders(otherSession.jar),
    });
    expect([403, 404]).toContain(theirs.statusCode);

    const theirGoal = await app.inject({
      method: 'GET',
      url: `/api/v1/savings-goals/${state.goalId}`,
      headers: browserHeaders(otherSession.jar),
    });
    expect([403, 404]).toContain(theirGoal.statusCode);

    const theirAccount = await app.inject({
      method: 'GET',
      url: '/api/v1/financial-account',
      headers: browserHeaders(otherSession.jar),
    });
    expect([403, 404]).toContain(theirAccount.statusCode);

    // The other owner's list endpoints show nothing of the first owner's data.
    const theirTransactions = await app.inject({
      method: 'GET',
      url: '/api/v1/transactions',
      headers: browserHeaders(otherSession.jar),
    });
    expect(theirTransactions.statusCode, theirTransactions.body).toBe(200);
    expect((theirTransactions.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('11. changes the password, revokes the other sessions, and leaves the active one usable', async () => {
    const second = await signIn(state.primary!.email, state.primary!.password);
    expect(second.sessionId).not.toBe(state.session!.sessionId);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: browserHeaders(state.session!.jar, state.session!.csrf),
      payload: { currentPassword: state.primary!.password, newPassword: 'journey-password-2' },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    const revoked = (await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM sessions WHERE id = $1',
      [second.sessionId],
    )).rows[0]!;
    expect(revoked.revoked_at, 'the other session is revoked').not.toBeNull();

    const stale = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: browserHeaders(second.jar),
    });
    expect(stale.statusCode).toBe(401);

    const oldPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: browserHeaders(),
      payload: { email: state.primary!.email, password: state.primary!.password },
    });
    expect(oldPassword.statusCode, 'the old password is no longer accepted').toBe(401);

    state.primary!.password = 'journey-password-2';
  });

  it('12. resets a forgotten password through the mailed OTP and revokes every session', async () => {
    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset-request',
      headers: browserHeaders(),
      payload: { email: state.primary!.email },
    });
    expect(requested.statusCode, requested.body).toBe(200);
    expect(requested.json()).toEqual({ accepted: true });

    const message = email.messages.filter((entry) => entry.to === state.primary!.email).at(-1);
    expect(message?.oneTimeSecret, 'the code is delivered out of band').toMatch(/^[0-9]{6}$/);

    // A wrong code answers generically, and running out of attempts is not a pass.
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      headers: browserHeaders(),
      payload: { email: state.primary!.email, oneTimeCode: '000000', newPassword: 'journey-password-3' },
    });
    expect([400, 401, 429]).toContain(wrong.statusCode);

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      headers: browserHeaders(),
      payload: {
        email: state.primary!.email,
        oneTimeCode: message!.oneTimeSecret!,
        newPassword: 'journey-password-3',
      },
    });
    expect(reset.statusCode, reset.body).toBe(200);

    const live = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [state.primary!.userId],
    );
    expect(live.rows[0]!.count, 'a reset revokes every session').toBe('0');

    const beforeSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: browserHeaders(state.session!.jar),
    });
    expect(beforeSession.statusCode).toBe(401);

    const signedIn = await signIn(state.primary!.email, 'journey-password-3');
    expect(signedIn.sessionId).toBeTruthy();
    // The reset revoked the cookie the journey had been using, so the following step
    // continues with the session the user just obtained.
    state.session = signedIn;

    // The OTP is single-use: the same code cannot be replayed after a successful reset.
    const replayed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      headers: browserHeaders(),
      payload: {
        email: state.primary!.email,
        oneTimeCode: message!.oneTimeSecret!,
        newPassword: 'journey-password-4',
      },
    });
    expect([400, 401, 429]).toContain(replayed.statusCode);
  });

  it('13. keeps operator-only security history out of the user-facing list', async () => {
    // `EVENT_VISIBILITY` splits the history in two: the user reads their own
    // sign-ins and password changes, while abuse and enforcement events are for the
    // operator only. The wrong-OTP attempt in step 12 is one of the latter.
    const events = (await pool.query<{ event_type: string; visibility: string }>(
      'SELECT event_type, visibility FROM security_events WHERE user_id = $1',
      [state.primary!.userId],
    )).rows;
    const types = events.map((event) => event.event_type);
    expect(types, 'sign-ins are recorded').toContain('login_succeeded');
    expect(types, 'password changes are recorded').toContain('password_changed');
    expect(types, 'password resets are recorded').toContain('password_reset_completed');

    const OPERATOR_ONLY = new Set([
      'verification_challenge_issued',
      'verification_challenge_failed',
      'password_reset_failed',
      'session_token_rotated',
      'session_expired',
      'access_denied_unverified',
    ]);
    for (const event of events) {
      if (OPERATOR_ONLY.has(event.event_type)) {
        expect(event.visibility, `${event.event_type} is operator-only`).toBe('operator');
      }
    }
    expect(
      [...OPERATOR_ONLY].some((type) => events.some((event) => event.event_type === type)),
      'the run produced at least one operator-only event to test the boundary with',
    ).toBe(true);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/security-events',
      headers: browserHeaders(state.session!.jar),
    });
    expect(response.statusCode, response.body).toBe(200);
    const visible = (response.json() as { items: { eventType: string }[] }).items.map((item) => item.eventType);
    expect(visible, 'the user still sees their own session history').toContain('login_succeeded');
    for (const type of OPERATOR_ONLY) {
      expect(visible, `${type} must never reach the user surface`).not.toContain(type);
    }
  });
});
