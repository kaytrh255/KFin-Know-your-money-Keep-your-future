import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  AuthError,
  accountUnavailableError,
  authServiceUnavailableError,
  authValidationError,
  challengeAttemptsExhaustedError,
  eventVisibility,
  expiredChallengeError,
  generateInvitationCode,
  generateNumericOtp,
  generateUrlToken,
  invalidChallengeError,
  invalidCredentialsError,
  invalidInvitationError,
  isIanaTimezone,
  isSupportedLocale,
  isUserVisibleEvent,
  invalidCredentialsError as invalidCredentials,
  normalizeEmail,
  normalizeInvitationCode,
  normalizePassword,
  rateLimitedError,
  summarizeDeviceLabel,
  validatePassword,
  abuseWindowStart,
  clampIdleExpiry,
  type AbuseScopeKind,
  type AuthEventOutcome,
  type AuthEventType,
  type NormalizedEmail,
} from '@kfin/domain';
import { constantTimeBufferEqual, keyedDigest } from './canonical.js';
import { decoyVerification, hashPassword, verifyPassword } from './passwords.js';

/**
 * Trusted Private Beta access repository.
 *
 * Trace: PRD-AUTH-01..09, SEC-AUTH-01..17, SEC-SES-01..10, SEC-ABUSE-01..09,
 * DATABASE §§4.2-4.7, ADR-002, ADR-004, ADR-008.
 *
 * Rules enforced here:
 * - invitation codes, OTP/reset secrets, session tokens, CSRF tokens, and abuse
 *   scopes are stored only as purpose-separated keyed digests;
 * - every unauthenticated outcome is generic, so a missing account, a used
 *   invitation, an expired code, and a wrong password are indistinguishable;
 * - account status and verified-email state are re-checked on every session use;
 * - multi-record transitions run in one transaction (SEC-APP-06).
 *
 * Candidate policy values come from the caller (`authPolicy` in `@kfin/config`).
 * `SPEC-AUTH-01`, `SPEC-AUTH-02`, and `SPEC-SEC-02` remain OPEN: this code
 * implements one candidate branch and does not close any approval.
 */

export interface AuthAccessPolicy {
  readonly password: {
    readonly minimumLength: number;
    readonly maximumLength: number;
    readonly hashPolicyVersion: number;
    readonly argon2: {
      readonly memoryCost: number;
      readonly timeCost: number;
      readonly parallelism: number;
    };
  };
  readonly invitation: {
    readonly codeEntropyBytes: number;
    readonly codeGroupLength: number;
    readonly defaultLifetimeMs: number;
  };
  readonly challenge: {
    readonly otpDigits: number;
    readonly otpLifetimeMs: number;
    readonly maximumAttempts: number;
    readonly resendCooldownMs: number;
    readonly resetSecretEntropyBytes: number;
    readonly resetLifetimeMs: number;
    readonly hourlyIssuanceCap: number;
    readonly dailyIssuanceCap: number;
  };
  readonly session: {
    readonly tokenEntropyBytes: number;
    readonly csrfEntropyBytes: number;
    readonly idleLifetimeMs: number;
    readonly absoluteLifetimeMs: number;
    readonly rotationGraceMs: number;
    readonly lastSeenThrottleMs: number;
  };
  readonly abuse: {
    readonly windowMs: number;
    readonly loginMaximumFailures: number;
    readonly verificationMaximumAttempts: number;
    readonly resetMaximumRequests: number;
    readonly registrationMaximumPerWindow: number;
    readonly retentionWindows: number;
  };
}

export interface AccessRequestContext {
  readonly correlationId: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly clientType?: 'web' | 'pwa';
}

export interface AuthSessionView {
  readonly id: string;
  readonly clientType: 'web' | 'pwa' | 'native';
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly deviceLabel: string | null;
  readonly current: boolean;
}

export interface IssuedSession {
  readonly session: AuthSessionView;
  /** Plaintext bearer token. Never persisted; returned once for the cookie. */
  readonly sessionToken: string;
  /** Plaintext CSRF token. Never persisted server-side, only its digest. */
  readonly csrfToken: string;
}

export type AccountStatus =
  | 'pending_verification'
  | 'active'
  | 'locked'
  | 'disabled'
  | 'deletion_pending';

export interface ProfileView {
  readonly userId: string;
  readonly email: string;
  readonly status: AccountStatus;
  readonly emailVerifiedAt: string | null;
  readonly displayName: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly baseCurrency: string;
}

export interface AccessPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  /** Hex digest of the CSRF token bound to this session. */
  readonly csrfDigest: string;
}

export interface IssueInvitationInput {
  readonly invitedEmail?: string | null;
  readonly createdByOperatorId: string;
  readonly correlationId: string;
  readonly lifetimeMs?: number;
}

export interface IssuedInvitation {
  readonly invitationId: string;
  /** Plaintext single-use code. Never persisted; returned once for delivery. */
  readonly code: string;
  readonly expiresAt: string;
}

export interface RegisterInput extends AccessRequestContext {
  readonly email: string;
  readonly password: string;
  readonly invitationCode: string;
  readonly displayName?: string;
  readonly locale: string;
  readonly timezone: string;
  readonly baseCurrency: string;
}

export interface VerificationDelivery {
  readonly challengeId: string;
  /** Plaintext OTP held only in request-process memory for immediate delivery. */
  readonly oneTimeCode: string;
  readonly expiresAt: string;
}

/**
 * Registration never reports whether the email already existed: an existing
 * address, a consumed invitation, and a fresh registration all return the same
 * `accepted` outcome (UF-AUTH-01, SEC-AUTH-04).
 */
export interface RegisterResult {
  readonly accepted: true;
  readonly issued: boolean;
  readonly resendAvailableAt: string;
  readonly delivery: VerificationDelivery | null;
  /** Null when the registration was not performed; never exposed by the API. */
  readonly userId: string | null;
}

export interface ResendVerificationInput extends AccessRequestContext {
  readonly email: string;
}

export interface ResendVerificationResult {
  readonly accepted: true;
  readonly issued: boolean;
  readonly resendAvailableAt: string;
  readonly delivery: VerificationDelivery | null;
}

export interface VerifyEmailInput extends AccessRequestContext {
  readonly email: string;
  readonly oneTimeCode: string;
}

export interface VerifyEmailResult {
  readonly userId: string;
  readonly status: 'active';
  readonly session: IssuedSession;
}

export interface LoginInput extends AccessRequestContext {
  readonly email: string;
  readonly password: string;
}

export interface LoginResult {
  readonly userId: string;
  readonly session: IssuedSession;
}

export interface SessionPage {
  readonly items: readonly AuthSessionView[];
  readonly nextCursor: string | null;
}

export interface SecurityEventView {
  readonly id: string;
  readonly eventType: AuthEventType;
  readonly outcome: AuthEventOutcome;
  readonly occurredAt: string;
  readonly sessionId: string | null;
}

export interface SecurityEventPage {
  readonly items: readonly SecurityEventView[];
  readonly nextCursor: string | null;
}

export interface RequestPasswordResetInput extends AccessRequestContext {
  readonly email: string;
}

export interface RequestPasswordResetResult {
  readonly accepted: true;
  readonly issued: boolean;
  readonly delivery: { readonly challengeId: string; readonly resetSecret: string; readonly expiresAt: string } | null;
}

export interface ResetPasswordInput extends AccessRequestContext {
  readonly email: string;
  readonly resetSecret: string;
  readonly newPassword: string;
}

export interface ResetPasswordResult {
  readonly userId: string;
  readonly sessionsRevoked: number;
}

