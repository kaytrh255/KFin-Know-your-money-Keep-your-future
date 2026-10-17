import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  authValidationError,
  generateInvitationCode,
  normalizeEmail,
  normalizeInvitationCode,
} from '@kfin/domain';
import { keyedDigest } from './canonical.js';

/**
 * Trusted Private Beta invitation provisioning.
 *
 * Trace: DATABASE §4.2, SEC-AUTH-14.
 *
 * This repository is the operator path. It must be constructed with a pool that
 * is connected as `kfin_operator`; the API role `kfin_app` has no privilege at
 * all on `beta_invitations`, so a mistake here fails closed with 42501 instead
 * of silently granting the API permission to mint codes.
 *
 * There is deliberately no HTTP route: codes reach users through the reviewed
 * operator channel only.
 */

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

export interface InvitationPolicy {
  readonly codeEntropyBytes: number;
  readonly codeGroupLength: number;
  readonly defaultLifetimeMs: number;
}

export class PostgresInvitationRepository {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly options: {
      readonly secret: string;
      readonly policy: InvitationPolicy;
      readonly now?: () => number;
    },
  ) {}

  async issueInvitation(input: IssueInvitationInput): Promise<IssuedInvitation> {
    const now = this.options.now ?? Date.now;
    const invitationId = randomUUID();
    const code = generateInvitationCode(
      this.options.policy.codeEntropyBytes,
      this.options.policy.codeGroupLength,
    );
    const expiresAt = new Date(now() + (input.lifetimeMs ?? this.options.policy.defaultLifetimeMs));
    const invitedEmail = input.invitedEmail ? normalizeEmail(input.invitedEmail) : null;
    if (input.invitedEmail && !invitedEmail) throw authValidationError('The invited email address is invalid.');
    await this.pool.query(
      `INSERT INTO beta_invitations (
         id, code_digest, invited_email_normalized, expires_at, created_by_operator_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        invitationId,
        keyedDigest(this.options.secret, 'invitation-code', normalizeInvitationCode(code)),
        invitedEmail?.emailNormalized ?? null,
        expiresAt,
        input.createdByOperatorId,
        new Date(now()),
      ],
    );
    return { invitationId, code, expiresAt: expiresAt.toISOString() };
  }
}
