import { describe, expect, it } from 'vitest';
import {
  ApiFailure,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  IDEMPOTENCY_HEADER_NAME,
  createApi,
  newIdempotencyKey,
  type FetchLike,
  type HttpResponseLike,
  type RequestInitLike,
} from '../src/api.js';

/**
 * Transport rules the API actually enforces. If any of these regress the browser
 * silently starts sending cross-origin-shaped or CSRF-less writes, and the API
 * answers 403 — which is exactly the class of defect this client exists to catch.
 */

interface Recorded {
  readonly url: string;
  readonly init: RequestInitLike;
}

function transport(options: {
  readonly responses?: HttpResponseLike[];
  readonly cookie?: string | null;
} = {}) {
  const calls: Recorded[] = [];
  const queue = [...(options.responses ?? [])];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next) return next;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const csrf = options.cookie === undefined ? 'csrf-token-value' : options.cookie;
  return {
    calls,
    api: createApi({ fetch: fetchImpl, cookie: (name) => (name === CSRF_COOKIE_NAME ? csrf : null) }),
  };
}

function json(status: number, payload: unknown): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

describe('same-origin API client', () => {
  it('always sends credentials same-origin and never puts the session in the body', async () => {
    const { api, calls } = transport();
    await api.session.me();
    expect(calls[0]?.init.credentials).toBe('same-origin');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[0]?.url).toBe('/api/v1/auth/me');
  });

  it('echoes the readable CSRF cookie in the required header', async () => {
    const { api, calls } = transport();
    await api.session.logout();
    expect(calls[0]?.init.headers[CSRF_HEADER_NAME]).toBe('csrf-token-value');
  });

  it('omits the CSRF header when no cookie is present instead of inventing one', async () => {
    const { api, calls } = transport({ cookie: null });
    await api.session.logout();
    expect(calls[0]?.init.headers[CSRF_HEADER_NAME]).toBeUndefined();
  });

  it('sends an idempotency key only for the routes that require one', async () => {
    const { api, calls } = transport({ responses: [json(201, { transactionId: 't', financialStateVersion: '2' }), json(200, { items: [] })] });
    await api.financial.createTransaction({ kind: 'expense' }, 'key-1');
    await api.financial.transactions('?limit=50');
    expect(calls[0]?.init.headers[IDEMPOTENCY_HEADER_NAME]).toBe('key-1');
    expect(calls[1]?.init.headers[IDEMPOTENCY_HEADER_NAME]).toBeUndefined();
  });

  it('sends the idempotency key on every financial write the API marks as required', async () => {
    const { api, calls } = transport({
      responses: [json(201, { accountId: 'a', snapshotId: 's', financialStateVersion: '1' }), json(201, { snapshotId: 's2', financialStateVersion: '2' })],
    });
    await api.financial.open({ openingBalanceMinor: '1' }, 'open-key');
    await api.financial.postSnapshot({ amountMinor: '2' }, 'snapshot-key');
    expect(calls[0]?.init.headers[IDEMPOTENCY_HEADER_NAME]).toBe('open-key');
    expect(calls[1]?.init.headers[IDEMPOTENCY_HEADER_NAME]).toBe('snapshot-key');
  });

  it('sends the void commit with the reviewed context returned by its preview', async () => {
    const reviewedContext = { expectedFinancialStateVersion: '2', reviewedPreviewDigest: 'a'.repeat(64) };
    const { api, calls } = transport({ responses: [json(200, { operation: 'void', context: reviewedContext }), json(200, { sourceTransactionId: 't' })] });
    const preview = await api.financial.voidPreview('t-1', { reason: 'duplicate' });
    await api.financial.voidCommit('t-1', { reason: 'duplicate', context: preview.data.context }, 'void-key');
    const sent = JSON.parse(String(calls[1]?.init.body)) as { context?: unknown };
    expect(sent.context).toEqual(reviewedContext);
    expect(calls[1]?.init.headers[IDEMPOTENCY_HEADER_NAME]).toBe('void-key');
  });

  it('sets a JSON content type exactly when a body is sent', async () => {
    const { api, calls } = transport({ responses: [json(200, { accepted: true }), json(200, { items: [] })] });
    await api.auth.resetRequest({ email: 'a@example.invalid' });
    await api.savings.list('active');
    expect(calls[0]?.init.headers['content-type']).toBe('application/json');
    expect(calls[0]?.init.body).toBe('{"email":"a@example.invalid"}');
    expect(calls[1]?.init.headers['content-type']).toBeUndefined();
  });

  it('turns the API error envelope into a failure that keeps code, message and correlation id', async () => {
    const { api } = transport({
      responses: [json(403, { error: { code: 'AUTH_CSRF_FAILED', message: 'This request could not be verified.', correlationId: 'corr-1' } })],
    });
    await expect(api.session.logout()).rejects.toMatchObject({
      name: 'ApiFailure',
      status: 403,
      code: 'AUTH_CSRF_FAILED',
      message: 'This request could not be verified.',
      correlationId: 'corr-1',
    });
  });

  it('surfaces the rejected field list a 400 names, so the screen can show it', async () => {
    const { api } = transport({
      responses: [json(400, {
        error: {
          code: 'REQUEST_VALIDATION_FAILED',
          message: 'The request does not match the API contract.',
          correlationId: 'corr-register',
          fields: [
            { path: 'invitationCode', rule: 'the value does not satisfy a rule this contract states for the field' },
            { path: 'emailVerified', rule: 'this endpoint does not accept this field' },
          ],
        },
      })],
    });

    const failure = await api.auth.register({}).catch((error: unknown) => error) as ApiFailure;
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure.fields).toEqual([
      { path: 'invitationCode', rule: 'the value does not satisfy a rule this contract states for the field' },
      { path: 'emailVerified', rule: 'this endpoint does not accept this field' },
    ]);
  });

  it('keeps .fields readable and empty when the API names no field, or names it badly', async () => {
    const { api } = transport({
      responses: [
        json(403, { error: { code: 'AUTH_CSRF_FAILED', message: 'refused', correlationId: 'corr-1' } }),
        json(400, { error: { code: 'REQUEST_VALIDATION_FAILED', message: 'no detail', correlationId: 'corr-2', fields: [{ rule: 'missing path' }, null, 'nope'] } }),
      ],
    });

    const withoutFields = await api.session.logout().catch((error: unknown) => error) as ApiFailure;
    expect(withoutFields.fields).toEqual([]);

    const malformed = await api.auth.register({}).catch((error: unknown) => error) as ApiFailure;
    // A field entry without a path is dropped rather than rendered as `undefined`.
    expect(malformed.fields).toEqual([]);
  });

  it('reports an unreadable error body instead of claiming the call succeeded', async () => {
    const { api } = transport({ responses: [{ ok: false, status: 500, text: async () => '<html>proxy error</html>' }] });
    const failure = await api.session.me().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect((failure as ApiFailure).code).toBe('UNPARSED_RESPONSE');
    expect((failure as ApiFailure).status).toBe(500);
  });

  it('returns null data when the API answers with an empty body', async () => {
    const { api } = transport({ responses: [{ ok: true, status: 204, text: async () => '' }] });
    const result = await api.session.logout();
    expect(result).toMatchObject({ status: 204, data: null });
  });

  it('encodes query values it is given rather than concatenating them blindly', async () => {
    const { api, calls } = transport();
    await api.financial.monthlyActuals('2026-10');
    await api.financial.transactions('?limit=50&kind=income');
    expect(calls[0]?.url).toBe('/api/v1/reports/monthly-actuals?month=2026-10');
    expect(calls[1]?.url).toBe('/api/v1/transactions?limit=50&kind=income');
  });

  it('builds versioned v4-shaped idempotency keys without a crypto.subtle dependency', () => {
    const key = newIdempotencyKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(key);
  });

  it('falls back to a random UUID when crypto.randomUUID is unavailable (non-secure contexts)', () => {
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: { getRandomValues: (array: Uint8Array) => { for (let index = 0; index < array.length; index += 1) array[index] = index * 7 % 256; return array; } },
      });
      const key = newIdempotencyKey();
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
    }
  });
});
