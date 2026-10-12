import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RegisterResult } from '@kfin/database';
import { buildApp, type BuildAppOptions, type FinancialApiService } from '../src/app.js';
import { describeRejectedContractRules } from '../src/validation-detail.js';
import { RecordingEmailAdapter } from '../src/email-delivery.js';
import type { AuthApiService } from '../src/auth-routes.js';

/**
 * Regression cover for the failure reported on 2026-10-12: registering from the
 * running client answered
 *
 *   400 REQUEST_VALIDATION_FAILED — "The request does not match the API contract."
 *   correlation id 4f6c54eb-…
 *
 * The correlation id was retained nowhere (request logging is off and the
 * validation branch logged nothing), the field that broke the contract was never
 * named, and for the invitation code the published OpenAPI did not state the rule
 * that had been enforced. The failure was therefore undiscoverable: the caller
 * could not fix the request and the operator could not look up the id.
 *
 * These tests pin the behaviour that makes that failure discoverable: the
 * rejected field and its rule are named, the caller's correlation id is carried
 * back (genReqId honours a UUID `x-correlation-id`, so the id the caller saw can
 * be found in the log), the submitted values are never echoed, and the enforced
 * rules are published in the document callers are pointed at.
 */

const CORRELATION_ID = '4f6c54eb-1a71-4b19-a9c3-be28579bfb99';
const BROWSER_HEADERS = { origin: 'https://api.kfin.test', host: 'api.kfin.test' };

const VALID_CODE = 'ABCDEFGH-JKMNPQRS-TVWXYZ23-456789AB';
const VALID_BODY = {
  email: 'beta.user@example.invalid',
  password: 'correct horse battery staple',
  invitationCode: VALID_CODE,
  locale: 'vi-VN',
  timezone: 'Asia/Ho_Chi_Minh',
  baseCurrency: 'VND',
};

const apps: FastifyInstance[] = [];

async function build(): Promise<{ app: FastifyInstance; register: ReturnType<typeof vi.fn> }> {
  const register = vi.fn(async (): Promise<RegisterResult> => ({
    accepted: true,
    issued: true,
    resendAvailableAt: '2026-10-12T05:00:00.000Z',
    delivery: null,
    userId: null,
  }));
  const app = await buildApp({
    financialService: {} as unknown as FinancialApiService,
    authService: { register } as unknown as AuthApiService,
    emailDelivery: new RecordingEmailAdapter(),
    authTransport: { secure: true, prefixHost: true },
    authenticate: async () => null,
  } satisfies BuildAppOptions);
  apps.push(app);
  return { app, register };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function register(app: FastifyInstance, payload: Record<string, unknown>, correlationId = CORRELATION_ID) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { ...BROWSER_HEADERS, 'x-correlation-id': correlationId },
    payload,
  });
}

