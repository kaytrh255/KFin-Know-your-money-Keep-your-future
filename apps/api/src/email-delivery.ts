/**
 * Vendor-neutral secret-bearing email delivery.
 *
 * Trace: ADR-002, ADR-008, SEC-AUTH-07/13, SEC-LOG-02.
 *
 * OTP and reset secrets are submitted immediately from request-process memory
 * after the digest-only challenge is committed; they are never queued in a
 * durable outbox and never written to a log. Provider selection is Phase 6 work
 * (OQ-17 / `RC-PROV-01`), so only non-production adapters exist here.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type SecurityEmailTemplate =
  | 'email_verification_otp'
  | 'password_reset'
  | 'security_notice';

export interface SecurityEmailMessage {
  readonly to: string;
  readonly template: SecurityEmailTemplate;
  readonly correlationId: string;
  /**
   * Present only for `email_verification_otp` and `password_reset`. It exists in
   * process memory for this single submission; no adapter may persist it.
   */
  readonly oneTimeSecret?: string;
}

export interface EmailDeliveryResult {
  readonly status: 'delivered' | 'failed';
  /** Sanitized provider reference; never the message body or the secret. */
  readonly reference?: string;
}

export interface EmailDeliveryAdapter {
  send(message: SecurityEmailMessage): Promise<EmailDeliveryResult>;
}

/**
 * Non-production adapter used by tests and local development. It keeps the
 * submitted secret in ephemeral process memory so a test can complete a flow;
 * a provider adapter must never do this.
 */
export class RecordingEmailAdapter implements EmailDeliveryAdapter {
  readonly messages: {
    readonly to: string;
    readonly template: SecurityEmailTemplate;
    readonly correlationId: string;
    readonly oneTimeSecret?: string;
    readonly delivered: boolean;
  }[] = [];

  constructor(private readonly options: { readonly fail?: boolean } = {}) {}

  async send(message: SecurityEmailMessage): Promise<EmailDeliveryResult> {
    const delivered = this.options.fail !== true;
    this.messages.push({
      to: message.to,
      template: message.template,
      correlationId: message.correlationId,
      ...(message.oneTimeSecret === undefined ? {} : { oneTimeSecret: message.oneTimeSecret }),
      delivered,
    });
    return delivered
      ? { status: 'delivered', reference: `memory-${this.messages.length}` }
      : { status: 'failed', reference: 'memory-failure' };
  }
}

/** Provider-less deployment: delivery is reported as failed so callers surface generic guidance. */
export class UnavailableEmailAdapter implements EmailDeliveryAdapter {
  async send(): Promise<EmailDeliveryResult> {
    return { status: 'failed', reference: 'no-provider-configured' };
  }
}

/**
 * Local-development sink. Writes one JSON file per message into a directory so a
 * developer can read the OTP/reset secret on their own machine instead of
 * configuring a provider (which is Phase 6, OQ-17).
 *
 * Deliberately not a log and deliberately not reachable over HTTP: this adapter
 * is refused outright when `NODE_ENV=production` (see `loadApiConfig`), it writes
 * only into the configured directory, and the API registers no route that serves
 * that directory. One-time secrets exist only until the challenge is consumed or
 * expires, so a developer should treat the directory as sensitive local state and
 * delete it when finished.
 */
export class FileEmailAdapter implements EmailDeliveryAdapter {
  constructor(private readonly options: { readonly directory: string }) {}

  async send(message: SecurityEmailMessage): Promise<EmailDeliveryResult> {
    try {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      const name = `${Date.now()}-${randomUUID()}.json`;
      const payload = JSON.stringify({
        to: message.to,
        template: message.template,
        correlationId: message.correlationId,
        ...(message.oneTimeSecret === undefined ? {} : { oneTimeSecret: message.oneTimeSecret }),
        recordedAt: new Date().toISOString(),
      }, null, 2);
      // 0600: readable only by the developer running the local API.
      await writeFile(path.join(this.options.directory, name), payload, { encoding: 'utf8', mode: 0o600 });
      return { status: 'delivered', reference: `file-${name}` };
    } catch {
      // The failure is reported without the path or the secret: the caller logs a
      // bounded reason and the user sees generic guidance (SEC-LOG-02).
      return { status: 'failed', reference: 'file-outbox-unavailable' };
    }
  }
}

export function createEmailDeliveryAdapter(
  kind: 'memory' | 'none' | 'file',
  options: { readonly directory?: string | null } = {},
): EmailDeliveryAdapter {
  if (kind === 'memory') return new RecordingEmailAdapter();
  if (kind === 'file') {
    if (!options.directory) throw new Error('EMAIL_OUTBOX_DIR is required for the local file email adapter.');
    return new FileEmailAdapter({ directory: options.directory });
  }
  return new UnavailableEmailAdapter();
}
