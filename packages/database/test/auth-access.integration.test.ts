import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresAuthRepository,
  keyedDigest,
  migrateDatabase,
  type AuthAccessPolicy,
  type LoginResult,
  type RegisterResult,
} from '../src/index.js';

/**
 * Trusted Private Beta access on real PostgreSQL.
 *
 * Candidate policy values are pinned here so the suite stays deterministic; they
 * mirror `authPolicy` in `@kfin/config` and remain unapproved candidates under
 * `SPEC-AUTH-02`. Each scenario uses its own source network so the layered
 * per-IP abuse windows do not interfere across cases.
 */

const SECRET = 'ef'.repeat(32);
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BASE_POLICY: AuthAccessPolicy = {
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

function policy(overrides: {
  challenge?: Partial<AuthAccessPolicy['challenge']>;
  session?: Partial<AuthAccessPolicy['session']>;
} = {}): AuthAccessPolicy {
  return {
    ...BASE_POLICY,
    challenge: { ...BASE_POLICY.challenge, ...overrides.challenge },
    session: { ...BASE_POLICY.session, ...overrides.session },
  };
}

const integrationEnabled = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.KFIN_INTEGRATION_TARGET === 'non-production',
);

const integration = describe.skipIf(!integrationEnabled);

integration('trusted private beta access on real PostgreSQL', () => {
  let administration: Pool;
  let database: Pool;
  let schema: string;
  let clock: number;
  const now = () => clock;

  beforeAll(async () => {
    schema = `kfin_it_${randomUUID().replaceAll('-', '')}`;
    administration = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await administration.query(`CREATE SCHEMA ${schema}`);
    database = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 6,
      options: `-c search_path=${schema},public`,
    });
    await migrateDatabase(database);
    clock = Date.UTC(2026, 9, 8, 2, 0, 0);
  }, 60_000);

  afterAll(async () => {
    if (database) await database.end();
    if (administration && schema) {
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administration.end();
    }
  }, 30_000);

  function repository(overrides: Parameters<typeof policy>[0] = {}) {
    return new PostgresAuthRepository(database, { secret: SECRET, policy: policy(overrides), now });
  }

  /** Distinct /24 source per scenario so per-IP abuse windows stay independent. */
  function source(network: number): string {
    return `198.51.${network}.7`;
  }

  const AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)';

  async function invite(email?: string) {
    return repository().issueInvitation({
      ...(email === undefined ? {} : { invitedEmail: email }),
      createdByOperatorId: randomUUID(),
      correlationId: randomUUID(),
    });
  }

  const profile = {
    locale: 'vi-VN',
    timezone: 'Asia/Ho_Chi_Minh',
    baseCurrency: 'VND',
  };

  async function register(
    repo: PostgresAuthRepository,
    code: string,
    email = `beta-${randomUUID()}@example.invalid`,
    network = 100,
  ): Promise<RegisterResult & { userId: string }> {
    const result = await repo.register({
      email,
      password: 'correct horse battery staple',
      invitationCode: code,
      ...profile,
      correlationId: randomUUID(),
      ipAddress: source(network),
      userAgent: AGENT,
    });
    if (!result.userId) {
      throw new Error('access fixture: registration was not performed for a fresh address');
    }
    return result as RegisterResult & { userId: string };
  }

  /**
   * The session fixture. Registration no longer proves an email address and issues
   * no session (OQ-20), so every scenario that needs an authenticated principal
   * signs in with the password it just registered.
   */
  async function signIn(
    repo: PostgresAuthRepository,
    email: string,
    network = 100,
    password = 'correct horse battery staple',
  ): Promise<LoginResult> {
    return repo.login({
      email,
      password,
      correlationId: randomUUID(),
      ipAddress: source(network),
      userAgent: AGENT,
    });
  }

  it('registers a usable but explicitly unverified account and signs in without any code', async () => {
    const network = 11;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);

    // Registration created the account in its finished state: usable, and honest
    // about an address nobody has proved yet (OQ-20, SEC-AUTH-18/19).
    const created = await database.query<{
      status: string; email_verification_state: string; email_verified_at: Date | null;
    }>(
      `SELECT status, email_verification_state, email_verified_at FROM users WHERE id = $1`,
      [registered.userId],
    );
    expect(created.rows[0]).toMatchObject({
      status: 'active',
      email_verification_state: 'unverified',
      email_verified_at: null,
    });

    // No challenge was issued and no code exists to be verified: the only challenge
    // purpose that can be inserted is `password_reset` (asserted below).
    const challenges = await database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM auth_challenges WHERE user_id = $1`,
      [registered.userId],
    );
    expect(challenges.rows[0]?.count).toBe('0');

    // No session is issued by registration, and none can be promoted from one.
    const beforeSignIn = await database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM sessions WHERE user_id = $1`,
      [registered.userId],
    );
    expect(beforeSignIn.rows[0]?.count).toBe('0');

    const signedIn = await signIn(repo, email, network);
    const principal = await repo.authenticate(signedIn.session.sessionToken);
    expect(principal?.userId).toBe(registered.userId);
    expect(principal?.sessionId).toBe(signedIn.session.session.id);
    expect(repo.verifyCsrfToken(signedIn.session.csrfToken, principal!.csrfDigest)).toBe(true);
    expect(repo.verifyCsrfToken('another-value', principal!.csrfDigest)).toBe(false);

    // Signing in does not verify anything either.
    const afterSignIn = await database.query<{ email_verification_state: string; email_verified_at: Date | null }>(
      `SELECT email_verification_state, email_verified_at FROM users WHERE id = $1`,
      [registered.userId],
    );
    expect(afterSignIn.rows[0]).toMatchObject({ email_verification_state: 'unverified', email_verified_at: null });

    const profileView = await repo.getProfile(registered.userId);
    expect(profileView).toMatchObject({
      email,
      status: 'active',
      emailVerifiedAt: null,
      baseCurrency: 'VND',
    });
  });

  it('consumes one invitation exactly once, including under parallel registration', async () => {
    const network = 12;
    const repo = repository();
    const invitation = await invite();
    const first = await register(repo, invitation.code, undefined, network);
    expect(first.userId).toBeTruthy();

    await expect(register(repo, invitation.code, undefined, network)).rejects.toMatchObject({
      code: 'AUTH_INVITATION_INVALID',
      statusCode: 400,
    });

    const consumed = await database.query<{ status: string; consumed_by_user_id: string }>(
      `SELECT status, consumed_by_user_id FROM beta_invitations WHERE id = $1`,
      [invitation.invitationId],
    );
    expect(consumed.rows[0]).toMatchObject({ status: 'consumed', consumed_by_user_id: first.userId });

    const raceInvitation = await invite();
    const attempts = await Promise.allSettled([
      register(repo, raceInvitation.code, undefined, network),
      register(repo, raceInvitation.code, undefined, network),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected') as PromiseRejectedResult[];
    expect((rejected[0]?.reason as { code: string }).code).toBe('AUTH_INVITATION_INVALID');
  });

  it('binds an invitation to its invited email and never admits by email alone', async () => {
    const network = 13;
    const repo = repository();
    const bound = await invite(`bound-${randomUUID()}@example.invalid`);
    await expect(
      register(repo, bound.code, `other-${randomUUID()}@example.invalid`, network),
    ).rejects.toMatchObject({ code: 'AUTH_INVITATION_INVALID' });

    await expect(
      register(repo, 'ABCDEFGH-JKMNPQRS-TVWXYZ23-456789AB', `nobody-${randomUUID()}@example.invalid`, network),
    ).rejects.toMatchObject({ code: 'AUTH_INVITATION_INVALID' });
  });

  it('stores every access secret only as a purpose-separated keyed digest', async () => {
    const network = 14;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);

    const stored = await database.query<{ code_digest: Buffer }>(
      `SELECT code_digest FROM beta_invitations WHERE id = $1`,
      [invitation.invitationId],
    );
    expect(stored.rows[0]?.code_digest.equals(
      keyedDigest(SECRET, 'invitation-code', invitation.code),
    )).toBe(true);
    expect(stored.rows[0]?.code_digest.toString('utf8')).not.toContain(invitation.code);

    const requested = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(requested.delivery?.oneTimeCode).toMatch(/^[0-9]{6}$/);

    const challenge = await database.query<{
      purpose: string; secret_digest: Buffer; target_digest: Buffer;
    }>(
      `SELECT purpose, secret_digest, target_digest FROM auth_challenges WHERE id = $1`,
      [requested.delivery!.challengeId],
    );
    expect(challenge.rows[0]?.purpose).toBe('password_reset');
    expect(challenge.rows[0]?.secret_digest.equals(
      keyedDigest(SECRET, 'challenge-secret:password_reset', requested.delivery!.oneTimeCode),
    )).toBe(true);
    expect(challenge.rows[0]?.target_digest.equals(
      keyedDigest(SECRET, 'challenge-target:password_reset', email.toLowerCase()),
    )).toBe(true);
    expect(challenge.rows[0]?.secret_digest.equals(
      keyedDigest(SECRET, 'challenge-secret:password_reset', '000000'),
    )).toBe(false);
    expect(challenge.rows[0]?.secret_digest.equals(
      keyedDigest(SECRET, 'challenge-secret:email_verification', requested.delivery!.oneTimeCode),
    )).toBe(false);
    // The six digits exist only in request-process memory, never in a column.
    expect(challenge.rows[0]?.secret_digest.toString('utf8')).not.toContain(
      requested.delivery!.oneTimeCode,
    );

    const credential = await database.query<{ password_hash: string }>(
      `SELECT password_hash FROM password_credentials WHERE user_id = $1`,
      [registered.userId],
    );
    expect(credential.rows[0]?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(credential.rows[0]?.password_hash).not.toContain('correct horse battery staple');
  });

  it('issues a six-digit, single-use reset OTP and refuses every later use of it', async () => {
    const network = 40;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);

    const requested = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(requested.issued).toBe(true);
    expect(requested.delivery?.oneTimeCode).toMatch(/^[0-9]{6}$/);

    const stored = await database.query<{
      purpose: string; issued_at: Date; expires_at: Date; max_attempts: number; attempt_count: number;
    }>(
      `SELECT purpose, issued_at, expires_at, max_attempts, attempt_count
         FROM auth_challenges WHERE id = $1`,
      [requested.delivery!.challengeId],
    );
    expect(stored.rows[0]).toMatchObject({ purpose: 'password_reset', attempt_count: 0 });
    // Ten minutes, five attempts, and no URL-token lifetime to speak of: the reset
    // challenge is an OTP challenge, not a bearer link.
    expect(stored.rows[0]!.expires_at.getTime() - stored.rows[0]!.issued_at.getTime())
      .toBe(BASE_POLICY.challenge.otpLifetimeMs);
    expect(stored.rows[0]!.max_attempts).toBe(BASE_POLICY.challenge.maximumAttempts);

    const reset = await repo.resetPassword({
      email,
      oneTimeCode: requested.delivery!.oneTimeCode,
      newPassword: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(reset.userId).toBe(registered.userId);

    const consumed = await database.query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM auth_challenges WHERE id = $1`,
      [requested.delivery!.challengeId],
    );
    expect(consumed.rows[0]?.consumed_at).not.toBeNull();

    await expect(repo.resetPassword({
      email,
      oneTimeCode: requested.delivery!.oneTimeCode,
      newPassword: 'reset-passphrase-value-2',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });

    // The OTP was the only way to prove the address, and only after a reset did any
    // verification state change — the reset itself does not claim verification.
    const user = await database.query<{ email_verification_state: string; email_verified_at: Date | null }>(
      `SELECT email_verification_state, email_verified_at FROM users WHERE id = $1`,
      [registered.userId],
    );
    expect(user.rows[0]).toMatchObject({ email_verification_state: 'unverified', email_verified_at: null });
  });

  it('expires an unused reset OTP, retires it, and answers generically', async () => {
    const network = 41;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    await register(repo, invitation.code, email, network);

    const requested = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    clock += BASE_POLICY.challenge.otpLifetimeMs + 1;
    await expect(repo.resetPassword({
      email,
      oneTimeCode: requested.delivery!.oneTimeCode,
      newPassword: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_EXPIRED' });
    clock -= BASE_POLICY.challenge.otpLifetimeMs + 1;

    // An expired challenge is superseded, so the same code can never be spent twice.
    const retired = await database.query<{ superseded_at: Date | null }>(
      `SELECT superseded_at FROM auth_challenges WHERE id = $1`,
      [requested.delivery!.challengeId],
    );
    expect(retired.rows[0]?.superseded_at).not.toBeNull();
  });

  it('ends a reset OTP after five wrong attempts and requires a fresh one', async () => {
    const network = 42;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    await register(repo, invitation.code, email, network);

    const requested = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    const wrong = requested.delivery!.oneTimeCode === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < BASE_POLICY.challenge.maximumAttempts; attempt += 1) {
      await expect(repo.resetPassword({
        email,
        oneTimeCode: wrong,
        newPassword: 'reset-passphrase-value-1',
        correlationId: randomUUID(),
        ipAddress: source(network),
      })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });
    }
    await expect(repo.resetPassword({
      email,
      oneTimeCode: wrong,
      newPassword: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_ATTEMPTS_EXHAUSTED' });

    const exhausted = await database.query<{ attempt_count: number; superseded_at: Date | null }>(
      `SELECT attempt_count, superseded_at FROM auth_challenges WHERE id = $1`,
      [requested.delivery!.challengeId],
    );
    expect(exhausted.rows[0]?.attempt_count).toBe(BASE_POLICY.challenge.maximumAttempts);
    expect(exhausted.rows[0]?.superseded_at).not.toBeNull();

    // The owner can still recover, with a new code and a fresh attempt allowance.
    clock += BASE_POLICY.challenge.resendCooldownMs + 1;
    const reissued = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(reissued.issued).toBe(true);
    await expect(repo.resetPassword({
      email,
      oneTimeCode: reissued.delivery!.oneTimeCode,
      newPassword: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).resolves.toMatchObject({ sessionsRevoked: 0 });
  });

  it('counts wrong reset codes cumulatively across superseded challenges', async () => {
    const network = 43;
    const budget = 3;
    const repo = repository({
      challenge: { verifyCumulativeMaximum: budget, verifyCumulativeWindowMs: 60 * 60 * 1_000 },
    });
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    await register(repo, invitation.code, email, network);

    const wrong = (code: string) => (code === '000000' ? '111111' : '000000');
    const first = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    await expect(repo.resetPassword({
      email,
      oneTimeCode: wrong(first.delivery!.oneTimeCode),
      newPassword: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });

    // A resend must not restore the attacker's attempts: the second code is valid,
    // but the budget is spent and the answer is a rate limit, not a challenge error.
    clock += BASE_POLICY.challenge.resendCooldownMs + 1;
    const second = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(second.issued).toBe(true);
    await expect(repo.resetPassword({
      email,
      oneTimeCode: wrong(second.delivery!.oneTimeCode),
      newPassword: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });
    await expect(repo.resetPassword({
      email,
      oneTimeCode: wrong(second.delivery!.oneTimeCode),
      newPassword: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });

    const rateLimited = await repo.resetPassword({
      email,
      oneTimeCode: second.delivery!.oneTimeCode,
      newPassword: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(network),
    }).catch((error: { code: string; retryAfterSeconds?: number }) => error);
    expect(rateLimited).toMatchObject({ code: 'AUTH_RATE_LIMITED' });

    // The budget is windowed, not permanent: an hour later recovery works again.
    clock += 60 * 60 * 1_000 + 1;
    const recovered = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(recovered.issued).toBe(true);
    await expect(repo.resetPassword({
      email,
      oneTimeCode: recovered.delivery!.oneTimeCode,
      newPassword: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).resolves.toMatchObject({ sessionsRevoked: 0 });
  });

  it('stops issuing reset codes at three per hour and six per day', async () => {
    const network = 44;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);

    const request = () => repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    const issuedWithin = async (count: number): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        clock += BASE_POLICY.challenge.resendCooldownMs + 1;
        const outcome = await request();
        expect(outcome.issued).toBe(true);
        await database.query(
          `UPDATE auth_challenges SET superseded_at = COALESCE(superseded_at, now())
             WHERE id = $1`,
          [outcome.delivery!.challengeId],
        );
      }
    };

    // Hourly cap: the third code is issued, the fourth request inside the same hour
    // is accepted but silently issues nothing.
    await issuedWithin(BASE_POLICY.challenge.hourlyIssuanceCap);
    clock += BASE_POLICY.challenge.resendCooldownMs + 1;
    expect((await request()).issued).toBe(false);

    // Daily cap: the next hour reopens the hourly window, the daily ceiling holds.
    clock += 60 * 60 * 1_000;
    await issuedWithin(BASE_POLICY.challenge.dailyIssuanceCap - BASE_POLICY.challenge.hourlyIssuanceCap);
    clock += BASE_POLICY.challenge.resendCooldownMs + 1;
    expect((await request()).issued).toBe(false);

    const issued = await database.query<{ purpose: string; count: string }>(
      `SELECT purpose, COUNT(*) AS count FROM auth_challenges
        WHERE user_id = $1 GROUP BY purpose`,
      [registered.userId],
    );
    expect(issued.rows).toEqual([{ purpose: 'password_reset', count: String(BASE_POLICY.challenge.dailyIssuanceCap) }]);

    // An address that never had an account is throttled by the same counters and gets
    // the same unobservable answer.
    const unknown = await repo.requestPasswordReset({
      email: `nobody-${randomUUID()}@example.invalid`,
      correlationId: randomUUID(),
      ipAddress: source(45),
    });
    expect(unknown).toEqual({ accepted: true, issued: false, delivery: null });
  });

  it('never records a verification challenge and refuses to claim a verified address', async () => {
    const network = 46;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);

    // Negative control, database-enforced (OQ-20): the retired verification flow
    // cannot be restarted by a future caller that forgets this decision.
    await expect(database.query(
      `INSERT INTO auth_challenges (
         id, user_id, purpose, target_digest, secret_digest, issued_at, expires_at,
         max_attempts, correlation_id, created_at
       ) VALUES ($1, $2, 'email_verification', '\\x00', '\\x01', now(), now() + interval '10 min', 5, $3, now())`,
      [randomUUID(), registered.userId, randomUUID()],
    )).rejects.toMatchObject({ code: '23514' });

    // The retired status value is gone too, so no caller can park a fresh account in
    // a pre-active state the product no longer understands.
    await expect(database.query(
      `UPDATE users SET status = 'pending_verification' WHERE id = $1`,
      [registered.userId],
    )).rejects.toMatchObject({ code: '23514' });

    // And no writer may mark an address verified without a verification instant.
    await expect(database.query(
      `UPDATE users SET email_verification_state = 'verified' WHERE id = $1`,
      [registered.userId],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(database.query(
      `UPDATE users SET email_verified_at = now() WHERE id = $1`,
      [registered.userId],
    )).rejects.toMatchObject({ code: '23514' });

    const state = await database.query<{ email_verification_state: string; email_verified_at: Date | null }>(
      `SELECT email_verification_state, email_verified_at FROM users WHERE id = $1`,
      [registered.userId],
    );
    expect(state.rows[0]).toMatchObject({ email_verification_state: 'unverified', email_verified_at: null });
  });

  it('keeps a locked account unusable and records the operator-only refusal', async () => {
    const network = 47;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    const session = await signIn(repo, email, network);

    await database.query(`UPDATE users SET status = 'locked' WHERE id = $1`, [
      registered.userId,
    ]);

    // Every session is dropped the moment the account leaves `active`, and a locked
    // account cannot sign back in or reset its own way out (D4).
    expect(await repo.authenticate(session.session.sessionToken)).toBeNull();
    await expect(signIn(repo, email, network)).rejects.toMatchObject({
      code: 'AUTH_ACCOUNT_UNAVAILABLE',
    });
    const refusal = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(refusal).toEqual({ accepted: true, issued: false, delivery: null });

    const events = await database.query<{ event_type: string; outcome: string; metadata: Record<string, unknown> }>(
      `SELECT event_type, outcome, metadata FROM security_events
        WHERE user_id = $1 AND event_type = 'access_denied_unverified'`,
      [registered.userId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ outcome: 'failure' });
    expect(events.rows[0]!.metadata).toMatchObject({ accountStatus: 'locked' });
    // Operator-only: the account holder never learns it was locked from this route.
    const ownEvents = await repo.listSecurityEvents(registered.userId, { limit: 100 });
    expect(ownEvents.items.map((event) => event.eventType)).not.toContain('access_denied_unverified');
  });

  it('answers unknown and known login failures identically and limits abuse', async () => {
    const network = 17;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    await signIn(repo, email, network);

    const knownFailure = await repo.login({
      email,
      password: 'not-the-passphrase',
      correlationId: randomUUID(),
      ipAddress: source(network),
    }).catch((error: { code: string; safeMessage: string; statusCode: number }) => error);
    const unknownFailure = await repo.login({
      email: `nobody-${randomUUID()}@example.invalid`,
      password: 'not-the-passphrase',
      correlationId: randomUUID(),
      ipAddress: source(network),
    }).catch((error: { code: string; safeMessage: string; statusCode: number }) => error);

    expect(knownFailure).toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
      statusCode: 401,
      safeMessage: 'The email and password combination is not valid.',
    });
    expect(unknownFailure).toEqual(knownFailure);

    const success = await repo.login({
      email,
      password: 'correct horse battery staple',
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(await repo.authenticate(success.session.sessionToken)).toMatchObject({
      userId: registered.userId,
    });

    const abuseNetwork = 18;
    const target = `abuse-${randomUUID()}@example.invalid`;
    let limited: { code: string; statusCode: number; retryAfterSeconds: number } | null = null;
    for (let attempt = 0; attempt <= BASE_POLICY.abuse.loginMaximumFailures + 1; attempt += 1) {
      const outcome = await repo.login({
        email: target,
        password: 'not-the-passphrase',
        correlationId: randomUUID(),
        ipAddress: source(abuseNetwork),
      }).catch((error: { code: string; statusCode: number; retryAfterSeconds: number }) => error);
      if (outcome && typeof outcome === 'object' && 'code' in outcome && outcome.code === 'AUTH_RATE_LIMITED') {
        limited = outcome;
        break;
      }
    }
    expect(limited?.code).toBe('AUTH_RATE_LIMITED');
    expect(limited?.statusCode).toBe(429);
    expect(limited?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('enforces idle expiry, rotation grace, replay containment, and logout', async () => {
    const expiringNetwork = 19;
    const expiring = repository({ session: { idleLifetimeMs: 60_000 } });
    const expiringInvitation = await invite();
    const expiringEmail = `beta-${randomUUID()}@example.invalid`;
    const expiringRegistered = await register(expiring, expiringInvitation.code, expiringEmail, expiringNetwork);
    const expiringVerified = await signIn(expiring, expiringEmail, expiringNetwork);
    clock += 2 * 60_000;
    expect(await expiring.authenticate(expiringVerified.session.sessionToken)).toBeNull();
    const expired = await database.query<{ revocation_reason: string }>(
      `SELECT revocation_reason FROM sessions WHERE id = $1`,
      [expiringVerified.session.session.id],
    );
    expect(expired.rows[0]?.revocation_reason).toBe('expired');

    const network = 20;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    const verified = await signIn(repo, email, network);
    const firstToken = verified.session.sessionToken;
    const changed = await repo.changePassword({
      userId: registered.userId,
      sessionId: verified.session.session.id,
      currentPassword: 'correct horse battery staple',
      newPassword: 'a-fresh-passphrase-value',
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(changed.revokedOtherSessions).toBe(0);

    // The retired token still works inside the bounded grace window.
    expect(await repo.authenticate(firstToken)).toMatchObject({ userId: registered.userId });
    clock += BASE_POLICY.session.rotationGraceMs + 1_000;
    expect(await repo.authenticate(firstToken)).toBeNull();
    const replay = await database.query<{ revocation_reason: string }>(
      `SELECT revocation_reason FROM sessions WHERE id = $1`,
      [verified.session.session.id],
    );
    expect(replay.rows[0]?.revocation_reason).toBe('token_replay');

    const events = await repo.listSecurityEvents(registered.userId, { limit: 50 });
    expect(events.items.map((event) => event.eventType)).toContain('session_token_replay_detected');

    const relogin = await repo.login({
      email,
      password: 'a-fresh-passphrase-value',
      correlationId: randomUUID(),
      ipAddress: source(21),
    });
    expect(await repo.logout(relogin.userId, relogin.session.session.id, {
      correlationId: randomUUID(),
      ipAddress: source(21),
    })).toBe(true);
    expect(await repo.authenticate(relogin.session.sessionToken)).toBeNull();
  });

  it('revokes every session on password reset and requires a fresh sign-in', async () => {
    const network = 22;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    const first = await signIn(repo, email, network);
    const second = await signIn(repo, email, network);
    const third = await signIn(repo, email, network);

    const requested = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(requested).toMatchObject({ accepted: true, issued: true });
    expect(requested.delivery?.oneTimeCode).toMatch(/^[0-9]{6}$/);

    const reset = await repo.resetPassword({
      email,
      oneTimeCode: requested.delivery!.oneTimeCode,
      newPassword: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    // A reset revokes every existing session and issues none of its own
    // (ADR-004, PRD-AUTH-07): the owner must sign in again with the new password.
    expect(reset.sessionsRevoked).toBe(3);
    expect(await repo.authenticate(first.session.sessionToken)).toBeNull();
    expect(await repo.authenticate(second.session.sessionToken)).toBeNull();
    expect(await repo.authenticate(third.session.sessionToken)).toBeNull();
    const sessionsAfterReset = await database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [registered.userId],
    );
    expect(sessionsAfterReset.rows[0]?.count).toBe('0');

    await expect(repo.resetPassword({
      email,
      oneTimeCode: requested.delivery!.oneTimeCode,
      newPassword: 'reset-passphrase-value-2',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });

    const relogin = await repo.login({
      email,
      password: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(23),
    });
    expect(relogin.userId).toBe(registered.userId);
  });

  it('answers every reset request identically: unknown, non-active, cooled down, capped', async () => {
    const network = 24;
    const repo = repository();
    const requested = (email: string, networkOverride = network) => repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(networkOverride),
    });

    const unknown = await requested(`nobody-${randomUUID()}@example.invalid`);

    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    // An invited account that never verified anything is still recoverable: the
    // reset path is gated on account status, not on a verification that registration
    // no longer performs.
    const issuedToUnverified = await requested(email);
    expect(issuedToUnverified).toMatchObject({ accepted: true, issued: true });
    expect(issuedToUnverified.delivery?.oneTimeCode).toMatch(/^[0-9]{6}$/);

    // Case 2: inside the cooldown the request is accepted and nothing is issued.
    const cooledDown = await requested(email);
    // Case 3: a locked account is never self-recoverable (D4).
    await database.query(`UPDATE users SET status = 'locked' WHERE id = $1`, [
      registered.userId,
    ]);
    const locked = await requested(email);
    // Case 4: the per-account issuance cap, reached by walking past the cooldown.
    await database.query(`UPDATE users SET status = 'active' WHERE id = $1`, [
      registered.userId,
    ]);
    let capped = cooledDown;
    for (let index = 0; index < BASE_POLICY.challenge.hourlyIssuanceCap; index += 1) {
      clock += BASE_POLICY.challenge.resendCooldownMs + 1;
      capped = await requested(email);
      if (!capped.issued) break;
    }

    // Byte-identical outcomes: a caller cannot tell the four cases apart
    // (SEC-AUTH-04, TM-03), and the only differing field is the unobservable
    // delivery handle held by the API.
    const observable = (result: {
      accepted: true; issued: boolean; delivery: unknown;
    }) => JSON.stringify({ accepted: result.accepted, body: { accepted: true } });
    expect(observable(unknown)).toBe(observable(cooledDown));
    expect(observable(unknown)).toBe(observable(locked));
    expect(observable(unknown)).toBe(observable(capped));
    for (const result of [unknown, cooledDown, locked, capped]) {
      expect(result).toEqual({ accepted: true, issued: false, delivery: null });
    }
    expect(capped.issued).toBe(false);
  });

  it('isolates owners in session management and hides operator-only events', async () => {
    const network = 25;
    const repo = repository();
    const firstEmail = `beta-${randomUUID()}@example.invalid`;
    const secondEmail = `beta-${randomUUID()}@example.invalid`;
    const firstRegistered = await register(repo, (await invite()).code, firstEmail, network);
    const secondRegistered = await register(repo, (await invite()).code, secondEmail, network);
    const firstVerified = await signIn(repo, firstEmail, network);
    const secondVerified = await signIn(repo, secondEmail, network);

    const firstSessions = await repo.listSessions(firstRegistered.userId, {
      limit: 50,
      currentSessionId: firstVerified.session.session.id,
    });
    expect(firstSessions.items).toHaveLength(1);
    expect(firstSessions.items[0]).toMatchObject({
      id: firstVerified.session.session.id,
      current: true,
    });

    expect(await repo.revokeSession(
      firstRegistered.userId,
      secondVerified.session.session.id,
      { correlationId: randomUUID(), ipAddress: source(network) },
    )).toBe(false);
    expect(await repo.authenticate(secondVerified.session.sessionToken)).toMatchObject({
      userId: secondRegistered.userId,
    });

    const events = await repo.listSecurityEvents(firstRegistered.userId, { limit: 100 });
    const types = events.items.map((event) => event.eventType);
    expect(types).toContain('registration_requested');
    expect(types).toContain('login_succeeded');
    // OQ-20: nothing in the product verifies an email any more, so nobody can hold a
    // verification event — not even the account that just signed in successfully.
    expect(types).not.toContain('email_verified');
    expect(types).not.toContain('verification_challenge_issued');
    expect(types).not.toContain('verification_challenge_failed');
    for (const event of events.items) {
      expect(event.sessionId === null || UUID_LIKE.test(event.sessionId)).toBe(true);
    }

    // Regression (QA finding F-1): "log out everywhere" must terminate the
    // session that issued it too, because a live token after a global sign-out
    // is exactly the credential the user is trying to destroy.
    const secondRelogin = await repo.login({
      email: secondEmail,
      password: 'correct horse battery staple',
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    const secondSessions = await repo.listSessions(secondRegistered.userId, {
      limit: 50,
      currentSessionId: secondVerified.session.session.id,
    });
    expect(secondSessions.items).toHaveLength(2);

    const revokedAll = await repo.logoutAll(secondRegistered.userId, {
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(revokedAll).toBe(2);
    expect(await repo.authenticate(secondVerified.session.sessionToken)).toBeNull();
    expect(await repo.authenticate(secondRelogin.session.sessionToken)).toBeNull();

    const revokedRows = await database.query<{ revoked: number; reason: string | null }>(
      `SELECT count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked,
              min(revocation_reason) AS reason
         FROM sessions WHERE user_id = $1`,
      [secondRegistered.userId],
    );
    expect(revokedRows.rows[0]).toMatchObject({ revoked: 2, reason: 'user_logout_all' });
    const liveTokens = await database.query<{ live: number }>(
      `SELECT count(*)::int AS live
         FROM session_tokens t
         JOIN sessions s ON s.id = t.session_id
        WHERE s.user_id = $1 AND t.retired_at IS NULL`,
      [secondRegistered.userId],
    );
    expect(liveTokens.rows[0]?.live).toBe(0);
    expect((await repo.listSessions(secondRegistered.userId, { limit: 50 })).items).toHaveLength(0);

    // The other owner's session is untouched.
    expect(await repo.authenticate(firstVerified.session.sessionToken)).toMatchObject({
      userId: firstRegistered.userId,
    });
  });

  it('revokes the requesting session on logout-all so its token cannot be replayed', async () => {
    const network = 32;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    const verified = await signIn(repo, email, network);
    const relogin = await repo.login({
      email,
      password: 'correct horse battery staple',
      correlationId: randomUUID(),
      ipAddress: source(network),
      userAgent: AGENT,
    });
    expect(await repo.authenticate(verified.session.sessionToken)).not.toBeNull();
    expect(await repo.authenticate(relogin.session.sessionToken)).not.toBeNull();

    expect(await repo.logoutAll(registered.userId, {
      correlationId: randomUUID(),
      ipAddress: source(network),
      userAgent: AGENT,
    })).toBe(2);

    // Both tokens are dead immediately: no grace window survives a global
    // sign-out, so a captured token cannot be replayed afterwards.
    expect(await repo.authenticate(verified.session.sessionToken)).toBeNull();
    expect(await repo.authenticate(relogin.session.sessionToken)).toBeNull();
    const events = await repo.listSecurityEvents(registered.userId, { limit: 50 });
    expect(events.items.map((event) => event.eventType)).toContain('logout_all');
  });

  it('re-checks account status on every session use', async () => {
    const network = 26;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    const verified = await signIn(repo, email, network);
    expect(await repo.authenticate(verified.session.sessionToken)).not.toBeNull();

    await database.query(`UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1`, [
      registered.userId,
    ]);
    expect(await repo.authenticate(verified.session.sessionToken)).toBeNull();
    await expect(repo.login({
      email,
      password: 'correct horse battery staple',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_UNAVAILABLE' });
  });

  it('rejects a password outside the candidate policy and refuses reuse', async () => {
    const network = 27;
    const repo = repository();
    const invitation = await invite();
    await expect(repo.register({
      email: `beta-${randomUUID()}@example.invalid`,
      password: 'short',
      invitationCode: invitation.code,
      ...profile,
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_PASSWORD_POLICY_FAILED' });

    const unused = await database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM beta_invitations WHERE id = $1 AND status = 'active'`,
      [invitation.invitationId],
    );
    expect(unused.rows[0]?.count).toBe('1');

    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    await signIn(repo, email, network);
    const session = await repo.login({
      email,
      password: 'correct horse battery staple',
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    await expect(repo.changePassword({
      userId: registered.userId,
      sessionId: session.session.session.id,
      currentPassword: 'correct horse battery staple',
      newPassword: 'correct horse battery staple',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_PASSWORD_REUSED' });
    await expect(repo.changePassword({
      userId: registered.userId,
      sessionId: session.session.session.id,
      currentPassword: 'wrong-current-passphrase',
      newPassword: 'another-fresh-passphrase',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('answers a duplicate registration generically without consuming the invitation', async () => {
    const network = 28;
    const repo = repository();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, (await invite()).code, email, network);
    const secondInvitation = await invite();

    const duplicate = await repo.register({
      email,
      password: 'correct horse battery staple',
      invitationCode: secondInvitation.code,
      ...profile,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });

    expect(duplicate).toEqual({ accepted: true, userId: null });
    // A duplicate address is answered generically and issues nothing: the existing
    // account gains no challenge and no session from someone else's attempt.
    const challenges = await database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM auth_challenges WHERE user_id = $1`,
      [registered.userId],
    );
    expect(challenges.rows[0]?.count).toBe('0');

    const invitation = await database.query<{ status: string }>(
      `SELECT status FROM beta_invitations WHERE id = $1`,
      [secondInvitation.invitationId],
    );
    expect(invitation.rows[0]?.status).toBe('active');

    const users = await database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM users WHERE email_normalized = $1`,
      [email.toLowerCase()],
    );
    expect(users.rows[0]?.count).toBe('1');
  });

  it('clamps a renewed idle expiry to the absolute expiry on use and on rotation', async () => {
    const network = 30;
    const absoluteLifetimeMs = 60 * 60 * 1_000;
    const idleLifetimeMs = 50 * 60 * 1_000;
    const repo = repository({ session: { absoluteLifetimeMs, idleLifetimeMs, lastSeenThrottleMs: 0 } });
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    const verified = await signIn(repo, email, network);
    const sessionId = verified.session.session.id;
    const absolute = new Date(verified.session.session.absoluteExpiresAt).getTime();
    expect(new Date(verified.session.session.idleExpiresAt).getTime()).toBeLessThan(absolute);

    // Renew 45 minutes in, while the session is still live but only 15 minutes
    // from its absolute expiry: a full idle window would reach 95 minutes, so
    // the sliding window must be clamped to the absolute bound.
    clock += 45 * 60_000;
    const principal = await repo.authenticate(verified.session.sessionToken);
    expect(principal?.userId).toBe(registered.userId);
    const renewed = await database.query<{ idle_expires_at: Date; absolute_expires_at: Date }>(
      `SELECT idle_expires_at, absolute_expires_at FROM sessions WHERE id = $1`,
      [sessionId],
    );
    expect(renewed.rows[0]?.idle_expires_at.getTime()).toBe(absolute);
    expect(renewed.rows[0]?.absolute_expires_at.getTime()).toBe(absolute);

    // Rotation renews too, so it takes the same clamp.
    const changed = await repo.changePassword({
      userId: registered.userId,
      sessionId,
      currentPassword: 'correct horse battery staple',
      newPassword: 'a-fresh-passphrase-value',
      correlationId: randomUUID(),
      ipAddress: source(network),
      userAgent: AGENT,
    });
    expect(new Date(changed.session.session.idleExpiresAt).getTime()).toBe(absolute);
    const rotated = await database.query<{ idle_expires_at: Date }>(
      `SELECT idle_expires_at FROM sessions WHERE id = $1`,
      [sessionId],
    );
    expect(rotated.rows[0]?.idle_expires_at.getTime()).toBe(absolute);
    clock -= 45 * 60_000;
  });

  it('records abuse counters without a nested pool checkout on a single-connection pool', async () => {
    const network = 31;
    const single = new Pool({
      ...(process.env.TEST_DATABASE_URL === undefined ? {} : { connectionString: process.env.TEST_DATABASE_URL }),
      max: 1,
      connectionTimeoutMillis: 2_000,
      options: `-c search_path=${schema},public`,
    });
    try {
      const repo = new PostgresAuthRepository(single, { secret: SECRET, policy: policy(), now });
      const result = await repo.requestPasswordReset({
        email: `unknown-${randomUUID()}@example.invalid`,
        correlationId: randomUUID(),
        ipAddress: source(network),
        userAgent: AGENT,
      });
      expect(result).toMatchObject({ accepted: true, issued: false });

      const counters = await single.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM auth_attempt_counters WHERE scope_kind = 'reset_target'`,
      );
      expect(counters.rows[0]?.total).toBeGreaterThan(0);
    } finally {
      await single.end();
    }
  });

  it('prunes expired abuse windows without removing the active one', async () => {
    const network = 29;
    const repo = repository();
    // Counters created by earlier scenarios already sit in the past because this
    // suite moves one shared clock forward; the assertion below is about *this*
    // window and its retention, so start from an empty table.
    await database.query('DELETE FROM auth_attempt_counters');
    await repo.login({
      email: `nobody-${randomUUID()}@example.invalid`,
      password: 'not-the-passphrase',
      correlationId: randomUUID(),
      ipAddress: source(network),
    }).catch(() => undefined);

    const before = await database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM auth_attempt_counters WHERE scope_kind = 'login_ip'`,
    );
    expect(Number(before.rows[0]?.count)).toBeGreaterThan(0);
    expect(await repo.pruneAbuseCounters()).toBe(0);

    clock += BASE_POLICY.abuse.windowMs * (BASE_POLICY.abuse.retentionWindows + 1);
    expect(await repo.pruneAbuseCounters()).toBeGreaterThan(0);
    const after = await database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM auth_attempt_counters`,
    );
    expect(after.rows[0]?.count).toBe('0');
  });

  /**
   * F-3 — an unauthenticated caller could exhaust a victim's password-reset budget.
   *
   * Measured before this change: both reset endpoints spend `reset_target`, `reset_ip`
   * and the cumulative `verification_target` budget *before* any account or challenge
   * lookup, and the two target-scoped counters were keyed on the address alone. Ten
   * wrong-code submissions against a known address — from any network, with no account
   * and no code — therefore answered `429` to the address owner's own correct code for
   * the rest of the window: denial of password recovery, externally reachable, no
   * authentication required.
   *
   * The spend cannot move after the lookup without creating an existence oracle (a
   * `429` that appears only for live accounts *is* the answer), so the fix confines the
   * counter to the caller's network instead (`targetNetworkKey`). The cases below are
   * the reproduction, the proof, and the residual limitation.
   */
  /**
   * F-3 — an unauthenticated caller could exhaust a victim's password-reset budget.
   *
   * Measured before this change: both reset endpoints spend `reset_target`, `reset_ip`
   * and the cumulative `verification_target` budget *before* any account or challenge
   * lookup, and the two target-scoped counters were keyed on the address alone. Ten
   * wrong-code submissions against a known address — from any network, with no account
   * and no code — therefore answered `429` to the address owner's own correct code for
   * the rest of the window: denial of password recovery, externally reachable, no
   * authentication required.
   *
   * The spend cannot move after the lookup without creating an existence oracle (a
   * `429` that appears only for live accounts *is* the answer), so the fix confines the
   * counter to the caller's network instead (`targetNetworkKey`). The cases below are
   * the reproduction, the proof, and the residual limitation.
   *
   * Each case takes its own `/24`s: the suite's clock is frozen, so the per-network
   * windows are shared state and reusing a network across cases would let one case's
   * spend throttle the next.
   */
  describe('F-3 — reset budget under an anonymous flood', () => {
    /** Budget below the per-challenge cap (5), so the challenge survives the flood. */
    const BUDGET = 3;

    /** A policy whose cumulative budget binds before the per-challenge cap does. */
    const budgetRepository = (extra: Partial<AuthAccessPolicy['challenge']> = {}) => repository({
      challenge: {
        verifyCumulativeMaximum: BUDGET,
        verifyCumulativeWindowMs: 60 * 60 * 1_000,
        ...extra,
      },
    });

    async function victimWithLiveChallenge(repo: PostgresAuthRepository, network: number) {
      const invitation = await invite();
      const email = `f3-victim-${randomUUID()}@example.invalid`;
      await register(repo, invitation.code, email, network);
      const requested = await repo.requestPasswordReset({
        email,
        correlationId: randomUUID(),
        ipAddress: source(network),
        userAgent: AGENT,
      });
      expect(requested.issued).toBe(true);
      return { email, code: requested.delivery!.oneTimeCode };
    }

    const wrongCodeFor = (code: string) => (code === '000000' ? '111111' : '000000');

    const attempt = (
      repo: PostgresAuthRepository,
      email: string,
      code: string,
      network: number,
      password: string,
    ) => repo.resetPassword({
      email,
      oneTimeCode: code,
      newPassword: password,
      correlationId: randomUUID(),
      ipAddress: source(network),
      userAgent: AGENT,
    }).then(() => 'accepted').catch((error: { code: string }) => error.code);

    it('the flood spends the attacker\'s own budget and the victim still completes the reset', async () => {
      const repo = budgetRepository();
      const { email, code } = await victimWithLiveChallenge(repo, 302);
      const password = 'flood-proof-passphrase-1';

      for (let index = 0; index < BUDGET; index += 1) {
        expect(await attempt(repo, email, wrongCodeFor(code), 301, password))
          .toBe('AUTH_CHALLENGE_INVALID');
      }

      // The sender is still throttled — the control that stops one network guessing
      // without limit, and the fix does not remove it.
      expect(await attempt(repo, email, wrongCodeFor(code), 301, password))
        .toBe('AUTH_RATE_LIMITED');

      // The victim, on their own network, is inside the per-challenge cap (3 < 5) and
      // their budget was never spent. Before the fix this answered `429`: that was F-3.
      const completed = await repo.resetPassword({
        email,
        oneTimeCode: code,
        newPassword: password,
        correlationId: randomUUID(),
        ipAddress: source(302),
        userAgent: AGENT,
      });
      expect(completed.userId).toBeTruthy();
    });

    it('a flood on the request endpoint cannot stop the victim completing a reset', async () => {
      const repo = budgetRepository();
      const invitation = await invite();
      const email = `f3-request-${randomUUID()}@example.invalid`;
      await register(repo, invitation.code, email, 312);
      const request = (network: number) => repo.requestPasswordReset({
        email,
        correlationId: randomUUID(),
        ipAddress: source(network),
        userAgent: AGENT,
      });

      // `reset_target` is shared by both reset endpoints, so exhausting it through
      // `requestPasswordReset` used to deny the victim's continuation as well. The
      // flood's first call does issue a code — to the victim's own mailbox, which is
      // the only place a reset code can go — and the rest fall inside the 60-second
      // resend cooldown.
      for (let index = 0; index < BASE_POLICY.abuse.resetMaximumRequests; index += 1) {
        const flooded = await request(311);
        expect(flooded.accepted, 'generic by design: issued and not-issued look identical').toBe(true);
      }

      // The victim's own request inside the cooldown is not re-sent — that is the
      // shipped cooldown, not the attacker's spend — and it is neither an error nor a
      // rate limit. The counters the attacker burned belong to the attacker's network.
      const duringCooldown = await request(312);
      expect(duringCooldown.accepted).toBe(true);
      expect(duringCooldown.issued).toBe(false);

      // Once the cooldown elapses the victim obtains a code normally and completes the
      // reset. Nothing the attacker spent here is charged to the victim.
      clock += BASE_POLICY.challenge.resendCooldownMs + 1;
      const afterCooldown = await request(312);
      expect(afterCooldown.issued).toBe(true);

      const completed = await repo.resetPassword({
        email,
        oneTimeCode: afterCooldown.delivery!.oneTimeCode,
        newPassword: 'flood-proof-passphrase-2',
        correlationId: randomUUID(),
        ipAddress: source(312),
        userAgent: AGENT,
      });
      expect(completed.userId).toBeTruthy();
    });

    it('answers known and unknown addresses identically at the exhaustion boundary', async () => {
      // The anti-enumeration property the fix must not disturb: because the counter is
      // spent before any lookup, the `429` lands on exactly the same call whether or not
      // the address exists.
      const repo = budgetRepository();
      const { email: known } = await victimWithLiveChallenge(repo, 322);
      const unknown = `f3-unknown-${randomUUID()}@example.invalid`;
      const password = 'flood-proof-passphrase-3';

      const flood = async (email: string, network: number) => {
        const outcomes: string[] = [];
        for (let index = 0; index < BUDGET + 2; index += 1) {
          outcomes.push(await attempt(repo, email, wrongCodeFor('000000'), network, password));
        }
        return outcomes;
      };

      const knownOutcomes = await flood(known, 321);
      const unknownOutcomes = await flood(unknown, 323);
      expect(knownOutcomes).toEqual(unknownOutcomes);
      expect(knownOutcomes.slice(0, BUDGET))
        .toEqual(Array.from({ length: BUDGET }, () => 'AUTH_CHALLENGE_INVALID'));
      expect(knownOutcomes.at(-1)).toBe('AUTH_RATE_LIMITED');
    });

    it('counts concurrent flood requests without losing one', async () => {
      // `maximumAttempts` is raised here so the per-challenge cap cannot retire the
      // challenge mid-run: this case measures counter integrity, and the challenge cap
      // throws its own, different error, which would otherwise mask it.
      const repo = budgetRepository({ maximumAttempts: 10 });
      const { email } = await victimWithLiveChallenge(repo, 332);
      const concurrency = 12;
      const password = 'flood-proof-passphrase-4';

      // Two attacker networks, six requests each, all in flight together. The counter is
      // an atomic `INSERT … ON CONFLICT … RETURNING`, so a lost update would surface here
      // as an extra request answered on its merits instead of being throttled.
      const outcomes = await Promise.all(Array.from({ length: concurrency }, (_, index) => (
        attempt(repo, email, wrongCodeFor('000000'), 331 + (index % 2), password)
      )));

      expect(outcomes.filter((outcome) => outcome === 'AUTH_CHALLENGE_INVALID'))
        .toHaveLength(2 * BUDGET);
      expect(outcomes.filter((outcome) => outcome === 'AUTH_RATE_LIMITED'))
        .toHaveLength(concurrency - 2 * BUDGET);
    });

    it('a distributed flood across several networks is still bounded by the challenge, not by geography', async () => {
      // Three networks, each kept inside its own cumulative budget, so the only limit
      // left standing is the account-scoped per-challenge cap. This is the case the
      // fix must not have broken: distribution buys per-network budgets, never extra
      // code guesses.
      const repo = budgetRepository();
      const { email, code } = await victimWithLiveChallenge(repo, 362);
      const password = 'flood-proof-passphrase-7';
      const attackerNetworks = [361, 363, 364];
      const wrong = wrongCodeFor(code);

      const outcomes: string[] = [];
      for (const network of attackerNetworks) {
        for (let index = 0; index < BUDGET; index += 1) {
          outcomes.push(await attempt(repo, email, wrong, network, password));
        }
        // One past this network's own budget: throttled on its own bucket.
        outcomes.push(await attempt(repo, email, wrong, network, password));
      }

      // Exactly one submission retires the challenge — the sixth failure, whatever
      // network it came from. Everything after it is generically invalid or
      // throttled, and can no longer be compared against the code.
      expect(outcomes.filter((outcome) => outcome === 'AUTH_CHALLENGE_ATTEMPTS_EXHAUSTED'))
        .toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'AUTH_RATE_LIMITED').length)
        .toBeGreaterThanOrEqual(attackerNetworks.length);

      // The direct measurement: however many networks join in, only five submissions
      // were ever evaluated against this challenge's digest.
      const challenge = await database.query<{ attempt_count: number; superseded_at: Date | null }>(
        `SELECT attempt_count, superseded_at
           FROM auth_challenges
          WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)
            AND purpose = 'password_reset'
          ORDER BY created_at
          LIMIT 1`,
        [email],
      );
      expect(challenge.rows[0]?.attempt_count).toBe(BASE_POLICY.challenge.maximumAttempts);
      expect(challenge.rows[0]?.superseded_at).not.toBeNull();

      // And the victim is not locked out by any of it: a fresh code, obtained after
      // the cooldown, completes the reset.
      clock += BASE_POLICY.challenge.resendCooldownMs + 1;
      const fresh = await repo.requestPasswordReset({
        email,
        correlationId: randomUUID(),
        ipAddress: source(362),
        userAgent: AGENT,
      });
      expect(fresh.issued).toBe(true);
      const completed = await repo.resetPassword({
        email,
        oneTimeCode: fresh.delivery!.oneTimeCode,
        newPassword: password,
        correlationId: randomUUID(),
        ipAddress: source(362),
        userAgent: AGENT,
      });
      expect(completed.userId).toBeTruthy();
    });

    it('records one operator-visible event when a budget tips over, not one per request', async () => {
      const repo = budgetRepository();
      const { email, code } = await victimWithLiveChallenge(repo, 342);
      const password = 'flood-proof-passphrase-5';

      for (let index = 0; index < BUDGET + 3; index += 1) {
        await attempt(repo, email, wrongCodeFor(code), 341, password);
      }

      const events = await database.query<{
        outcome: string; visibility: string; metadata: Record<string, unknown>;
      }>(
        `SELECT outcome, visibility, metadata
           FROM security_events
          WHERE event_type = 'password_reset_failed' AND target_digest = $1
          ORDER BY occurred_at`,
        [keyedDigest(SECRET, 'event-target', email)],
      );
      const exhausted = events.rows.filter((row) => row.metadata?.reason === 'reset_budget_exhausted');
      expect(exhausted, 'exactly the transition is recorded, however long the flood runs').toHaveLength(1);
      expect(exhausted[0]?.outcome).toBe('blocked');
      expect(exhausted[0]?.visibility, 'never surfaced to the account holder').toBe('operator');
    });

    it('residual limitation: without a resolvable caller address the budget falls back to the account-only key', async () => {
      // Documented, not fixed. `registerAbuseAttempt` skips a scope whose value is
      // absent, and `targetNetworkKey` degrades to the bare target, so a caller that
      // arrives with no address writes — and shares — the pre-fix, account-only
      // bucket, and the per-network `reset_ip` throttle does not apply at all.
      // Asserted so the fallback is a stated property rather than an assumption.
      const repo = budgetRepository();
      const invitation = await invite();
      const email = `f3-no-address-${randomUUID()}@example.invalid`;
      await register(repo, invitation.code, email, 371);
      const requested = await repo.requestPasswordReset({
        email,
        correlationId: randomUUID(),
        userAgent: AGENT,
      });
      expect(requested.issued).toBe(true);
      const { oneTimeCode } = requested.delivery!;
      const password = 'flood-proof-passphrase-8';
      const wrong = wrongCodeFor(oneTimeCode);
      const addresslessAttempt = (code: string) => repo.resetPassword({
        email,
        oneTimeCode: code,
        newPassword: password,
        correlationId: randomUUID(),
        userAgent: AGENT,
      }).then(() => 'accepted').catch((error: { code: string }) => error.code);

      for (let index = 0; index < BUDGET; index += 1) {
        expect(await addresslessAttempt(wrong)).toBe('AUTH_CHALLENGE_INVALID');
      }
      expect(await addresslessAttempt(wrong), 'addressless callers share one bucket').toBe('AUTH_RATE_LIMITED');

      // The fallback is confined to that path: the same account, reset from a real
      // network, is unaffected, and its code still works.
      const completed = await repo.resetPassword({
        email,
        oneTimeCode,
        newPassword: password,
        correlationId: randomUUID(),
        ipAddress: source(372),
        userAgent: AGENT,
      });
      expect(completed.userId).toBeTruthy();
    });

    it('residual limitation: an attacker sharing the victim\'s network still shares the bucket', async () => {
      // Documented, not fixed. Network scoping removes the *remote* denial; a caller
      // inside the same /24 (shared office, CGNAT, or the victim's own uplink) is
      // indistinguishable from the victim and shares their counter. Asserted so the
      // limitation cannot later be mistaken for an oversight.
      const repo = budgetRepository();
      const { email, code } = await victimWithLiveChallenge(repo, 352);
      const password = 'flood-proof-passphrase-6';

      for (let index = 0; index < BUDGET; index += 1) {
        await attempt(repo, email, wrongCodeFor(code), 352, password);
      }

      expect(await attempt(repo, email, code, 352, password)).toBe('AUTH_RATE_LIMITED');
    });
  });
});