export interface ChangePasswordInput extends AccessRequestContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface ChangePasswordResult {
  readonly session: IssuedSession;
  readonly revokedOtherSessions: number;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const FORBIDDEN_METADATA_KEYS = ['password', 'otp', 'code', 'token', 'secret', 'sessionToken'];

interface UserAuthRow extends QueryResultRow {
  id: string;
  status: string;
  email_verified_at: Date | null;
  password_hash: string | null;
}

interface ChallengeRow extends QueryResultRow {
  id: string;
  user_id: string | null;
  purpose: 'email_verification' | 'password_reset';
  secret_digest: Buffer;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  superseded_at: Date | null;
  attempt_count: number;
  max_attempts: number;
}

interface ProfileRow extends QueryResultRow {
  id: string;
  email: string;
  status: AccountStatus;
  email_verified_at: Date | null;
  display_name: string | null;
  locale: string;
  timezone: string;
  base_currency: string;
}

interface SessionRow extends QueryResultRow {
  id: string;
  user_id: string;
  client_type: 'web' | 'pwa' | 'native';
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  device_label: string | null;
  revoked_at: Date | null;
  csrf_digest: Buffer;
  user_status: string;
  email_verified_at: Date | null;
  token_retired_at: Date | null;
  token_grace_expires_at: Date | null;
  generation: number;
}

export class PostgresAuthRepository {
  constructor(
    private readonly pool: Pick<Pool, 'query' | 'connect'>,
    private readonly options: {
      readonly secret: string;
      readonly policy: AuthAccessPolicy;
      readonly now?: () => number;
    },
  ) {}

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  private get hashPolicy() {
    return {
      memoryCost: this.options.policy.password.argon2.memoryCost,
      timeCost: this.options.policy.password.argon2.timeCost,
      parallelism: this.options.policy.password.argon2.parallelism,
      hashPolicyVersion: this.options.policy.password.hashPolicyVersion,
    };
  }

  /**
   * Operator-audited invitation provisioning. There is deliberately no HTTP
   * route: codes reach users through the reviewed operator channel only
   * (DATABASE §4.2, SEC-AUTH-14).
   */
  async issueInvitation(input: IssueInvitationInput): Promise<IssuedInvitation> {
    const invitationId = randomUUID();
    const code = generateInvitationCode(
      this.options.policy.invitation.codeEntropyBytes,
      this.options.policy.invitation.codeGroupLength,
    );
    const expiresAt = new Date(this.now() + (input.lifetimeMs ?? this.options.policy.invitation.defaultLifetimeMs));
    const invitedEmail = input.invitedEmail ? normalizeEmail(input.invitedEmail) : null;
    if (input.invitedEmail && !invitedEmail) throw authValidationError('The invited email address is invalid.');
    await this.pool.query(
      `INSERT INTO beta_invitations (
         id, code_digest, invited_email_normalized, expires_at, created_by_operator_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        invitationId,
        this.digest('invitation-code', normalizeInvitationCode(code)),
        invitedEmail?.emailNormalized ?? null,
        expiresAt,
        input.createdByOperatorId,
        new Date(this.now()),
      ],
    );
    return { invitationId, code, expiresAt: expiresAt.toISOString() };
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    const email = this.requireEmail(input.email);
    this.assertPassword(input.password, email);
    this.assertProfile(input);

    const now = this.now();
    // Abuse evidence is recorded before the operation connection is taken:
    // a nested checkout would make an exhausted pool wait on the very
    // transactions that are waiting for it (SEC-ABUSE-08/09).
    await this.registerAbuseAttempt('registration_ip', input.ipAddress ?? null, now, {
      limit: this.options.policy.abuse.registrationMaximumPerWindow,
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const invitation = await client.query<{ id: string; status: string; expires_at: Date; invited_email_normalized: string | null }>(
        `SELECT id, status, expires_at, invited_email_normalized
           FROM beta_invitations
          WHERE code_digest = $1
          FOR UPDATE`,
        [this.digest('invitation-code', normalizeInvitationCode(input.invitationCode))],
      );
      const invitationRow = invitation.rows[0];
      if (!invitationRow) {
        await this.rollback(client);
        throw invalidInvitationError();
      }
      if (
        invitationRow.status !== 'active'
        || invitationRow.expires_at.getTime() <= now
        || (invitationRow.invited_email_normalized !== null
          && invitationRow.invited_email_normalized !== email.emailNormalized)
      ) {
        await this.rollback(client);
        // Expired, consumed, revoked, and wrong-email states are externally
        // identical (SEC-AUTH-14/15).
        throw invalidInvitationError();
      }

      const userId = randomUUID();
      const resendAvailableAt = new Date(now + this.options.policy.challenge.resendCooldownMs).toISOString();
      try {
        await client.query(
          `INSERT INTO users (
             id, email, email_normalized, display_name, locale, timezone, base_currency, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_verification')`,
          [
            userId,
            email.email,
            email.emailNormalized,
            input.displayName?.trim() ?? null,
            input.locale,
            input.timezone,
            input.baseCurrency,
          ],
        );
      } catch (error) {
        await this.rollback(client);
        if (sqlstateOf(error) !== '23505') throw error;
        // The invitation consumption is rolled back with the insert, so a
        // duplicate email leaves nothing behind and answers generically.
        await this.recordBlockedRegistration(client, input, now);
        return { accepted: true, issued: false, resendAvailableAt, delivery: null, userId: null };
      }

      const consumedAt = new Date(now);
      await client.query(
        `UPDATE beta_invitations
            SET status = 'consumed', consumed_at = $2, consumed_by_user_id = $3
          WHERE id = $1`,
        [invitationRow.id, consumedAt, userId],
      );

      await client.query(
        `INSERT INTO password_credentials (
           user_id, password_hash, password_changed_at, hash_policy_version, updated_at
         ) VALUES ($1, $2, $3, $4, $3)`,
        [
          userId,
          await hashPassword(normalizePassword(input.password), this.hashPolicy),
          new Date(now),
          this.hashPolicy.hashPolicyVersion,
        ],
      );

      const delivery = await this.issueChallenge(client, {
        userId,
        purpose: 'email_verification',
        target: email.emailNormalized,
        context: input,
        now,
      });

      await this.recordEvent(client, {
        userId,
        eventType: 'registration_requested',
        outcome: 'success',
        correlationId: input.correlationId,
        context: input,
        occurredAt: new Date(now),
        metadata: { invitationId: invitationRow.id },
      });
      await this.recordEvent(client, {
        userId,
        eventType: 'verification_challenge_issued',
        outcome: 'success',
        correlationId: input.correlationId,
        context: input,
        occurredAt: new Date(now),
        metadata: { challengeId: delivery.challengeId, purpose: 'email_verification' },
      });

      await client.query('COMMIT');
      return { accepted: true, issued: true, resendAvailableAt, delivery, userId };
    } catch (error) {
      await this.safeRollback(client, error);
      throw error;
    } finally {
      client.release();
    }
  }

