#!/usr/bin/env node
/**
 * Production artifact smoke test.
 *
 * Starts the real artifact — `node apps/api/dist/server.bundle.mjs`, the file
 * `pnpm start` runs — with `NODE_ENV=production`, and checks the deployment
 * contract a staging deploy depends on:
 *
 *   - the process boots without `tsx` and without any TypeScript source;
 *   - `/health/live` and a database-backed `/health/ready` answer;
 *   - the compiled client is served from the same origin as the API;
 *   - a missing asset is a 404, not the HTML entry point;
 *   - an unknown client route falls back to the entry point;
 *   - an unknown API route stays a JSON 404;
 *   - a protected API route answers 401 with `Cache-Control: no-store`;
 *   - the deployed-path security headers are present (HSTS, CSP, nosniff,
 *     referrer policy, framing denial) on HTML, assets and JSON alike;
 *   - the production guards still refuse insecure cookies and a mail-less boot.
 *
 * Required environment (the same values a deploy supplies):
 *   DATABASE_URL, AUTH_SECRET, FINANCIAL_PREVIEW_SIGNING_KEY,
 *   IDEMPOTENCY_RETENTION_HOURS
 * Everything else is defaulted here so the smoke test does not need real mail
 * credentials: it never sends a message.
 *
 * Run: corepack pnpm run build && corepack pnpm run smoke:production
 *
 * The same script verifies a production-only install: set SMOKE_ENTRYPOINT to
 * the artifact inside that install and SMOKE_CWD to its directory (see
 * `scripts/verify-production-install.mjs`).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoint = process.env.SMOKE_ENTRYPOINT
  ? path.resolve(process.env.SMOKE_ENTRYPOINT)
  : path.join(repoRoot, 'apps', 'api', 'dist', 'server.bundle.mjs');
/** Where the process starts. A production install runs from its own directory. */
const runCwd = process.env.SMOKE_CWD ? path.resolve(process.env.SMOKE_CWD) : repoRoot;

const REQUIRED = ['DATABASE_URL', 'AUTH_SECRET', 'FINANCIAL_PREVIEW_SIGNING_KEY', 'IDEMPOTENCY_RETENTION_HOURS'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`production smoke test needs: ${missing.join(', ')}`);
  process.exit(2);
}

const port = Number(process.env.SMOKE_PORT ?? 20000 + Math.floor(Math.random() * 20000));
const base = `http://127.0.0.1:${port}`;
const checks = [];

function baseEnv(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE ?? 'disable',
    AUTH_COOKIE_SECURE: 'true',
    EMAIL_DELIVERY_ADAPTER: 'resend',
    RESEND_API_KEY: 're_smoke_not_a_real_key',
    EMAIL_FROM_ADDRESS: 'KFin Smoke <smoke@kfin.invalid>',
    EMAIL_PROVIDER_BASE_URL: 'http://127.0.0.1:1',
    ...overrides,
  };
}

function startServer(overrides = {}) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: runCwd,
    env: baseEnv(overrides),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForReady(deadlineMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`${base}/health/ready`);
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not become ready within ${deadlineMs}ms`);
}

function record(name, ok, detail) {
  checks.push({ name, status: ok ? 'pass' : 'fail', ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${name}: ${detail}`);
}

function expect(condition, detail) {
  if (!condition) throw new Error(detail);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function expectBootRefused(name, overrides, pattern) {
  const { child, output } = startServer(overrides);
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 15_000);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  const text = output();
  record(name, exitCode !== 0 && pattern.test(text), `exit=${exitCode} output=${text.slice(-400)}`);
}

