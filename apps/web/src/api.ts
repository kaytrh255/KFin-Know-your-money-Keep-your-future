/**
 * Same-origin API client.
 *
 * Deliberately free of DOM/lib globals at the type level so the transport rules
 * are unit-testable: the fetch implementation and the cookie reader are injected.
 *
 * Transport rules copied from the API itself, not invented here:
 *  - every request is same-origin (the API refuses cross-origin browser writes);
 *  - writes carry `x-kfin-csrf` with the value of the readable `kfin_csrf` cookie,
 *    which the API sets alongside the HttpOnly session cookie
 *    (`apps/api/src/session-transport.ts`);
 *  - writes to money-bearing routes carry a caller-chosen `idempotency-key` that
 *    stays the same for retries of the same intent and changes for a new intent;
 *  - the session token is never read, stored, or sent by JavaScript: it lives in
 *    an HttpOnly cookie that only the browser attaches.
 */

export const CSRF_COOKIE_NAME = 'kfin_csrf';
export const CSRF_HEADER_NAME = 'x-kfin-csrf';
export const IDEMPOTENCY_HEADER_NAME = 'idempotency-key';

export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface FetchLike {
  (input: string, init: RequestInitLike): Promise<HttpResponseLike>;
}

export interface RequestInitLike {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly credentials: 'same-origin';
}

export interface ApiTransport {
  readonly fetch: FetchLike;
  readonly cookie: (name: string) => string | null;
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | null;
  readonly details: unknown;
  /**
   * Contract rules the API named for this rejection (path + rule, never the
   * submitted value). Empty when the API did not report field detail, so a
   * caller can always read `.fields` without a null check.
   */
  readonly fields: readonly ContractFieldFailure[];

  constructor(
    status: number,
    code: string,
    message: string,
    correlationId: string | null,
    details: unknown,
    fields: readonly ContractFieldFailure[] = [],
  ) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.details = details;
    this.fields = fields;
  }
}

/** One rule the API reported as broken, named by field. Holds no submitted value. */
export interface ContractFieldFailure {
  readonly path: string;
  readonly rule: string;
}

