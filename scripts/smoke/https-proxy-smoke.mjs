#!/usr/bin/env node
/**
 * Runs the production artifact behind a TLS-terminating reverse proxy.
 *
 * No request had ever traversed a real HTTPS proxy, so the deployed path was
 * only assumed. This script closes that gap with an executable check:
 *
 *   1. generates a throwaway self-signed certificate with `openssl`;
 *   2. starts `apps/api/dist/server.bundle.mjs` with NODE_ENV=production on
 *      plain HTTP, exactly as a container does behind a proxy;
 *   3. starts an HTTPS reverse proxy in front of it that preserves `Host`,
 *      appends the browser address to `X-Forwarded-For` and sets
 *      `X-Forwarded-Proto: https`;
 *   4. drives real HTTPS requests through that proxy and checks the browser
 *      contract: HSTS and the hardening headers, the client and its modules,
 *      a same-origin write that is processed, a cross-site write that is
 *      refused, and — when an operator connection is available — a full
 *      invitation → register → login journey whose cookies must carry the
 *      `__Host-` prefix.
 *
 * Required environment: DATABASE_URL, AUTH_SECRET,
 * FINANCIAL_PREVIEW_SIGNING_KEY, IDEMPOTENCY_RETENTION_HOURS.
 * Optional: OPERATOR_DATABASE_URL (enables the register/login journey).
 *
 * Run: corepack pnpm run build && corepack pnpm run smoke:https
 */

import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoint = path.join(repoRoot, 'apps', 'api', 'dist', 'server.bundle.mjs');

const REQUIRED = ['DATABASE_URL', 'AUTH_SECRET', 'FINANCIAL_PREVIEW_SIGNING_KEY', 'IDEMPOTENCY_RETENTION_HOURS'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`https smoke test needs: ${missing.join(', ')}`);
  process.exit(2);
}

const appPort = Number(process.env.SMOKE_APP_PORT ?? 21000 + Math.floor(Math.random() * 2000));
const tlsPort = Number(process.env.SMOKE_TLS_PORT ?? 23000 + Math.floor(Math.random() * 2000));
const tlsOrigin = `https://127.0.0.1:${tlsPort}`;
const checks = [];
let certificateDirectory = null;
let appProcess = null;
let proxy = null;