describe('rejected contract rules are reported, not hidden', () => {
  it('names the invitation code when the code is not four groups of eight characters', async () => {
    const { app, register: serviceRegister } = await build();
    // The shape a user produces by typing a code by hand or copying part of a line.
    const response = await register(app, { ...VALID_BODY, invitationCode: 'AAAA-BBBB-CCCC-DDDD' });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('REQUEST_VALIDATION_FAILED');
    expect(body.error.fields).toEqual([
      { path: 'invitationCode', rule: expect.stringContaining('does not satisfy a rule') as unknown as string },
    ]);
    // The route's own schema rejects the body: the handler never runs.
    expect(serviceRegister).not.toHaveBeenCalled();
  });

  it('carries the caller correlation id back, so the id can be found in the log', async () => {
    const { app } = await build();
    const response = await register(app, { ...VALID_BODY, invitationCode: 'AAAA-BBBB-CCCC-DDDD' });

    expect(response.json().error.correlationId).toBe(CORRELATION_ID);
  });

  it('names each missing required field instead of returning one opaque message', async () => {
    const { app } = await build();
    const response = await register(app, {
      email: VALID_BODY.email,
      password: VALID_BODY.password,
      invitationCode: VALID_CODE,
    });

    expect(response.statusCode).toBe(400);
    const paths = response.json().error.fields.map((field: { path: string }) => field.path);
    expect(paths).toEqual(['locale', 'timezone', 'baseCurrency']);
  });

  it('names a field the endpoint does not accept, which is what a stale client sends', async () => {
    const { app } = await build();
    const response = await register(app, { ...VALID_BODY, emailVerified: true });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.fields).toEqual([
      { path: 'emailVerified', rule: expect.stringContaining('does not accept this field') as unknown as string },
    ]);
  });

  it('never echoes a submitted password, invitation code, or one-time code', async () => {
    const { app } = await build();
    const password = 'Xy9-Submitted-Password-Do-Not-Echo';
    const invitationCode = 'NOTACODE-1NOTACODE-2NOTACODE-3';
    const response = await register(app, { ...VALID_BODY, password, invitationCode });

    expect(response.statusCode).toBe(400);
    const text = response.body;
    expect(text).not.toContain(password);
    expect(text).not.toContain(invitationCode);
    // Nor may a rejected field list smuggle the value through a rule string.
    for (const field of response.json().error.fields) {
      expect(field.rule).not.toContain(password);
      expect(field.rule).not.toContain(invitationCode);
    }
  });

  it('publishes the invitation-code rule and the field list in the API document', async () => {
    const { app } = await build();
    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const registerOperation = document.paths['/auth/register'].post;

    const publishedCode = registerOperation.requestBody.content['application/json'].schema.properties.invitationCode;
    expect(publishedCode.description).toContain('four groups of eight characters');

    const publishedError = registerOperation.responses['400'].content['application/json'].schema;
    expect(Object.keys(publishedError.properties.error.properties)).toContain('fields');
    expect(publishedError.properties.error.properties.fields.items.properties).toEqual({
      path: expect.objectContaining({ type: 'string' }) as unknown as object,
      rule: expect.objectContaining({ type: 'string' }) as unknown as object,
    });
  });
});

describe('the rejected-rule summary reads only safe parts of a validator entry', () => {
  it('maps a field path and a rule without touching the validator message', () => {
    const fields = describeRejectedContractRules([
      { keyword: 'custom', instancePath: '/invitationCode', params: { input: 'SECRET-CODE' }, message: 'SECRET-CODE is not valid' },
    ]);

    expect(fields).toEqual([{ path: 'invitationCode', rule: expect.stringContaining('does not satisfy a rule') as unknown as string }]);
    expect(JSON.stringify(fields)).not.toContain('SECRET-CODE');
  });

  it('keeps only identifier-shaped unknown keys and caps how many are reported', () => {
    const fields = describeRejectedContractRules([
      { keyword: 'unrecognized_keys', instancePath: '', params: { keys: ['emailVerified', 'bad key\nwith newline', '<script>'] } },
      { keyword: 'unrecognized_keys', instancePath: '', params: { keys: Array.from({ length: 30 }, (_, index) => `key${index}`) } },
    ]);

    const paths = fields.map((field) => field.path);
    expect(paths).toContain('emailVerified');
    expect(paths).not.toContain('bad key\nwith newline');
    expect(paths).not.toContain('<script>');
    expect(fields.length).toBeLessThanOrEqual(20);
  });

  it('reports a whole-body rule without inventing a field name', () => {
    expect(describeRejectedContractRules([{ keyword: 'invalid_type', instancePath: '' }]))
      .toEqual([{ path: '(body)', rule: expect.stringContaining('missing') as unknown as string }]);
  });

  it('returns nothing rather than a guess when there is no usable entry', () => {
    expect(describeRejectedContractRules(undefined)).toEqual([]);
    expect(describeRejectedContractRules('not-an-array')).toEqual([]);
    expect(describeRejectedContractRules([])).toEqual([]);
  });
});