export interface ApiRequest {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

export interface ApiResult<T> {
  readonly status: number;
  readonly data: T;
}

interface ErrorEnvelope {
  error?: { code?: unknown; message?: unknown; correlationId?: unknown; fields?: unknown };
}

/**
 * Reads the API's field list defensively: only entries that are objects with
 * string `path` and `rule` survive, and the list is capped. The client never
 * invents a field name, so an unknown envelope shape degrades to "no detail"
 * rather than to a guessed one.
 */
function contractFieldsFrom(value: unknown): readonly ContractFieldFailure[] {
  if (!Array.isArray(value)) return [];
  const fields: ContractFieldFailure[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { path, rule } = entry as { path?: unknown; rule?: unknown };
    if (typeof path !== 'string' || typeof rule !== 'string') continue;
    if (path.length === 0 || rule.length === 0) continue;
    fields.push({ path, rule });
    if (fields.length === 20) break;
  }
  return fields;
}

function errorFrom(status: number, text: string): ApiFailure {
  let parsed: ErrorEnvelope | null = null;
  try {
    parsed = JSON.parse(text) as ErrorEnvelope;
  } catch {
    parsed = null;
  }
  const code = typeof parsed?.error?.code === 'string' ? parsed.error.code : 'UNPARSED_RESPONSE';
  const message = typeof parsed?.error?.message === 'string'
    ? parsed.error.message
    : `The API answered ${status} without a readable error envelope.`;
  const correlationId = typeof parsed?.error?.correlationId === 'string' ? parsed.error.correlationId : null;
  return new ApiFailure(
    status,
    code,
    message,
    correlationId,
    text.slice(0, 2_000),
    contractFieldsFrom(parsed?.error?.fields),
  );
}

/** Repeated retries of one user intent must reuse the key; a new intent takes a new key. */
export function newIdempotencyKey(): string {
  const source = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  // Fallback for non-secure-context origins, where randomUUID is unavailable.
  const bytes = new Uint8Array(16);
  (globalThis.crypto as { getRandomValues: (array: Uint8Array) => Uint8Array }).getRandomValues(bytes);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createApi(transport: ApiTransport) {
  async function request<T>(input: ApiRequest): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const csrf = transport.cookie(CSRF_COOKIE_NAME);
    if (csrf) headers[CSRF_HEADER_NAME] = csrf;
    if (input.idempotencyKey) headers[IDEMPOTENCY_HEADER_NAME] = input.idempotencyKey;

    const init: RequestInitLike = {
      method: input.method,
      headers,
      credentials: 'same-origin',
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    };
    if (input.body !== undefined) headers['content-type'] = 'application/json';

    const response = await transport.fetch(input.path, init);
    const text = await response.text();
    if (!response.ok) throw errorFrom(response.status, text);
    if (text.length === 0) return { status: response.status, data: null as T };
    return { status: response.status, data: JSON.parse(text) as T };
  }

  return {
    session: {
      me: () => request<{
        userId: string;
        email: string;
        status: string;
        /** Null until a reset OTP has actually been consumed (OQ-20). */
        emailVerifiedAt: string | null;
        baseCurrency: string;
        displayName: string | null;
        session: { id: string };
      }>({ method: 'GET', path: '/api/v1/auth/me' }),
      logout: () => request<{ revoked: true }>({ method: 'POST', path: '/api/v1/auth/logout' }),
      logoutAll: () => request<{ revokedSessions: number }>({ method: 'POST', path: '/api/v1/auth/logout-all' }),
      sessions: () => request<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>({ method: 'GET', path: '/api/v1/auth/sessions' }),
      securityEvents: () => request<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>({ method: 'GET', path: '/api/v1/auth/security-events' }),
    },
    auth: {
      // Registration admits the account and issues nothing else: there is no
      // verification endpoint and no resend window to publish (OQ-20, 2026-10-12).
      register: (body: unknown) => request<{ accepted: true }>({ method: 'POST', path: '/api/v1/auth/register', body }),
      login: (body: unknown) => request<{ userId: string }>({ method: 'POST', path: '/api/v1/auth/login', body }),
      changePassword: (body: unknown) => request<{ revokedOtherSessions: number }>({ method: 'POST', path: '/api/v1/auth/password/change', body }),
      resetRequest: (body: unknown) => request<{ accepted: true }>({ method: 'POST', path: '/api/v1/auth/password/reset-request', body }),
      reset: (body: unknown) => request<{ userId: string; sessionsRevoked: number }>({ method: 'POST', path: '/api/v1/auth/password/reset', body }),
    },
    financial: {
      account: () => request<{
        accountId: string; name: string; currency: string; financialStateVersion: string;
        snapshot: { id: string; amountMinor: string; effectiveAt: string; effectiveLocalDate: string };
        postedCurrentIncomeMinor: string; postedCurrentExpenseMinor: string; currentBalanceMinor: string;
      }>({ method: 'GET', path: '/api/v1/financial-account' }),
      accounts: () => request<{ items: Array<Record<string, unknown>> }>({ method: 'GET', path: '/api/v1/financial-accounts' }),
      // `idempotencyHeadersSchema` on this route makes the header mandatory: without
      // it the API answers 400 REQUEST_VALIDATION_FAILED before the handler runs.
      open: (body: unknown, idempotencyKey: string) => request<{ accountId: string; snapshotId: string; financialStateVersion: string }>({ method: 'POST', path: '/api/v1/financial-account', body, idempotencyKey }),
      postSnapshot: (body: unknown, idempotencyKey: string) => request<{ snapshotId: string; financialStateVersion: string }>({ method: 'POST', path: '/api/v1/financial-account/snapshots', body, idempotencyKey }),
      transactions: (query: string) => request<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>({ method: 'GET', path: `/api/v1/transactions${query}` }),
      transaction: (id: string) => request<Record<string, unknown>>({ method: 'GET', path: `/api/v1/transactions/${id}` }),
      createTransaction: (body: unknown, idempotencyKey: string) => request<{ transactionId: string; financialStateVersion: string }>({ method: 'POST', path: '/api/v1/transactions', body, idempotencyKey }),
      correctionHistory: (id: string) => request<{ items: Array<Record<string, unknown>> }>({ method: 'GET', path: `/api/v1/transactions/${id}/correction-history` }),
      voidPreview: (id: string, body: unknown) => request<Record<string, unknown>>({ method: 'POST', path: `/api/v1/transactions/${id}/void-preview`, body }),
      voidCommit: (id: string, body: unknown, idempotencyKey: string) => request<Record<string, unknown>>({ method: 'POST', path: `/api/v1/transactions/${id}/void`, body, idempotencyKey }),
      monthlyActuals: (month: string) => request<Record<string, unknown>>({ method: 'GET', path: `/api/v1/reports/monthly-actuals?month=${encodeURIComponent(month)}` }),
    },
    savings: {
      list: (status: 'active' | 'archived' | 'all') => request<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>({ method: 'GET', path: `/api/v1/savings-goals?status=${status}` }),
      create: (body: unknown, idempotencyKey: string) => request<{ goalId: string; version: string; amountChangeId: string }>({ method: 'POST', path: '/api/v1/savings-goals', body, idempotencyKey }),
      setCurrentAmount: (id: string, body: unknown, idempotencyKey: string) => request<{ goalId: string; version: string; amountChangeId: string }>({ method: 'POST', path: `/api/v1/savings-goals/${id}/current-amount`, body, idempotencyKey }),
      archive: (id: string, body: unknown, idempotencyKey: string) => request<{ goalId: string; version: string }>({ method: 'POST', path: `/api/v1/savings-goals/${id}/archive`, body, idempotencyKey }),
      amountChanges: (id: string) => request<{ items: Array<Record<string, unknown>> }>({ method: 'GET', path: `/api/v1/savings-goals/${id}/amount-changes` }),
    },
    schedule: {
      occurrences: (query: string) => request<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>({ method: 'GET', path: `/api/v1/schedule/occurrences${query}` }),
      oneOff: (body: unknown, idempotencyKey: string) => request<{ scheduledItemId: string; occurrenceId: string; financialStateVersion: string }>({ method: 'POST', path: '/api/v1/schedule/one-off', body, idempotencyKey }),
      confirm: (id: string, body: unknown, idempotencyKey: string) => request<{ occurrenceId: string; transactionId: string; state: 'confirmed'; financialStateVersion: string; occurrenceVersion: string }>({ method: 'POST', path: `/api/v1/schedule/occurrences/${id}/confirm`, body, idempotencyKey }),
      skip: (id: string, body: unknown, idempotencyKey: string) => request<Record<string, unknown>>({ method: 'POST', path: `/api/v1/schedule/occurrences/${id}/skip`, body, idempotencyKey }),
    },
    health: () => request<{ status: string }>({ method: 'GET', path: '/health/ready' }),
  };
}

export type Api = ReturnType<typeof createApi>;
