#!/usr/bin/env node
/**
 * Post-deploy smoke test for a staging deployment.
 *
 * Runs from the CI runner (or an operator laptop) against the public HTTPS URL,
 * so it tests the deployed path — DNS, certificate, proxy, Host preservation,
 * the app — not just the container. The same script runs against the rehearsal
 * stack in CI (`https://localhost` with Caddy's internal CA), which is what
 * keeps it honest before it is ever pointed at a real host.
 *
 * Environment:
 *   STAGING_URL                    required, https://host[:port]
 *   STAGING_HTTP_URL               optional, http://host — asserts a redirect to HTTPS
 *   STAGING_CA_FILE                optional PEM to trust (Caddy internal CA)
 *   STAGING_ALLOW_INSECURE_TLS=1   optional, disable verification (local only)
 *   STAGING_EXPECT_HSTS=false      optional, skip the HSTS assertion (HTTP-only host)
 *   STAGING_SMOKE_EMAIL/PASSWORD   optional, adds an authenticated read
 *
 * Prints one JSON report and exits non-zero on the first failure. Cookie values
 * are never printed, only names and attributes.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';

const baseUrl = process.env.STAGING_URL;
if (!baseUrl) {
  console.error('STAGING_URL is required (for example https://staging.example.com)');
  process.exit(2);
}
if (!baseUrl.startsWith('https://') && process.env.STAGING_EXPECT_HSTS !== 'false') {
  console.error('STAGING_URL must be https:// unless STAGING_EXPECT_HSTS=false');
  process.exit(2);
}

const url = new URL(baseUrl);
const ca = process.env.STAGING_CA_FILE ? readFileSync(process.env.STAGING_CA_FILE) : undefined;
const insecure = process.env.STAGING_ALLOW_INSECURE_TLS === '1';
const expectHsts = process.env.STAGING_EXPECT_HSTS !== 'false';
const checks = [];

function record(name, ok, detail) {
  checks.push({ name, status: ok ? 'pass' : 'fail', ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${name}: ${detail}`);
}

function call(target, path, options = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const request = (isHttps ? httpsRequest : httpRequest)({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path,
      method: options.method ?? 'GET',
      timeout: 15_000,
      ...(isHttps ? { rejectUnauthorized: !insecure, ...(ca === undefined ? {} : { ca }) } : {}),
      headers: {
        ...(body === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
        ...(options.headers ?? {}),
      },
    }, (response) => {
      let received = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { received += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: received,
        location: response.headers.location,
      }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

async function main() {
  const origin = url.origin;

  const live = await call(url, '/health/live');
  record('health.live', live.status === 200 && live.body.includes('ok'), `status=${live.status}`);

  const ready = await call(url, '/health/ready');
  let readyBody = {};
  try { readyBody = JSON.parse(ready.body); } catch { /* reported below */ }
  record(
    'health.ready',
    ready.status === 200 && readyBody.database === 'ready',
    `status=${ready.status} body=${ready.body.slice(0, 120)}`,
  );

  const index = await call(url, '/');
  record(
    'client.index',
    index.status === 200
      && String(index.headers['content-type']).includes('text/html')
      && index.body.includes('id="app"')
      && index.body.includes('/src/main.js'),
    `status=${index.status} type=${index.headers['content-type']}`,
  );

  const module = await call(url, '/src/main.js');
  record(
    'client.module',
    module.status === 200 && String(module.headers['content-type']).startsWith('text/javascript') && module.body.length > 0,
    `status=${module.status} type=${module.headers['content-type']} bytes=${module.body.length}`,
  );

  record(
    'headers.hardening',
    index.headers['x-content-type-options'] === 'nosniff'
      && index.headers['referrer-policy'] === 'no-referrer'
      && index.headers['x-frame-options'] === 'DENY',
    JSON.stringify({
      nosniff: index.headers['x-content-type-options'],
      referrer: index.headers['referrer-policy'],
      frame: index.headers['x-frame-options'],
    }),
  );
  record(
    'headers.csp',
    String(index.headers['content-security-policy'] ?? '').includes("frame-ancestors 'none'"),
    String(index.headers['content-security-policy'] ?? '(none)'),
  );
  if (expectHsts) {
    const hsts = String(index.headers['strict-transport-security'] ?? '');
    record('headers.hsts', hsts.startsWith('max-age=') && hsts.includes('includeSubDomains'), hsts || '(none)');
  }

  const protectedRoute = await call(url, '/api/v1/auth/me');
  record('api.protected-route', protectedRoute.status === 401, `status=${protectedRoute.status}`);

  const unknownApi = await call(url, '/api/v1/does-not-exist');
  record(
    'api.unknown-route',
    unknownApi.status === 404 && String(unknownApi.headers['content-type']).includes('application/json'),
    `status=${unknownApi.status}`,
  );

  const crossOrigin = await call(url, '/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'smoke@example.invalid', password: 'not-a-real-password' },
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  record('api.cross-origin-refused', crossOrigin.status === 403, `status=${crossOrigin.status}`);

  const sameOrigin = await call(url, '/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'smoke@example.invalid', password: 'not-a-real-password' },
    headers: { origin, 'sec-fetch-site': 'same-origin' },
  });
  record(
    'api.same-origin-processed',
    sameOrigin.status !== 403,
    `status=${sameOrigin.status} (403 = the origin check refused a same-origin write)`,
  );

  const email = process.env.STAGING_SMOKE_EMAIL;
  const password = process.env.STAGING_SMOKE_PASSWORD;
  if (!email || !password) {
    record('auth.session', true, 'skipped: STAGING_SMOKE_EMAIL/PASSWORD not set');
  } else {
    const login = await call(url, '/api/v1/auth/login', {
      method: 'POST',
      body: { email, password },
      headers: { origin, 'sec-fetch-site': 'same-origin' },
    });
    record('auth.login', login.status === 200, `status=${login.status}`);
    const cookies = Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [];
    const sessionLine = cookies.find((line) => line.startsWith('__Host-kfin_session=')) ?? '';
    const session = sessionLine.split(';')[0];
    record(
      'auth.host-cookie',
      sessionLine !== ''
        && /;\s*HttpOnly/.test(sessionLine)
        && /;\s*Secure/.test(sessionLine)
        && /;\s*Path=\/(?:;|$)/.test(sessionLine)
        && !/;\s*Domain=/i.test(sessionLine)
        && cookies.some((line) => line.startsWith('kfin_csrf=')),
      `cookies=${cookies.map((line) => line.split('=')[0]).join(', ')}; flags=HttpOnly,Secure,Path=/`,
    );
    const me = await call(url, '/api/v1/auth/me', { headers: { cookie: session } });
    record('auth.authenticated-read', me.status === 200 && me.body.includes(email), `status=${me.status}`);
  }

  if (process.env.STAGING_HTTP_URL) {
    const plain = await call(new URL(process.env.STAGING_HTTP_URL), '/health/live');
    record(
      'tls.http-redirects',
      [301, 302, 307, 308].includes(plain.status ?? 0) && String(plain.location ?? '').startsWith('https://'),
      `status=${plain.status} location=${plain.location}`,
    );
  }

  process.stdout.write(`${JSON.stringify({ status: 'pass', url: origin, checks }, null, 2)}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: 'fail', url: url.origin, error: error.message, checks }, null, 2)}\n`);
  process.exitCode = 1;
});