async function main() {
  const server = startServer();
  try {
    await waitForReady();

    const live = await fetch(`${base}/health/live`);
    record('health.live', live.status === 200, `status=${live.status}`);

    const ready = await fetch(`${base}/health/ready`);
    const readyBody = await ready.json();
    record('health.ready', ready.status === 200 && readyBody.database === 'ready', JSON.stringify(readyBody));

    const index = await fetch(`${base}/`);
    const indexBody = await index.text();
    record(
      'client.index',
      index.status === 200
        && (index.headers.get('content-type') ?? '').includes('text/html')
        && indexBody.includes('id="app"')
        && indexBody.includes('/src/main.js'),
      `status=${index.status} type=${index.headers.get('content-type')}`,
    );
    record('client.nosniff', index.headers.get('x-content-type-options') === 'nosniff',
      `x-content-type-options=${index.headers.get('x-content-type-options')}`);

    const module = await fetch(`${base}/src/main.js`);
    const moduleBody = await module.text();
    record(
      'client.module',
      module.status === 200
        && (module.headers.get('content-type') ?? '').startsWith('text/javascript')
        && moduleBody.length > 0,
      `status=${module.status} type=${module.headers.get('content-type')} bytes=${moduleBody.length}`,
    );

    const styles = await fetch(`${base}/src/styles.css`);
    record(
      'client.stylesheet',
      styles.status === 200 && (styles.headers.get('content-type') ?? '').startsWith('text/css'),
      `status=${styles.status} type=${styles.headers.get('content-type')}`,
    );

    const missingAsset = await fetch(`${base}/src/not-built.js`);
    record(
      'client.missing-asset-is-404',
      missingAsset.status === 404 && (missingAsset.headers.get('content-type') ?? '').startsWith('text/plain'),
      `status=${missingAsset.status} type=${missingAsset.headers.get('content-type')}`,
    );

    const clientRoute = await fetch(`${base}/money`);
    const clientRouteBody = await clientRoute.text();
    record(
      'client.spa-fallback',
      clientRoute.status === 200 && clientRouteBody.includes('id="app"'),
      `status=${clientRoute.status}`,
    );

    const unknownApi = await fetch(`${base}/api/v1/does-not-exist`);
    const unknownApiBody = await unknownApi.text();
    record(
      'api.unknown-route-is-json-404',
      unknownApi.status === 404
        && (unknownApi.headers.get('content-type') ?? '').includes('application/json')
        && unknownApiBody.includes('Not Found'),
      `status=${unknownApi.status} type=${unknownApi.headers.get('content-type')}`,
    );

    const protectedRoute = await fetch(`${base}/api/v1/auth/me`);
    record(
      'api.protected-route',
      protectedRoute.status === 401 && protectedRoute.headers.get('cache-control') === 'no-store',
      `status=${protectedRoute.status} cache-control=${protectedRoute.headers.get('cache-control')}`,
    );

    const hsts = index.headers.get('strict-transport-security') ?? '';
    record('headers.hsts', hsts.startsWith('max-age=') && hsts.includes('includeSubDomains'), hsts);

    const htmlCsp = index.headers.get('content-security-policy') ?? '';
    record(
      'headers.document-csp',
      htmlCsp.includes("default-src 'self'")
        && htmlCsp.includes("frame-ancestors 'none'")
        && htmlCsp.includes("object-src 'none'")
        && !htmlCsp.includes('unsafe-inline'),
      htmlCsp,
    );

    const apiCsp = protectedRoute.headers.get('content-security-policy') ?? '';
    record('headers.api-csp', apiCsp.includes("default-src 'none'") && apiCsp.includes("frame-ancestors 'none'"), apiCsp);

    for (const [name, headers] of [['html', index.headers], ['module', module.headers], ['api', protectedRoute.headers]]) {
      record(`headers.hardening.${name}`,
        headers.get('x-content-type-options') === 'nosniff'
          && headers.get('referrer-policy') === 'no-referrer'
          && headers.get('x-frame-options') === 'DENY'
          && headers.get('cross-origin-opener-policy') === 'same-origin',
        JSON.stringify({
          nosniff: headers.get('x-content-type-options'),
          referrer: headers.get('referrer-policy'),
          frame: headers.get('x-frame-options'),
          coop: headers.get('cross-origin-opener-policy'),
        }));
    }

    await expectBootRefused(
      'guard.insecure-cookie-refused',
      { AUTH_COOKIE_SECURE: 'false' },
      /AUTH_COOKIE_SECURE/,
    );
    await expectBootRefused(
      'guard.missing-mail-refused',
      { EMAIL_DELIVERY_ADAPTER: 'none' },
      /EMAIL_DELIVERY_ADAPTER/,
    );
  } finally {
    await stop(server.child);
  }

  process.stdout.write(`${JSON.stringify({ status: 'pass', entrypoint, cwd: runCwd, checks }, null, 2)}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: 'fail', error: error.message, checks }, null, 2)}\n`);
  process.exitCode = 1;
});