function record(name, ok, detail) {
  checks.push({ name, status: ok ? 'pass' : 'fail', ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${name}: ${detail}`);
}

async function startApp() {
  appProcess = spawn(process.execPath, [entrypoint], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(appPort),
      DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE ?? 'disable',
      AUTH_COOKIE_SECURE: 'true',
      // Trust only the loopback proxy this script starts.
      TRUST_PROXY: '127.0.0.1',
      EMAIL_DELIVERY_ADAPTER: 'resend',
      RESEND_API_KEY: 're_smoke_not_a_real_key',
      EMAIL_FROM_ADDRESS: 'KFin Smoke <smoke@kfin.invalid>',
      EMAIL_PROVIDER_BASE_URL: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  appProcess.stdout.on('data', (chunk) => { output += chunk; });
  appProcess.stderr.on('data', (chunk) => { output += chunk; });

  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const ok = await new Promise((resolve) => {
      const probe = httpRequest({ host: '127.0.0.1', port: appPort, path: '/health/ready', method: 'GET' }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      probe.on('error', () => resolve(false));
      probe.end();
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`the artifact did not become ready on 127.0.0.1:${appPort}:\n${output.slice(-800)}`);
}

/** Generates a self-signed certificate for 127.0.0.1/localhost. */
function generateCertificate() {
  return mkdtemp(path.join(tmpdir(), 'kfin-tls-')).then((directory) => {
    certificateDirectory = directory;
    const key = path.join(directory, 'key.pem');
    const cert = path.join(directory, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    return { key, cert };
  });
}

/**
 * Minimal TLS terminator: forwards the request unchanged to the artifact with a
 * preserved Host, an added X-Forwarded-For, and X-Forwarded-Proto: https.
 */
async function startProxy(files) {
  const [key, cert] = await Promise.all([readFile(files.key), readFile(files.cert)]);
  proxy = createHttpsServer({ key, cert }, (browserRequest, browserResponse) => {
    const forwardedFor = [browserRequest.socket.remoteAddress, browserRequest.headers['x-forwarded-for']]
      .filter(Boolean).join(', ');
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: appPort,
      path: browserRequest.url,
      method: browserRequest.method,
      headers: {
        ...browserRequest.headers,
        host: browserRequest.headers.host,
        'x-forwarded-for': forwardedFor,
        'x-forwarded-proto': 'https',
      },
    }, (upstreamResponse) => {
      browserResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(browserResponse);
    });
    upstream.on('error', () => {
      browserResponse.writeHead(502);
      browserResponse.end('upstream unavailable');
    });
    browserRequest.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(tlsPort, '127.0.0.1', resolve);
  });
}

/** HTTPS request against the self-signed proxy. Resolves status, headers and body. */
function httpsFetch(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const request = httpsRequest({
      host: '127.0.0.1',
      port: tlsPort,
      path: pathname,
      method: options.method ?? 'GET',
      rejectUnauthorized: false,
      headers: {
        ...(body === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
        ...(options.headers ?? {}),
      },
    }, (response) => {
      let received = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { received += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: received }));
    });
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

async function provisionInvitation() {
  const operatorUrl = process.env.OPERATOR_DATABASE_URL;
  if (!operatorUrl) return null;
  const output = execFileSync(process.execPath, [path.join(repoRoot, 'apps', 'api', 'dist', 'provision-invitation.bundle.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPERATOR_DATABASE_URL: operatorUrl,
      DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE ?? 'disable',
    },
    encoding: 'utf8',
  });
  const match = /code\s*:\s*(\S+)/.exec(output);
  return match?.[1] ?? null;
}

async function main() {
  const files = await generateCertificate();
  record('tls.certificate', true, 'self-signed, 1 day, 127.0.0.1');

  await startApp();
  record('app.ready', true, `127.0.0.1:${appPort}`);

  await startProxy(files);
  record('tls.proxy', true, tlsOrigin);

  // 1. The document arrives over TLS with the deployment headers.
  const index = await httpsFetch('/');
  record('https.document', index.status === 200 && index.body.includes('id="app"'), `status=${index.status}`);
  const hsts = index.headers['strict-transport-security'] ?? '';
  record('https.hsts', hsts.startsWith('max-age=') && hsts.includes('includeSubDomains'), hsts);
  record(
    'https.document-csp',
    (index.headers['content-security-policy'] ?? '').includes("frame-ancestors 'none'")
      && (index.headers['content-security-policy'] ?? '').includes("default-src 'self'"),
    index.headers['content-security-policy'],
  );
  record(
    'https.hardening',
    index.headers['x-content-type-options'] === 'nosniff'
      && index.headers['referrer-policy'] === 'no-referrer'
      && index.headers['x-frame-options'] === 'DENY',
    'nosniff / no-referrer / DENY',
  );

  // 2. The compiled module is served as JavaScript, not guesses.
  const module = await httpsFetch('/src/main.js');
  record(
    'https.module',
    module.status === 200 && String(module.headers['content-type']).startsWith('text/javascript'),
    `status=${module.status} type=${module.headers['content-type']}`,
  );

  // 3. A same-origin browser write is processed, not refused by the CSRF origin check.
  const sameOrigin = await httpsFetch('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'nobody@example.invalid', password: 'correct horse battery staple' },
    headers: { origin: tlsOrigin, 'sec-fetch-site': 'same-origin' },
  });
  record(
    'https.same-origin-write-accepted',
    sameOrigin.status !== 403,
    `status=${sameOrigin.status} body=${sameOrigin.body.slice(0, 160)}`,
  );

  // 4. The same write from a foreign origin is refused.
  const crossOrigin = await httpsFetch('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'nobody@example.invalid', password: 'correct horse battery staple' },
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  record('https.cross-origin-write-refused', crossOrigin.status === 403, `status=${crossOrigin.status}`);

  // 5. A head request over TLS answers without a body.
  const head = await httpsFetch('/', { method: 'HEAD' });
  record('https.head', head.status === 200 && head.body === '', `status=${head.status}`);

  // 6. Optional: the real invitation → register → login journey over TLS. The
  // session cookie must be host-prefixed, which is only valid over HTTPS.
  const invitationCode = await provisionInvitation();
  if (invitationCode === null) {
    record('https.cookie-journey', true, 'skipped: OPERATOR_DATABASE_URL not set');
  } else {
    const email = `https.smoke.${Date.now()}@example.invalid`;
    const password = 'a sufficiently long beta passphrase';
    const registration = await httpsFetch('/api/v1/auth/register', {
      method: 'POST',
      body: {
        email,
        password,
        invitationCode,
        locale: 'vi',
        timezone: 'Asia/Ho_Chi_Minh',
        baseCurrency: 'VND',
      },
      headers: { origin: tlsOrigin, 'sec-fetch-site': 'same-origin' },
    });
    record('https.register', registration.status === 202, `status=${registration.status} body=${registration.body.slice(0, 160)}`);

    const login = await httpsFetch('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password },
      headers: { origin: tlsOrigin, 'sec-fetch-site': 'same-origin' },
    });
    // Status only: the response carries a live session identifier.
    record('https.login', login.status === 200, `status=${login.status}`);

    const cookies = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : []).join('\n');
    // Report cookie *names and attributes* only: a session token must never be
    // copied into a log, a CI annotation or a report.
    const cookieSummary = cookies.split('\n')
      .map((line) => line.split(';')[0]?.split('=')[0] ?? '')
      .filter((name) => name !== '')
      .join(', ');
    const sessionCookieLine = cookies.split('\n').find((line) => line.startsWith('__Host-kfin_session=')) ?? '';
    record(
      'https.host-prefixed-cookie',
      sessionCookieLine !== ''
        && /;\s*HttpOnly/.test(sessionCookieLine)
        && /;\s*Secure/.test(sessionCookieLine)
        && /;\s*Path=\/(?:;|$)/.test(sessionCookieLine)
        && !/;\s*Domain=/i.test(sessionCookieLine),
      `cookies=${cookieSummary}; session flags=HttpOnly,Secure,Path=/`,
    );
    record('https.csrf-cookie', /(?:^|\n)kfin_csrf=/.test(cookies), 'csrf cookie issued');

    const sessionCookie = cookies.split('\n')
      .map((line) => line.split(';')[0])
      .find((pair) => pair?.startsWith('__Host-kfin_session='));
    const me = await httpsFetch('/api/v1/auth/me', { headers: { cookie: sessionCookie ?? '' } });
    record('https.authenticated-read', me.status === 200 && me.body.includes(email), `status=${me.status}`);
  }

  process.stdout.write(`${JSON.stringify({ status: 'pass', checks }, null, 2)}\n`);
}

async function stop() {
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  if (appProcess && appProcess.exitCode === null) {
    appProcess.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { appProcess.kill('SIGKILL'); resolve(); }, 5_000);
      appProcess.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: 'fail', error: error.message, checks }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await stop();
}
