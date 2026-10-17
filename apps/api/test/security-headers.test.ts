import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_CSP,
  DOCUMENT_CSP,
  registerSecurityHeaders,
  securityHeadersFor,
} from '../src/security-headers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWithHeaders(hstsMaxAgeSeconds: number): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerSecurityHeaders(app, { hstsMaxAgeSeconds });
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send('<html></html>'));
  app.get('/api/v1/ping', async () => ({ ok: true }));
  app.get('/asset.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send('export {};'));
  apps.push(app);
  await app.ready();
  return app;
}

describe('security headers', () => {
  it('hardens an HTML document and forbids framing, inline script and foreign origins', async () => {
    const app = await appWithHeaders(31_536_000);
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toBe(DOCUMENT_CSP);
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');

    const policy = String(response.headers['content-security-policy']);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('gives a JSON API response an inert policy that cannot be framed', async () => {
    const app = await appWithHeaders(31_536_000);
    const response = await app.inject({ method: 'GET', url: '/api/v1/ping' });

    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-security-policy']).toBe(API_CSP);
    expect(API_CSP).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('covers scripts and errors, not just successful HTML', async () => {
    const app = await appWithHeaders(31_536_000);

    const script = await app.inject({ method: 'GET', url: '/asset.js' });
    expect(script.headers['x-content-type-options']).toBe('nosniff');
    expect(script.headers['content-security-policy']).toBe(API_CSP);

    const missing = await app.inject({ method: 'GET', url: '/not-there' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['x-content-type-options']).toBe('nosniff');
    expect(missing.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');

    const rejected = await app.inject({ method: 'POST', url: '/api/v1/ping', payload: {} });
    expect(rejected.statusCode).toBe(404);
    expect(rejected.headers['referrer-policy']).toBe('no-referrer');
  });

  it('omits HSTS entirely when the lifetime is zero', () => {
    const headers = securityHeadersFor('text/html; charset=utf-8', { hstsMaxAgeSeconds: 0 });
    expect(headers['strict-transport-security']).toBeUndefined();
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not overwrite a header a route set deliberately', async () => {
    const app = Fastify({ logger: false });
    registerSecurityHeaders(app, { hstsMaxAgeSeconds: 0 });
    app.get('/custom', async (_request, reply) => reply
      .header('referrer-policy', 'same-origin')
      .type('text/plain; charset=utf-8')
      .send('ok'));
    apps.push(app);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/custom' });
    expect(response.headers['referrer-policy']).toBe('same-origin');
  });

  it('evaluates the policy per content type, not per route', () => {
    expect(securityHeadersFor('text/html', { hstsMaxAgeSeconds: 60 })['content-security-policy'])
      .toBe(DOCUMENT_CSP);
    expect(securityHeadersFor(undefined, { hstsMaxAgeSeconds: 60 })['content-security-policy'])
      .toBe(API_CSP);
  });
});
