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
import { authPolicy } from '@kfin/config';

/**
 * OQ-20 (2026-10-12): the emailed OTP exists only for password reset. There is no
 * verification template to fall back to, so no code path can email a code that a
 * caller might later present as proof of a verification that never happened.
 */
export type SecurityEmailTemplate =
  | 'password_reset'
  | 'security_notice';

export interface SecurityEmailMessage {
  readonly to: string;
  readonly template: SecurityEmailTemplate;
  readonly correlationId: string;
  /**
   * Present only for `password_reset`. It exists in process memory for this single
   * submission; no adapter may persist it.
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

export interface CreateEmailDeliveryOptions {
  readonly directory?: string | null;
  readonly apiKey?: string | null;
  readonly from?: string | null;
  readonly replyTo?: string | null;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export function createEmailDeliveryAdapter(
  kind: 'memory' | 'none' | 'file' | 'resend',
  options: CreateEmailDeliveryOptions = {},
): EmailDeliveryAdapter {
  if (kind === 'resend') {
    if (!options.apiKey) throw new Error('RESEND_API_KEY is required for the resend email adapter.');
    if (!options.from) throw new Error('EMAIL_FROM_ADDRESS is required for the resend email adapter.');
    return new ResendEmailAdapter({
      apiKey: options.apiKey,
      from: options.from,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
  if (kind === 'memory') return new RecordingEmailAdapter();
  if (kind === 'file') {
    if (!options.directory) throw new Error('EMAIL_OUTBOX_DIR is required for the local file email adapter.');
    return new FileEmailAdapter({ directory: options.directory });
  }
  return new UnavailableEmailAdapter();
}

/**
 * Private Beta provider adapter (Resend HTTP API).
 *
 * Chosen for the beta because it needs one API key and one verified sender, has
 * no SDK dependency (Node's built-in `fetch` is enough) and exposes a plain
 * `POST /emails` contract that a local test server can imitate exactly.
 *
 * Secrets: the API key is read from the environment and only ever placed in the
 * `Authorization` header. The one-time code goes into the message body and is
 * never logged, never returned in `reference`, and never written to disk. A
 * failed response is reduced to a bounded `resend-http-<status>` reference; the
 * provider's error body is deliberately not read or echoed.
 */
export interface ResendOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly replyTo?: string | null;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

const RESEND_DEFAULT_BASE_URL = 'https://api.resend.com';
const RESEND_DEFAULT_TIMEOUT_MS = 5_000;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class ResendEmailAdapter implements EmailDeliveryAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ResendOptions) {
    if (!options.apiKey) throw new Error('RESEND_API_KEY is required for the resend email adapter.');
    if (!options.from) throw new Error('EMAIL_FROM_ADDRESS is required for the resend email adapter.');
    this.baseUrl = (options.baseUrl ?? RESEND_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? RESEND_DEFAULT_TIMEOUT_MS;
  }

  async send(message: SecurityEmailMessage): Promise<EmailDeliveryResult> {
    const content = emailContent(message);
    if (content === null) return { status: 'failed', reference: 'resend-missing-secret' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [message.to],
          ...(this.options.replyTo ? { reply_to: this.options.replyTo } : {}),
          subject: content.subject,
          text: content.text,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // Drain nothing: the provider body could contain the recipient address.
        return { status: 'failed', reference: `resend-http-${response.status}` };
      }
      const id = await readProviderId(response);
      return { status: 'delivered', reference: id === null ? 'resend-accepted' : `resend-${id}` };
    } catch {
      // Network failure, DNS failure, TLS failure and timeout are one bounded
      // outcome: the caller already tells the user to request a new code.
      return { status: 'failed', reference: 'resend-unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }
}

interface EmailContent {
  readonly subject: string;
  readonly text: string;
}

/**
 * Plain-text only. No HTML, so no template engine and no injection surface; the
 * only interpolated value is the six-digit code the caller generated.
 */
export function emailContent(message: SecurityEmailMessage): EmailContent | null {
  if (message.template === 'password_reset') {
    if (!message.oneTimeSecret) return null;
    const minutes = Math.round(authPolicy.challenge.otpLifetimeMs / 60_000);
    return {
      subject: 'KFin — đặt lại mật khẩu',
      text: [
        `Mã đặt lại mật khẩu KFin của bạn là: ${message.oneTimeSecret}`,
        '',
        `Mã chỉ dùng được một lần và hết hạn sau ${minutes} phút.`,
        'Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này; mật khẩu hiện tại vẫn giữ nguyên.',
        '',
        `Mã tham chiếu sự cố: ${message.correlationId}`,
      ].join('\n'),
    };
  }
  return {
    subject: 'KFin — thông báo bảo mật',
    text: [
      'Tài khoản KFin của bạn vừa có một thay đổi bảo mật.',
      'Nếu đó không phải bạn, hãy đặt lại mật khẩu ngay.',
      '',
      `Mã tham chiếu sự cố: ${message.correlationId}`,
    ].join('\n'),
  };
}

async function readProviderId(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;
  try {
    const body = await response.json() as { id?: unknown };
    return typeof body.id === 'string' && PROVIDER_ID.test(body.id) ? body.id : null;
  } catch {
    return null;
  }
}
