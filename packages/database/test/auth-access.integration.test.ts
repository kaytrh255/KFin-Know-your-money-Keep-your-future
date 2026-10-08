import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresAuthRepository,
  keyedDigest,
  migrateDatabase,
  type AuthAccessPolicy,
  type RegisterResult,
  type VerificationDelivery,
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
    resetSecretEntropyBytes: 32,
    resetLifetimeMs: 30 * 60 * 1_000,
    hourlyIssuanceCap: 5,
    dailyIssuanceCap: 12,
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
    verificationMaximumAttempts: 20,
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
  ): Promise<RegisterResult & { userId: string; delivery: VerificationDelivery }> {
    const result = await repo.register({
      email,
      password: 'correct horse battery staple',
      invitationCode: code,
      ...profile,
      correlationId: randomUUID(),
      ipAddress: source(network),
      userAgent: AGENT,
    });
    if (!result.userId || !result.delivery) {
      throw new Error('access fixture: registration was not issued for a fresh address');
    }
    return result as RegisterResult & { userId: string; delivery: VerificationDelivery };
  }

  it('registers with an invitation, verifies, and authenticates a session', async () => {
    const network = 11;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    expect(registered.issued).toBe(true);
    expect(registered.delivery.oneTimeCode).toMatch(/^[0-9]{6}$/);

    const pending = await database.query<{ status: string; email_verified_at: Date | null }>(
      `SELECT status, email_verified_at FROM users WHERE id = $1`,
      [registered.userId],
    );
    expect(pending.rows[0]).toMatchObject({ status: 'pending_verification', email_verified_at: null });

    const verified = await repo.verifyEmail({
      email,
      oneTimeCode: registered.delivery.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
      userAgent: AGENT,
    });
    expect(verified.status).toBe('active');

    const principal = await repo.authenticate(verified.session.sessionToken);
    expect(principal?.userId).toBe(registered.userId);
    expect(principal?.sessionId).toBe(verified.session.session.id);
    expect(repo.verifyCsrfToken(verified.session.csrfToken, principal!.csrfDigest)).toBe(true);
    expect(repo.verifyCsrfToken('another-value', principal!.csrfDigest)).toBe(false);

    const active = await database.query<{ status: string }>(
      `SELECT status FROM users WHERE id = $1`,
      [registered.userId],
    );
    expect(active.rows[0]?.status).toBe('active');

    const profileView = await repo.getProfile(registered.userId);
    expect(profileView).toMatchObject({ email, status: 'active', baseCurrency: 'VND' });
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

    const challenge = await database.query<{ secret_digest: Buffer; target_digest: Buffer }>(
      `SELECT secret_digest, target_digest FROM auth_challenges WHERE id = $1`,
      [registered.delivery.challengeId],
    );
    expect(challenge.rows[0]?.secret_digest.equals(
      keyedDigest(SECRET, 'challenge-secret:email_verification', registered.delivery.oneTimeCode),
    )).toBe(true);
    expect(challenge.rows[0]?.target_digest.equals(
      keyedDigest(SECRET, 'challenge-target:email_verification', email.toLowerCase()),
    )).toBe(true);
    expect(challenge.rows[0]?.secret_digest.equals(
      keyedDigest(SECRET, 'challenge-secret:email_verification', '000000'),
    )).toBe(false);

    const credential = await database.query<{ password_hash: string }>(
      `SELECT password_hash FROM password_credentials WHERE user_id = $1`,
      [registered.userId],
    );
    expect(credential.rows[0]?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(credential.rows[0]?.password_hash).not.toContain('correct horse battery staple');
  });

  it('rejects a used OTP, expires an old challenge, and limits attempts generically', async () => {
    const network = 15;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    const code = registered.delivery.oneTimeCode;

    const verified = await repo.verifyEmail({
      email,
      oneTimeCode: code,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(verified.status).toBe('active');

    await expect(repo.verifyEmail({
      email,
      oneTimeCode: code,
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });

    const wrongInvitation = await invite();
    const wrongEmail = `beta-${randomUUID()}@example.invalid`;
    const wrongRegistered = await register(repo, wrongInvitation.code, wrongEmail, network);
    for (let attempt = 0; attempt < BASE_POLICY.challenge.maximumAttempts; attempt += 1) {
      await expect(repo.verifyEmail({
        email: wrongEmail,
        oneTimeCode: '000000',
        correlationId: randomUUID(),
        ipAddress: source(network),
      })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });
    }
    await expect(repo.verifyEmail({
      email: wrongEmail,
      oneTimeCode: '000000',
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_ATTEMPTS_EXHAUSTED' });
    expect(wrongRegistered.delivery?.oneTimeCode).toBeTruthy();

    const expiring = repository({ challenge: { otpLifetimeMs: 1 } });
    const expiringInvitation = await invite();
    const expiringEmail = `beta-${randomUUID()}@example.invalid`;
    const expiringRegistered = await register(expiring, expiringInvitation.code, expiringEmail, network);
    clock += 5;
    await expect(expiring.verifyEmail({
      email: expiringEmail,
      oneTimeCode: expiringRegistered.delivery!.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_EXPIRED' });
    clock -= 5;
  });

  it('supersedes a resent code so only the newest challenge is usable', async () => {
    const network = 16;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);

    const withinCooldown = await repo.resendVerification({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(withinCooldown).toMatchObject({ accepted: true, issued: false });

    clock += BASE_POLICY.challenge.resendCooldownMs + 1;
    const resent = await repo.resendVerification({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(resent.issued).toBe(true);
    expect(resent.delivery?.oneTimeCode).toMatch(/^[0-9]{6}$/);

    await expect(repo.verifyEmail({
      email,
      oneTimeCode: registered.delivery.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });

    const verified = await repo.verifyEmail({
      email,
      oneTimeCode: resent.delivery!.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(verified.status).toBe('active');
  });

  it('answers unknown and known login failures identically and limits abuse', async () => {
    const network = 17;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    await repo.verifyEmail({
      email,
      oneTimeCode: registered.delivery.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });

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
    const expiringVerified = await expiring.verifyEmail({
      email: expiringEmail,
      oneTimeCode: expiringRegistered.delivery!.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(expiringNetwork),
    });
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
    const verified = await repo.verifyEmail({
      email,
      oneTimeCode: registered.delivery.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
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
    expect(await repo.logout(relogin.session.session.id, {
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
    const verificationToken = (await repo.verifyEmail({
      email,
      oneTimeCode: registered.delivery.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
    })).session.sessionToken;
    const first = await repo.login({
      email,
      password: 'correct horse battery staple',
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    const second = await repo.login({
      email,
      password: 'correct horse battery staple',
      correlationId: randomUUID(),
      ipAddress: source(network),
    });

    const requested = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(requested).toMatchObject({ accepted: true, issued: true });
    expect(requested.delivery?.resetSecret.length).toBeGreaterThanOrEqual(43);

    const reset = await repo.resetPassword({
      email,
      resetSecret: requested.delivery!.resetSecret,
      newPassword: 'reset-passphrase-value-1',
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    // Verification issued a session too; a reset revokes every one of them.
    expect(reset.sessionsRevoked).toBe(3);
    expect(await repo.authenticate(verificationToken)).toBeNull();
    expect(await repo.authenticate(first.session.sessionToken)).toBeNull();
    expect(await repo.authenticate(second.session.sessionToken)).toBeNull();

    await expect(repo.resetPassword({
      email,
      resetSecret: requested.delivery!.resetSecret,
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

  it('answers a reset request generically for unknown and unavailable accounts', async () => {
    const network = 24;
    const repo = repository();
    const unknown = await repo.requestPasswordReset({
      email: `nobody-${randomUUID()}@example.invalid`,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    expect(unknown).toEqual({ accepted: true, issued: false, delivery: null });

    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    const pending = await repo.requestPasswordReset({
      email,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    // Unverified accounts receive the same generic accepted response.
    expect(pending).toEqual({ accepted: true, issued: false, delivery: null });
    expect(registered.issued).toBe(true);
  });

  it('isolates owners in session management and hides operator-only events', async () => {
    const network = 25;
    const repo = repository();
    const firstEmail = `beta-${randomUUID()}@example.invalid`;
    const secondEmail = `beta-${randomUUID()}@example.invalid`;
    const firstRegistered = await register(repo, (await invite()).code, firstEmail, network);
    const secondRegistered = await register(repo, (await invite()).code, secondEmail, network);
    const firstVerified = await repo.verifyEmail({
      email: firstEmail,
      oneTimeCode: firstRegistered.delivery!.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
    const secondVerified = await repo.verifyEmail({
      email: secondEmail,
      oneTimeCode: secondRegistered.delivery!.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });

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
    expect(types).toContain('email_verified');
    expect(types).not.toContain('verification_challenge_issued');
    expect(types).not.toContain('verification_challenge_failed');
    for (const event of events.items) {
      expect(event.sessionId === null || UUID_LIKE.test(event.sessionId)).toBe(true);
    }

    const revokedAll = await repo.logoutAll(secondRegistered.userId, {
      correlationId: randomUUID(),
      ipAddress: source(network),
    }, secondVerified.session.session.id);
    expect(revokedAll).toBe(0);
    expect(await repo.authenticate(secondVerified.session.sessionToken)).toMatchObject({
      userId: secondRegistered.userId,
    });
  });

  it('re-checks account status on every session use', async () => {
    const network = 26;
    const repo = repository();
    const invitation = await invite();
    const email = `beta-${randomUUID()}@example.invalid`;
    const registered = await register(repo, invitation.code, email, network);
    const verified = await repo.verifyEmail({
      email,
      oneTimeCode: registered.delivery.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
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
    await repo.verifyEmail({
      email,
      oneTimeCode: registered.delivery.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });
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
    await register(repo, (await invite()).code, email, network);
    const secondInvitation = await invite();

    const duplicate = await repo.register({
      email,
      password: 'correct horse battery staple',
      invitationCode: secondInvitation.code,
      ...profile,
      correlationId: randomUUID(),
      ipAddress: source(network),
    });

    expect(duplicate).toMatchObject({
      accepted: true,
      issued: false,
      userId: null,
      delivery: null,
    });

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
    const verified = await repo.verifyEmail({
      email,
      oneTimeCode: registered.delivery.oneTimeCode,
      correlationId: randomUUID(),
      ipAddress: source(network),
      userAgent: AGENT,
    });
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
});