  async resendVerification(input: ResendVerificationInput): Promise<ResendVerificationResult> {
    const email = normalizeEmail(input.email);
    const target = email?.emailNormalized ?? input.email.trim().toLowerCase();
    const now = this.now();
    // Abuse evidence is recorded before the operation connection is taken:
    // a nested checkout would make an exhausted pool wait on the very
    // transactions that are waiting for it (SEC-ABUSE-08/09).
    await this.registerAbuseAttempt('verification_target', target, now, {
      limit: this.options.policy.abuse.verificationMaximumAttempts,
      target,
    });
    await this.registerAbuseAttempt('verification_ip', input.ipAddress ?? null, now, {
      limit: this.options.policy.abuse.verificationMaximumAttempts,
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const resendAvailableAt = new Date(now + this.options.policy.challenge.resendCooldownMs).toISOString();
      if (!email) {
        await this.recordEvent(client, {
          userId: null,
          eventType: 'verification_challenge_issued',
          outcome: 'blocked',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          metadata: { reason: 'invalid_target' },
        });
        await client.query('COMMIT');
        return { accepted: true, issued: false, resendAvailableAt, delivery: null };
      }

      const user = await client.query<{ id: string; status: string; email_verified_at: Date | null }>(
        `SELECT id, status, email_verified_at FROM users WHERE email_normalized = $1`,
        [email.emailNormalized],
      );
      const userRow = user.rows[0];
      if (!userRow || userRow.email_verified_at !== null || userRow.status === 'deletion_pending') {
        await client.query('COMMIT');
        // Unknown, already-verified, and unavailable accounts receive the same
        // generic accepted response (SEC-AUTH-04).
        return { accepted: true, issued: false, resendAvailableAt, delivery: null };
      }

      const active = await client.query<ChallengeRow>(
        `SELECT id, user_id, purpose, secret_digest, issued_at, expires_at,
                consumed_at, superseded_at, attempt_count, max_attempts
           FROM auth_challenges
          WHERE user_id = $1 AND purpose = 'email_verification'
            AND consumed_at IS NULL AND superseded_at IS NULL
          ORDER BY issued_at DESC
          LIMIT 1
          FOR UPDATE`,
        [userRow.id],
      );
      const activeRow = active.rows[0];
      if (
        activeRow
        && activeRow.issued_at.getTime() + this.options.policy.challenge.resendCooldownMs > now
      ) {
        await client.query('COMMIT');
        return {
          accepted: true,
          issued: false,
          resendAvailableAt: new Date(
            activeRow.issued_at.getTime() + this.options.policy.challenge.resendCooldownMs,
          ).toISOString(),
          delivery: null,
        };
      }
      if (!(await this.withinIssuanceCap(client, userRow.id, now))) {
        await client.query('COMMIT');
        return { accepted: true, issued: false, resendAvailableAt, delivery: null };
      }

      const delivery = await this.issueChallenge(client, {
        userId: userRow.id,
        purpose: 'email_verification',
        target: email.emailNormalized,
        context: input,
        now,
      });
      await this.recordEvent(client, {
        userId: userRow.id,
        eventType: 'verification_challenge_issued',
        outcome: 'success',
        correlationId: input.correlationId,
        context: input,
        occurredAt: new Date(now),
        metadata: { challengeId: delivery.challengeId, purpose: 'email_verification', resend: true },
      });
      await client.query('COMMIT');
      return {
        accepted: true,
        issued: true,
        resendAvailableAt: new Date(now + this.options.policy.challenge.resendCooldownMs).toISOString(),
        delivery,
      };
    } catch (error) {
      await this.safeRollback(client, error);
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyEmail(input: VerifyEmailInput): Promise<VerifyEmailResult> {
    const email = this.requireEmail(input.email);
    const now = this.now();
    // Abuse evidence is recorded before the operation connection is taken:
    // a nested checkout would make an exhausted pool wait on the very
    // transactions that are waiting for it (SEC-ABUSE-08/09).
    await this.registerAbuseAttempt('verification_target', email.emailNormalized, now, {
      limit: this.options.policy.abuse.verificationMaximumAttempts,
      target: email.emailNormalized,
    });
    await this.registerAbuseAttempt('verification_ip', input.ipAddress ?? null, now, {
      limit: this.options.policy.abuse.verificationMaximumAttempts,
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const challengeResult = await client.query<ChallengeRow>(
        `SELECT id, user_id, purpose, secret_digest, issued_at, expires_at,
                consumed_at, superseded_at, attempt_count, max_attempts
           FROM auth_challenges
          WHERE purpose = 'email_verification'
            AND target_digest = $1
            AND consumed_at IS NULL
            AND superseded_at IS NULL
          ORDER BY issued_at DESC
          LIMIT 1
          FOR UPDATE`,
        [this.digest('challenge-target:email_verification', email.emailNormalized)],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge) {
        await this.recordFailureAndCommit(client, {
          userId: null,
          eventType: 'verification_challenge_failed',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          target: email.emailNormalized,
          metadata: { reason: 'no_active_challenge' },
        });
        throw invalidChallengeError();
      }
      if (challenge.expires_at.getTime() <= now) {
        await client.query(
          `UPDATE auth_challenges SET superseded_at = $2 WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
          [challenge.id, new Date(now)],
        );
        await this.recordFailureAndCommit(client, {
          userId: challenge.user_id,
          eventType: 'verification_challenge_failed',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          target: email.emailNormalized,
          metadata: { reason: 'expired' },
        });
        throw expiredChallengeError();
      }
      if (challenge.attempt_count >= challenge.max_attempts) {
        await this.recordFailureAndCommit(client, {
          userId: challenge.user_id,
          eventType: 'verification_challenge_failed',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          target: email.emailNormalized,
          metadata: { reason: 'attempts_exhausted' },
        });
        throw challengeAttemptsExhaustedError();
      }

      const presented = this.digest(
        'challenge-secret:email_verification',
        input.oneTimeCode.trim(),
      );
      if (!constantTimeBufferEqual(presented, challenge.secret_digest)) {
        await client.query(
          `UPDATE auth_challenges SET attempt_count = attempt_count + 1 WHERE id = $1`,
          [challenge.id],
        );
        await this.recordFailureAndCommit(client, {
          userId: challenge.user_id,
          eventType: 'verification_challenge_failed',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          target: email.emailNormalized,
          metadata: { reason: 'mismatch', attemptCount: challenge.attempt_count + 1 },
        });
        throw invalidChallengeError();
      }

      const consumedAt = new Date(now);
      await client.query(
        `UPDATE auth_challenges SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL`,
        [challenge.id, consumedAt],
      );

      const userResult = await client.query<{ id: string; status: string; email_verified_at: Date | null }>(
        `SELECT id, status, email_verified_at FROM users WHERE id = $1 FOR UPDATE`,
        [challenge.user_id],
      );
      const user = userResult.rows[0];
      if (!user) {
        await this.rollback(client);
        throw invalidChallengeError();
      }
      await client.query(
        `UPDATE users
            SET email_verified_at = $2,
                status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END,
                updated_at = $2,
                version = version + 1
          WHERE id = $1`,
        [user.id, consumedAt],
      );

      // SPEC-AUTH-01 candidate branch selected for this milestone: verification
      // issues one fresh rotated session. No pre-authenticated identifier exists
      // and none can be promoted (SEC-AUTH-10/16).
      const session = await this.createSession(client, {
        userId: user.id,
        context: input,
        now,
      });
      await this.recordEvent(client, {
        userId: user.id,
        eventType: 'email_verified',
        outcome: 'success',
        correlationId: input.correlationId,
        context: input,
        occurredAt: consumedAt,
        sessionId: session.session.id,
        metadata: { challengeId: challenge.id },
      });
      await client.query('COMMIT');
      return { userId: user.id, status: 'active', session };
    } catch (error) {
      await this.safeRollback(client, error);
      throw error;
    } finally {
      client.release();
    }
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const email = this.requireEmail(input.email);
    const now = this.now();
    // Abuse evidence is recorded before the operation connection is taken:
    // a nested checkout would make an exhausted pool wait on the very
    // transactions that are waiting for it (SEC-ABUSE-08/09).
    await this.registerAbuseAttempt('login_target', email.emailNormalized, now, {
      limit: this.options.policy.abuse.loginMaximumFailures,
      target: email.emailNormalized,
    });
    await this.registerAbuseAttempt('login_ip', input.ipAddress ?? null, now, {
      limit: this.options.policy.abuse.loginMaximumFailures,
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const userResult = await client.query<UserAuthRow>(
        `SELECT u.id, u.status, u.email_verified_at, c.password_hash
           FROM users u
           LEFT JOIN password_credentials c ON c.user_id = u.id
          WHERE u.email_normalized = $1`,
        [email.emailNormalized],
      );
      const user = userResult.rows[0];
      if (!user || !user.password_hash) {
        // Equalize work for unknown accounts without revealing existence.
        await decoyVerification(normalizePassword(input.password), this.hashPolicy);
        await this.recordFailureAndCommit(client, {
          userId: null,
          eventType: 'login_failed',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          target: email.emailNormalized,
          metadata: { reason: 'unknown_account' },
        });
        throw invalidCredentialsError();
      }

      const verification = await verifyPassword(
        user.password_hash,
        normalizePassword(input.password),
        this.hashPolicy,
      );
      if (!verification.valid) {
        await this.recordFailureAndCommit(client, {
          userId: user.id,
          eventType: 'login_failed',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          target: email.emailNormalized,
          metadata: { reason: 'invalid_credentials' },
        });
        throw invalidCredentialsError();
      }

      if (user.status !== 'active' || user.email_verified_at === null) {
        await this.recordFailureAndCommit(client, {
          userId: user.id,
          eventType: 'access_denied_unverified',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          target: email.emailNormalized,
          metadata: { reason: 'account_unavailable' },
        });
        throw accountUnavailableError();
      }

      if (verification.needsRehash) {
        await client.query(
          `UPDATE password_credentials
              SET password_hash = $2, hash_policy_version = $3, password_changed_at = $4, updated_at = $4
            WHERE user_id = $1`,
          [
            user.id,
            await hashPassword(normalizePassword(input.password), this.hashPolicy),
            this.hashPolicy.hashPolicyVersion,
            new Date(now),
          ],
        );
      }

      const session = await this.createSession(client, { userId: user.id, context: input, now });
      await this.recordEvent(client, {
        userId: user.id,
        eventType: 'login_succeeded',
        outcome: 'success',
        correlationId: input.correlationId,
        context: input,
        occurredAt: new Date(now),
        sessionId: session.session.id,
        metadata: {},
      });
      await client.query('COMMIT');
      return { userId: user.id, session };
    } catch (error) {
      await this.safeRollback(client, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Resolves one opaque bearer token to a principal. Returns `null` for any
   * unusable token; revocation, expiry, replay, and account state are the only
   * distinctions made internally (SEC-AUTH-11, SEC-SES-04/05).
   */
  async authenticate(token: string | null | undefined): Promise<AccessPrincipal | null> {
    if (!token || token.length < 16) return null;
    const now = this.now();
    const result = await this.pool.query<SessionRow>(
      `SELECT s.id, s.user_id, s.client_type, s.created_at, s.last_seen_at, s.idle_expires_at,
              s.absolute_expires_at, s.device_label, s.revoked_at, s.csrf_digest,
              t.retired_at AS token_retired_at, t.grace_expires_at AS token_grace_expires_at,
              t.generation, u.status AS user_status, u.email_verified_at
         FROM session_tokens t
         JOIN sessions s ON s.id = t.session_id
         JOIN users u ON u.id = s.user_id
        WHERE t.token_digest = $1
        LIMIT 1`,
      [this.digest('session-token', token)],
    );
    const row = result.rows[0];
    if (!row) return null;

    if (row.revoked_at !== null) return null;

    if (row.token_retired_at !== null) {
      const withinGrace = row.token_grace_expires_at !== null
        && row.token_grace_expires_at.getTime() > now;
      if (!withinGrace) {
        await this.containReplay(row.id, now);
        return null;
      }
    }
    if (row.absolute_expires_at.getTime() <= now || row.idle_expires_at.getTime() <= now) {
      await this.expireSession(row.id, now);
      return null;
    }
    if (row.user_status !== 'active' || row.email_verified_at === null) return null;

    if (now - row.last_seen_at.getTime() >= this.options.policy.session.lastSeenThrottleMs) {
      await this.pool.query(
        `UPDATE sessions
            SET last_seen_at = $2,
                idle_expires_at = $3,
                version = version + 1
          WHERE id = $1 AND revoked_at IS NULL`,
        [
          row.id,
          new Date(now),
          new Date(clampIdleExpiry(
            now,
            this.options.policy.session.idleLifetimeMs,
            row.absolute_expires_at,
          )),
        ],
      );
    }

    return {
      userId: row.user_id,
      sessionId: row.id,
      sessionGeneration: row.generation,
      csrfDigest: row.csrf_digest.toString('hex'),
    };
  }

  /** Verifies a presented CSRF token against the digest bound to a session. */
  verifyCsrfToken(presented: string | null | undefined, expectedDigest: string): boolean {
    if (!presented || !/^[A-Za-z0-9_-]{16,256}$/.test(presented)) return false;
    return constantTimeBufferEqual(
      Buffer.from(this.digest('csrf-token', presented).toString('hex'), 'hex'),
      Buffer.from(expectedDigest, 'hex'),
    );
  }

  async logout(sessionId: string, input: AccessRequestContext): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const userId = await this.userIdForSession(sessionId, client);
      const revoked = await this.revokeSessionRows(client, {
        userId,
        exceptSessionId: null,
        sessionId,
        reason: 'user_logout',
        now: this.now(),
      });
      if (revoked === 0) return false;
      await this.recordEvent(client, {
        userId,
        eventType: 'logout',
        outcome: 'success',
        correlationId: input.correlationId,
        context: input,
        occurredAt: new Date(this.now()),
        metadata: { revokedSessions: revoked },
      });
      return true;
    });
  }

  /**
   * Signs the user out everywhere.
   *
   * The session that issues the request is revoked with every other one: a
   * global sign-out is the response to a suspected compromise, so leaving the
   * requesting token live (and only dropping its cookie) would keep the very
   * credential the user is trying to kill. The returned count is the number of
   * sessions actually revoked, current one included (SEC-SES-06/08).
   */
  async logoutAll(userId: string, input: AccessRequestContext): Promise<number> {
    return this.withTransaction(async (client) => {
      const revoked = await this.revokeSessionRows(client, {
        userId,
        exceptSessionId: null,
        sessionId: null,
        reason: 'user_logout_all',
        now: this.now(),
      });
      await this.recordEvent(client, {
        userId,
        eventType: 'logout_all',
        outcome: 'success',
        correlationId: input.correlationId,
        context: input,
        occurredAt: new Date(this.now()),
        metadata: { revokedSessions: revoked },
      });
      return revoked;
    });
  }

  async listSessions(
    userId: string,
    options: { readonly limit: number; readonly cursor?: string; readonly currentSessionId?: string },
  ): Promise<SessionPage> {
    const limit = Math.min(Math.max(options.limit, 1), 100);
    const cursor = decodeSessionCursor(options.cursor);
    const result = await this.pool.query<SessionRow>(
      `SELECT s.id, s.user_id, s.client_type, s.created_at, s.last_seen_at, s.idle_expires_at,
              s.absolute_expires_at, s.device_label, s.revoked_at, s.csrf_digest,
              NULL::timestamptz AS token_retired_at, NULL::timestamptz AS token_grace_expires_at,
              0 AS generation, u.status AS user_status, u.email_verified_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.user_id = $1
          AND s.revoked_at IS NULL
          AND (s.created_at, s.id) < ($2::timestamptz, $3::uuid)
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $4`,
      [
        userId,
        cursor ? new Date(cursor.createdAt) : 'infinity',
        cursor ? cursor.id : 'ffffffff-ffff-4fff-bfff-ffffffffffff',
        limit + 1,
      ],
    );
    const rows = result.rows.slice(0, limit);
    const hasMore = result.rows.length > limit;
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        clientType: row.client_type,
        createdAt: row.created_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
        idleExpiresAt: row.idle_expires_at.toISOString(),
        absoluteExpiresAt: row.absolute_expires_at.toISOString(),
        deviceLabel: row.device_label,
        current: row.id === options.currentSessionId,
      })),
      nextCursor: hasMore && last
        ? encodeSessionCursor({ createdAt: last.created_at.toISOString(), id: last.id })
        : null,
    };
  }

  async revokeSession(
    userId: string,
    sessionId: string,
    input: AccessRequestContext,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const revoked = await this.revokeSessionRows(client, {
        userId,
        exceptSessionId: null,
        sessionId,
        reason: 'user_revoked',
        now: this.now(),
      });
      if (revoked === 0) return false;
      await this.recordEvent(client, {
        userId,
        eventType: 'session_revoked',
        outcome: 'success',
        correlationId: input.correlationId,
        context: input,
        occurredAt: new Date(this.now()),
        sessionId,
        metadata: { revokedSessions: revoked },
      });
      return true;
    });
  }

  async changePassword(input: ChangePasswordInput): Promise<ChangePasswordResult> {
    const email = await this.emailForUser(input.userId);
    this.assertPassword(input.newPassword, email ?? undefined);
    const now = this.now();
    return this.withTransaction(async (client) => {
      const credential = await client.query<UserAuthRow>(
        `SELECT u.id, u.status, u.email_verified_at, c.password_hash
           FROM users u
           JOIN password_credentials c ON c.user_id = u.id
          WHERE u.id = $1
          FOR UPDATE`,
        [input.userId],
      );
      const row = credential.rows[0];
      if (!row || !row.password_hash) throw accountUnavailableError();
      const current = await verifyPassword(
        row.password_hash,
        normalizePassword(input.currentPassword),
        this.hashPolicy,
      );
      if (!current.valid) throw invalidCredentialsError();
      const reused = await verifyPassword(
        row.password_hash,
        normalizePassword(input.newPassword),
        this.hashPolicy,
      );
      if (reused.valid) {
        throw new AuthError({
          code: 'AUTH_PASSWORD_REUSED',
          statusCode: 409,
          safeMessage: 'The new password must be different from the current password.',
        });
      }

      await client.query(
        `UPDATE password_credentials
            SET password_hash = $2, hash_policy_version = $3, password_changed_at = $4, updated_at = $4
          WHERE user_id = $1`,
        [
          input.userId,
          await hashPassword(normalizePassword(input.newPassword), this.hashPolicy),
          this.hashPolicy.hashPolicyVersion,
          new Date(now),
        ],
      );

      const revokedOtherSessions = await this.revokeSessionRows(client, {
        userId: input.userId,
        exceptSessionId: input.sessionId,
        sessionId: null,
        reason: 'password_changed',
        now,
      });
      const session = await this.rotateSessionRows(client, {
        userId: input.userId,
        sessionId: input.sessionId,
        context: input,
        now,
      });
      await this.recordEvent(client, {
        userId: input.userId,
        eventType: 'password_changed',
        outcome: 'success',
        correlationId: input.correlationId,
        context: input,
        occurredAt: new Date(now),
        sessionId: input.sessionId,
        metadata: { revokedOtherSessions },
      });
      return { session, revokedOtherSessions };
    });
  }

  async requestPasswordReset(input: RequestPasswordResetInput): Promise<RequestPasswordResetResult> {
    const email = normalizeEmail(input.email);
    const target = email?.emailNormalized ?? input.email.trim().toLowerCase();
    const now = this.now();
    // Abuse evidence is recorded before the operation connection is taken:
    // a nested checkout would make an exhausted pool wait on the very
    // transactions that are waiting for it (SEC-ABUSE-08/09).
    await this.registerAbuseAttempt('reset_target', target, now, {
      limit: this.options.policy.abuse.resetMaximumRequests,
      target,
    });
    await this.registerAbuseAttempt('reset_ip', input.ipAddress ?? null, now, {
      limit: this.options.policy.abuse.resetMaximumRequests,
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (!email) {
        await client.query('COMMIT');
        return { accepted: true, issued: false, delivery: null };
      }
      const userResult = await client.query<{ id: string; status: string; email_verified_at: Date | null }>(
        `SELECT id, status, email_verified_at FROM users WHERE email_normalized = $1`,
        [email.emailNormalized],
      );
      const user = userResult.rows[0];
      if (!user || user.status !== 'active' || user.email_verified_at === null) {
        await client.query('COMMIT');
        return { accepted: true, issued: false, delivery: null };
      }

      const challengeId = randomUUID();
      const resetSecret = generateUrlToken(this.options.policy.challenge.resetSecretEntropyBytes);
      const expiresAt = new Date(now + this.options.policy.challenge.resetLifetimeMs);
      await this.supersedeActiveChallenges(client, user.id, 'password_reset', now);
      await client.query(
        `INSERT INTO auth_challenges (
           id, user_id, purpose, target_digest, secret_digest, issued_at, expires_at,
           max_attempts, request_context_digest, correlation_id, created_at
         ) VALUES ($1, $2, 'password_reset', $3, $4, $5, $6, $7, $8, $9, $5)`,
        [
          challengeId,
          user.id,
          this.digest('challenge-target:password_reset', email.emailNormalized),
          this.digest('challenge-secret:password_reset', resetSecret),
          new Date(now),
          expiresAt,
          this.options.policy.challenge.maximumAttempts,
          this.contextDigest(input),
          input.correlationId,
        ],
      );
      await this.recordEvent(client, {
        userId: user.id,
        eventType: 'password_reset_requested',
        outcome: 'success',
        correlationId: input.correlationId,
        context: input,
        occurredAt: new Date(now),
        metadata: { challengeId },
      });
      await client.query('COMMIT');
      return {
        accepted: true,
        issued: true,
        delivery: { challengeId, resetSecret, expiresAt: expiresAt.toISOString() },
      };
    } catch (error) {
      await this.safeRollback(client, error);
      throw error;
    } finally {
      client.release();
    }
  }

  async resetPassword(input: ResetPasswordInput): Promise<ResetPasswordResult> {
    const email = normalizeEmail(input.email);
    const target = email?.emailNormalized ?? input.email.trim().toLowerCase();
    const now = this.now();
    // Abuse evidence is recorded before the operation connection is taken:
    // a nested checkout would make an exhausted pool wait on the very
    // transactions that are waiting for it (SEC-ABUSE-08/09).
    await this.registerAbuseAttempt('reset_target', target, now, {
      limit: this.options.policy.abuse.resetMaximumRequests,
      target,
    });
    await this.registerAbuseAttempt('reset_ip', input.ipAddress ?? null, now, {
      limit: this.options.policy.abuse.resetMaximumRequests,
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const challengeResult = await client.query<ChallengeRow>(
        `SELECT id, user_id, purpose, secret_digest, issued_at, expires_at,
                consumed_at, superseded_at, attempt_count, max_attempts
           FROM auth_challenges
          WHERE purpose = 'password_reset'
            AND target_digest = $1
            AND consumed_at IS NULL
            AND superseded_at IS NULL
          ORDER BY issued_at DESC
          LIMIT 1
          FOR UPDATE`,
        [this.digest('challenge-target:password_reset', target)],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge) {
        await this.recordFailureAndCommit(client, {
          userId: null,
          eventType: 'password_reset_failed',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          target,
          metadata: { reason: 'no_active_challenge' },
        });
        throw invalidChallengeError();
      }
      if (challenge.expires_at.getTime() <= now) {
        await client.query(
          `UPDATE auth_challenges SET superseded_at = $2 WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
          [challenge.id, new Date(now)],
        );
        await this.recordFailureAndCommit(client, {
          userId: challenge.user_id,
          eventType: 'password_reset_failed',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          target,
          metadata: { reason: 'expired' },
        });
        throw expiredChallengeError();
      }
      if (challenge.attempt_count >= challenge.max_attempts) {
        await this.recordFailureAndCommit(client, {
          userId: challenge.user_id,
          eventType: 'password_reset_failed',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          target,
          metadata: { reason: 'attempts_exhausted' },
        });
        throw challengeAttemptsExhaustedError();
      }

      const presented = this.digest('challenge-secret:password_reset', input.resetSecret.trim());
      if (!constantTimeBufferEqual(presented, challenge.secret_digest)) {
        await client.query(`UPDATE auth_challenges SET attempt_count = attempt_count + 1 WHERE id = $1`, [
          challenge.id,
        ]);
        await this.recordFailureAndCommit(client, {
          userId: challenge.user_id,
          eventType: 'password_reset_failed',
          correlationId: input.correlationId,
          context: input,
          occurredAt: new Date(now),
          target,
          metadata: { reason: 'mismatch' },
        });
        throw invalidChallengeError();
      }

      const userEmail = email ?? (await this.emailForUser(challenge.user_id, client));
      this.assertPassword(input.newPassword, userEmail ?? undefined);
      await client.query(
        `UPDATE auth_challenges SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL`,
        [challenge.id, new Date(now)],
      );
      if (!challenge.user_id) {
        await this.rollback(client);
        throw invalidChallengeError();
      }
      await client.query(
        `UPDATE password_credentials
            SET password_hash = $2, hash_policy_version = $3, password_changed_at = $4, updated_at = $4
          WHERE user_id = $1`,
        [
          challenge.user_id,
          await hashPassword(normalizePassword(input.newPassword), this.hashPolicy),
          this.hashPolicy.hashPolicyVersion,
          new Date(now),
        ],
      );
      // Reset revokes every session and issues none: a fresh sign-in is required
      // (ADR-004, PRD-AUTH-07).
      const sessionsRevoked = await this.revokeSessionRows(client, {
        userId: challenge.user_id,
        exceptSessionId: null,
        sessionId: null,
        reason: 'password_reset',
        now,
      });
      await this.recordEvent(client, {
        userId: challenge.user_id,
        eventType: 'password_reset_completed',
        outcome: 'success',
        correlationId: input.correlationId,
        context: input,
        occurredAt: new Date(now),
        metadata: { challengeId: challenge.id, sessionsRevoked },
      });
      await client.query('COMMIT');
      return { userId: challenge.user_id, sessionsRevoked };
    } catch (error) {
      await this.safeRollback(client, error);
      throw error;
    } finally {
      client.release();
    }
  }

  async listSecurityEvents(
    userId: string,
    options: { readonly limit: number; readonly cursor?: string },
  ): Promise<SecurityEventPage> {
    const limit = Math.min(Math.max(options.limit, 1), 100);
    const cursor = decodeEventCursor(options.cursor);
    const result = await this.pool.query<{
      id: string;
      event_type: AuthEventType;
      outcome: AuthEventOutcome;
      occurred_at: Date;
      session_id: string | null;
    }>(
      `SELECT id, event_type, outcome, occurred_at, session_id
         FROM security_events
        WHERE user_id = $1
          AND visibility IN ('user', 'both')
          AND (occurred_at, id) < ($2::timestamptz, $3::uuid)
        ORDER BY occurred_at DESC, id DESC
        LIMIT $4`,
      [
        userId,
        cursor ? new Date(cursor.occurredAt) : 'infinity',
        cursor ? cursor.id : 'ffffffff-ffff-4fff-bfff-ffffffffffff',
        limit + 1,
      ],
    );
    const rows = result.rows.slice(0, limit);
    const hasMore = result.rows.length > limit;
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        outcome: row.outcome,
        occurredAt: row.occurred_at.toISOString(),
        sessionId: row.session_id,
      })),
      nextCursor: hasMore && last
        ? encodeEventCursor({ occurredAt: last.occurred_at.toISOString(), id: last.id })
        : null,
    };
  }

