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

export function createEmailDeliveryAdapter(kind: 'memory' | 'none'): EmailDeliveryAdapter {
  return kind === 'memory' ? new RecordingEmailAdapter() : new UnavailableEmailAdapter();
}