  /** Minimal owner-scoped profile projection for the authenticated principal. */
  async getProfile(userId: string): Promise<ProfileView | null> {
    const result = await this.pool.query<ProfileRow>(
      `SELECT id, email, status, email_verified_at, display_name, locale, timezone, base_currency
         FROM users
        WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.id,
      email: row.email,
      status: row.status,
      emailVerifiedAt: row.email_verified_at ? row.email_verified_at.toISOString() : null,
      displayName: row.display_name,
      locale: row.locale,
      timezone: row.timezone,
      baseCurrency: row.base_currency,
    };
  }

  /** Records the sanitized outcome of an immediate secret-bearing delivery. */
  async recordChallengeDelivery(
    challengeId: string,
    status: 'delivered' | 'failed',
    reference?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE auth_challenges
          SET delivery_status = $2,
              last_delivery_attempt_at = $3,
              last_delivery_status = $4
        WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
      [challengeId, status, new Date(this.now()), sanitizeReference(reference)],
    );
  }

  /** Bounded pruning keeps fixed-window counters from growing without bound. */
  async pruneAbuseCounters(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM auth_attempt_counters WHERE window_start < $1`,
      [
        new Date(
          this.now() - this.options.policy.abuse.retentionWindows * this.options.policy.abuse.windowMs,
        ),
      ],
    );
    return result.rowCount ?? 0;
  }

  private digest(purpose: string, value: string): Buffer {
    return keyedDigest(this.options.secret, purpose, value);
  }

  private requireEmail(value: string): NormalizedEmail {
    const email = normalizeEmail(value);
    if (!email) throw authValidationError('The email address is invalid.');
    return email;
  }

  private assertPassword(value: string, email?: NormalizedEmail): void {
    const violations = validatePassword(value, {
      minimumLength: this.options.policy.password.minimumLength,
      maximumLength: this.options.policy.password.maximumLength,
    }, email);
    if (violations.length > 0) {
      throw new AuthError({
        code: 'AUTH_PASSWORD_POLICY_FAILED',
        statusCode: 400,
        safeMessage: violations.includes('password_too_long')
          ? 'The password is longer than the supported maximum.'
          : violations.includes('password_too_short')
            ? `The password must contain at least ${this.options.policy.password.minimumLength} characters.`
            : 'The password is too common or too similar to the email address.',
      });
    }
  }

  private assertProfile(input: { locale: string; timezone: string; baseCurrency: string }): void {
    if (!isSupportedLocale(input.locale)) throw authValidationError('Locale is invalid.');
    if (!isIanaTimezone(input.timezone)) throw authValidationError('Timezone is invalid.');
    if (!CURRENCY_PATTERN.test(input.baseCurrency)) {
      throw authValidationError('Base currency is invalid.');
    }
  }

  private contextDigest(input: AccessRequestContext): Buffer | null {
    if (!input.ipAddress && !input.userAgent) return null;
    return this.digest('request-context', `${input.ipAddress ?? ''}|${input.userAgent ?? ''}`);
  }

  private ipPrefixDigest(value: string | null | undefined): Buffer | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    // Privacy-approved network context only: a truncated prefix, never a full
    // address (DATABASE §4.5, SEC-LOG-02).
    const prefix = trimmed.includes(':')
      ? trimmed.split(':').slice(0, 3).join(':')
      : trimmed.split('.').slice(0, 3).join('.');
    return this.digest('ip-prefix', prefix);
  }

  private async issueChallenge(
    client: PoolClient,
    input: {
      readonly userId: string;
      readonly purpose: 'email_verification';
      readonly target: string;
      readonly context: AccessRequestContext;
      readonly now: number;
    },
  ): Promise<VerificationDelivery> {
    await this.supersedeActiveChallenges(client, input.userId, input.purpose, input.now);
    const challengeId = randomUUID();
    const oneTimeCode = generateNumericOtp(this.options.policy.challenge.otpDigits);
    const expiresAt = new Date(input.now + this.options.policy.challenge.otpLifetimeMs);
    await client.query(
      `INSERT INTO auth_challenges (
         id, user_id, purpose, target_digest, secret_digest, issued_at, expires_at,
         max_attempts, request_context_digest, correlation_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $6)`,
      [
        challengeId,
        input.userId,
        input.purpose,
        this.digest(`challenge-target:${input.purpose}`, input.target),
        this.digest(`challenge-secret:${input.purpose}`, oneTimeCode),
        new Date(input.now),
        expiresAt,
        this.options.policy.challenge.maximumAttempts,
        this.contextDigest(input.context),
        input.context.correlationId,
      ],
    );
    return { challengeId, oneTimeCode, expiresAt: expiresAt.toISOString() };
  }

  private async supersedeActiveChallenges(
    client: PoolClient,
    userId: string,
    purpose: 'email_verification' | 'password_reset',
    now: number,
  ): Promise<void> {
    await client.query(
      `UPDATE auth_challenges
          SET superseded_at = $3
        WHERE user_id = $1
          AND purpose = $2
          AND consumed_at IS NULL
          AND superseded_at IS NULL`,
      [userId, purpose, new Date(now)],
    );
  }

  private async withinIssuanceCap(
    client: PoolClient,
    userId: string,
    now: number,
  ): Promise<boolean> {
    const result = await client.query<{ hourly: string; daily: string }>(
      `SELECT COUNT(*) FILTER (WHERE issued_at > $2) AS hourly,
              COUNT(*) FILTER (WHERE issued_at > $3) AS daily
         FROM auth_challenges
        WHERE user_id = $1 AND purpose = 'email_verification'`,
      [
        userId,
        new Date(now - 60 * 60 * 1_000),
        new Date(now - 24 * 60 * 60 * 1_000),
      ],
    );
    const row = result.rows[0];
    if (!row) return true;
    return (
      Number(row.hourly) < this.options.policy.challenge.hourlyIssuanceCap
      && Number(row.daily) < this.options.policy.challenge.dailyIssuanceCap
    );
  }

  private async createSession(
    client: PoolClient,
    input: { readonly userId: string; readonly context: AccessRequestContext; readonly now: number },
  ): Promise<IssuedSession> {
    const sessionId = randomUUID();
    const sessionToken = generateUrlToken(this.options.policy.session.tokenEntropyBytes);
    const csrfToken = generateUrlToken(this.options.policy.session.csrfEntropyBytes);
    const createdAt = new Date(input.now);
    const idleExpiresAt = new Date(input.now + this.options.policy.session.idleLifetimeMs);
    const absoluteExpiresAt = new Date(input.now + this.options.policy.session.absoluteLifetimeMs);
    await client.query(
      `INSERT INTO sessions (
         id, user_id, family_id, client_type, created_at, last_seen_at,
         idle_expires_at, absolute_expires_at, device_label, ip_prefix_digest, csrf_digest
       ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10)`,
      [
        sessionId,
        input.userId,
        sessionId,
        input.context.clientType ?? 'web',
        createdAt,
        idleExpiresAt,
        absoluteExpiresAt,
        summarizeDeviceLabel(input.context.userAgent),
        this.ipPrefixDigest(input.context.ipAddress),
        this.digest('csrf-token', csrfToken),
      ],
    );
    await client.query(
      `INSERT INTO session_tokens (id, session_id, token_digest, generation, issued_at, expires_at)
       VALUES ($1, $2, $3, 1, $4, $5)`,
      [
        randomUUID(),
        sessionId,
        this.digest('session-token', sessionToken),
        createdAt,
        absoluteExpiresAt,
      ],
    );
    return {
      session: {
        id: sessionId,
        clientType: input.context.clientType ?? 'web',
        createdAt: createdAt.toISOString(),
        lastSeenAt: createdAt.toISOString(),
        idleExpiresAt: idleExpiresAt.toISOString(),
        absoluteExpiresAt: absoluteExpiresAt.toISOString(),
        deviceLabel: summarizeDeviceLabel(input.context.userAgent),
        current: true,
      },
      sessionToken,
      csrfToken,
    };
  }

  private async rotateSessionRows(
    client: PoolClient,
    input: {
      readonly userId: string;
      readonly sessionId: string;
      readonly context: AccessRequestContext;
      readonly now: number;
    },
  ): Promise<IssuedSession> {
    const current = await client.query<{ id: string; generation: number; absolute_expires_at: Date }>(
      `SELECT t.id, t.generation, s.absolute_expires_at
         FROM session_tokens t
         JOIN sessions s ON s.id = t.session_id
        WHERE t.session_id = $1 AND t.retired_at IS NULL
        ORDER BY t.generation DESC
        LIMIT 1
        FOR UPDATE OF t`,
      [input.sessionId],
    );
    const row = current.rows[0];
    if (!row) throw accountUnavailableError();
    const sessionToken = generateUrlToken(this.options.policy.session.tokenEntropyBytes);
    const csrfToken = generateUrlToken(this.options.policy.session.csrfEntropyBytes);
    const rotatedAt = new Date(input.now);
    // Rotation is also a renewal: the idle window slides forward but never past
    // the absolute expiry the session was issued with.
    const idleExpiresAt = clampIdleExpiry(
      input.now,
      this.options.policy.session.idleLifetimeMs,
      row.absolute_expires_at,
    );
    await client.query(
      `UPDATE session_tokens
          SET retired_at = $2, grace_expires_at = $3
        WHERE id = $1 AND retired_at IS NULL`,
      [row.id, rotatedAt, new Date(input.now + this.options.policy.session.rotationGraceMs)],
    );
    await client.query(
      `INSERT INTO session_tokens (id, session_id, token_digest, generation, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        input.sessionId,
        this.digest('session-token', sessionToken),
        row.generation + 1,
        rotatedAt,
        row.absolute_expires_at,
      ],
    );
    await client.query(
      `UPDATE sessions
          SET csrf_digest = $2, last_seen_at = $3, idle_expires_at = $4, version = version + 1
        WHERE id = $1 AND revoked_at IS NULL`,
      [
        input.sessionId,
        this.digest('csrf-token', csrfToken),
        rotatedAt,
        new Date(idleExpiresAt),
      ],
    );
    await this.recordEvent(client, {
      userId: input.userId,
      eventType: 'session_token_rotated',
      outcome: 'success',
      correlationId: input.context.correlationId,
      context: input.context,
      occurredAt: rotatedAt,
      sessionId: input.sessionId,
      metadata: { generation: row.generation + 1 },
    });
    return {
      session: {
        id: input.sessionId,
        clientType: input.context.clientType ?? 'web',
        createdAt: rotatedAt.toISOString(),
        lastSeenAt: rotatedAt.toISOString(),
        idleExpiresAt: new Date(idleExpiresAt).toISOString(),
        absoluteExpiresAt: row.absolute_expires_at.toISOString(),
        deviceLabel: summarizeDeviceLabel(input.context.userAgent),
        current: true,
      },
      sessionToken,
      csrfToken,
    };
  }

  private async revokeSessionRows(
    client: PoolClient,
    input: {
      readonly userId: string;
      readonly sessionId: string | null;
      readonly exceptSessionId: string | null;
      readonly reason:
        | 'user_logout'
        | 'user_logout_all'
        | 'user_revoked'
        | 'password_changed'
        | 'password_reset'
        | 'token_replay'
        | 'account_unavailable'
        | 'expired';
      readonly now: number;
    },
  ): Promise<number> {
    const revokedAt = new Date(input.now);
    const result = await client.query(
      `UPDATE sessions
          SET revoked_at = $4, revocation_reason = $5, version = version + 1
        WHERE user_id = $1
          AND revoked_at IS NULL
          AND ($2::uuid IS NULL OR id = $2::uuid)
          AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [input.userId, input.sessionId, input.exceptSessionId, revokedAt, input.reason],
    );
    await client.query(
      `UPDATE session_tokens t
          SET retired_at = COALESCE(t.retired_at, $2)
         FROM sessions s
        WHERE t.session_id = s.id
          AND s.user_id = $1
          AND s.revoked_at = $2
          AND t.retired_at IS NULL`,
      [input.userId, revokedAt],
    );
    return result.rowCount ?? 0;
  }

  private async containReplay(sessionId: string, now: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query<{ user_id: string; family_id: string }>(
        `SELECT user_id, family_id FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const row = session.rows[0];
      await client.query(
        `UPDATE session_tokens SET replayed_at = $2 WHERE session_id = $1 AND replayed_at IS NULL`,
        [sessionId, new Date(now)],
      );
      if (!row) {
        await client.query('COMMIT');
        return;
      }
      const revokedAt = new Date(now);
      await client.query(
        `UPDATE sessions
            SET revoked_at = $3, revocation_reason = 'token_replay', version = version + 1
          WHERE family_id = $1 AND revoked_at IS NULL AND user_id = $2`,
        [row.family_id, row.user_id, revokedAt],
      );
      await this.recordEvent(client, {
        userId: row.user_id,
        eventType: 'session_token_replay_detected',
        outcome: 'blocked',
        correlationId: randomUUID(),
        context: { correlationId: randomUUID() },
        occurredAt: revokedAt,
        sessionId,
        metadata: { reason: 'retired_token_outside_grace' },
      });
      await client.query('COMMIT');
    } catch (error) {
      await this.safeRollback(client, error);
    } finally {
      client.release();
    }
  }

  private async expireSession(sessionId: string, now: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query<{ user_id: string }>(
        `SELECT user_id FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const revokedAt = new Date(now);
      await client.query(
        `UPDATE sessions
            SET revoked_at = $2, revocation_reason = 'expired', version = version + 1
          WHERE id = $1 AND revoked_at IS NULL`,
        [sessionId, revokedAt],
      );
      await client.query(
        `UPDATE session_tokens SET retired_at = COALESCE(retired_at, $2) WHERE session_id = $1`,
        [sessionId, revokedAt],
      );
      const row = session.rows[0];
      if (row) {
        await this.recordEvent(client, {
          userId: row.user_id,
          eventType: 'session_expired',
          outcome: 'blocked',
          correlationId: randomUUID(),
          context: { correlationId: randomUUID() },
          occurredAt: revokedAt,
          sessionId,
          metadata: { reason: 'idle_or_absolute_expiry' },
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await this.safeRollback(client, error);
    } finally {
      client.release();
    }
  }

  private async recordEvent(
    client: PoolClient,
    event: {
      readonly userId: string | null;
      readonly eventType: AuthEventType;
      readonly outcome: AuthEventOutcome;
      readonly correlationId: string;
      readonly context: AccessRequestContext;
      readonly occurredAt: Date;
      readonly sessionId?: string | null;
      readonly target?: string | null;
      readonly metadata?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO security_events (
         id, user_id, event_type, outcome, visibility, occurred_at, session_id,
         correlation_id, target_digest, ip_prefix_digest, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        randomUUID(),
        event.userId,
        event.eventType,
        event.outcome,
        eventVisibility(event.eventType),
        event.occurredAt,
        event.sessionId ?? null,
        event.correlationId,
        event.target ? this.digest('event-target', event.target) : null,
        this.ipPrefixDigest(event.context.ipAddress),
        JSON.stringify(sanitizeMetadata(event.metadata)),
      ],
    );
  }

  /**
   * Records a sanitized failure event and commits it before throwing.
   *
   * Failed attempts are abuse evidence and challenge-attempt evidence, so they
   * must survive: rolling them back would let an attacker retry indefinitely
   * (SEC-ABUSE-02/08).
   */
  /** Records a blocked registration after its transaction has been rolled back. */
  private async recordBlockedRegistration(
    client: PoolClient,
    input: AccessRequestContext & { email: string },
    now: number,
  ): Promise<void> {
    await client.query('BEGIN');
    await this.recordEvent(client, {
      userId: null,
      eventType: 'registration_requested',
      outcome: 'blocked',
      correlationId: input.correlationId,
      context: input,
      occurredAt: new Date(now),
      target: input.email,
      metadata: { reason: 'existing_email' },
    });
    await client.query('COMMIT');
  }

  private async recordFailureAndCommit(
    client: PoolClient,
    event: {
      readonly userId: string | null;
      readonly eventType: AuthEventType;
      readonly correlationId: string;
      readonly context: AccessRequestContext;
      readonly occurredAt: Date;
      readonly target?: string | null;
      readonly metadata?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await this.recordEvent(client, { ...event, outcome: 'failure', sessionId: null });
    await client.query('COMMIT');
  }

  /**
   * Counts one attempt and enforces the window limit.
   *
   * The counter is committed on its own connection, before any operation
   * transaction is opened, so a rolled-back operation (for example a failed
   * login whose event is recorded but whose write is discarded) can never erase
   * abuse evidence (SEC-ABUSE-02/08/09). Callers must invoke this *before*
   * `pool.connect()`: acquiring a second connection while an operation
   * transaction is open holds one connection and waits for another, which
   * deadlocks the auth pool once every connection is in that state.
   */
  private async registerAbuseAttempt(
    scopeKind: AbuseScopeKind,
    scopeValue: string | null | undefined,
    now: number,
    options: { readonly limit: number; readonly target?: string },
  ): Promise<void> {
    if (!scopeValue) return;
    const scopeDigest = scopeKind.endsWith('_ip')
      ? this.ipPrefixDigest(scopeValue)
      : this.digest(`abuse:${scopeKind}`, options.target ?? scopeValue);
    if (!scopeDigest) return;
    const windowStart = new Date(abuseWindowStart(now, this.options.policy.abuse.windowMs));
    const instant = new Date(now);
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ count: number }>(
        `INSERT INTO auth_attempt_counters (scope_kind, scope_digest, window_start, count, first_at, last_at)
         VALUES ($1, $2, $3, 1, $4, $4)
         ON CONFLICT (scope_kind, scope_digest, window_start)
         DO UPDATE SET count = auth_attempt_counters.count + 1, last_at = $4
         RETURNING count`,
        [scopeKind, scopeDigest, windowStart, instant],
      );
      const count = result.rows[0]?.count ?? 1;
      if (count > options.limit) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((windowStart.getTime() + this.options.policy.abuse.windowMs - now) / 1_000),
        );
        throw rateLimitedError(retryAfterSeconds);
      }
    } finally {
      client.release();
    }
  }

  private async userIdForSession(sessionId: string, client?: PoolClient): Promise<string> {
    const runner: Pick<Pool, 'query'> = client ?? this.pool;
    const result = await runner.query<{ user_id: string }>(
      `SELECT user_id FROM sessions WHERE id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) throw accountUnavailableError();
    return row.user_id;
  }

  private async emailForUser(userId: string | null, client?: PoolClient): Promise<NormalizedEmail | null> {
    if (!userId) return null;
    const runner: Pick<Pool, 'query'> = client ?? this.pool;
    const result = await runner.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row ? normalizeEmail(row.email) : null;
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await this.safeRollback(client, error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async rollback(client: PoolClient): Promise<void> {
    await client.query('ROLLBACK');
  }

  private async safeRollback(client: PoolClient, cause: unknown): Promise<void> {
    if (cause instanceof AuthError) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The failure being reported is authoritative; rollback noise is not.
      }
      return;
    }
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw authServiceUnavailableError(rollbackError);
    }
  }
}

export function encodeSessionCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeSessionCursor(value: string | undefined): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      parsed !== null
      && typeof parsed === 'object'
      && typeof (parsed as { createdAt?: unknown }).createdAt === 'string'
      && typeof (parsed as { id?: unknown }).id === 'string'
    ) {
      return { createdAt: (parsed as { createdAt: string }).createdAt, id: (parsed as { id: string }).id };
    }
    return null;
  } catch {
    return null;
  }
}

export function encodeEventCursor(cursor: { occurredAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeEventCursor(value: string | undefined): { occurredAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      parsed !== null
      && typeof parsed === 'object'
      && typeof (parsed as { occurredAt?: unknown }).occurredAt === 'string'
      && typeof (parsed as { id?: unknown }).id === 'string'
    ) {
      return {
        occurredAt: (parsed as { occurredAt: string }).occurredAt,
        id: (parsed as { id: string }).id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function sanitizeMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, string | number | boolean | null> {
  if (!metadata) return {};
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.some((forbidden) => key.toLowerCase().includes(forbidden))) continue;
    if (typeof value === 'string') sanitized[key] = value.slice(0, 128);
    else if (typeof value === 'number' && Number.isFinite(value)) sanitized[key] = value;
    else if (typeof value === 'boolean') sanitized[key] = value;
    else if (value === null) sanitized[key] = null;
  }
  return sanitized;
}

function sanitizeReference(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 120) || null;
}

function sqlstateOf(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}
