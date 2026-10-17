import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * The dev server is the piece that makes the client same-origin, so it is tested
 * the way it is used: a real process, a real upstream, real HTTP.
 *
 * The upstream is a stand-in for the API that echoes what it received; the API
 * itself is not faked anywhere in the client.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const devServerPath = path.join(repoRoot, 'tools', 'dev-server.mjs');

// The compiled client is served as-is, so a run must have a build. Building here
// keeps the test independent of whether anyone ran `pnpm run web:build` first.
beforeAll(() => {
  execFileSync(path.join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-b', 'apps/web'], { cwd: repoRoot });
}, 120_000);

const children: ChildProcess[] = [];
const directories: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface Upstream {
  readonly origin: string;
  readonly requests: Array<{ method: string; url: string; body: string; headers: http.IncomingHttpHeaders }>;
  readonly close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const requests: Upstream['requests'] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method ?? 'GET', url: request.url ?? '/', body, headers: request.headers });
      // The stub always sets one cookie so a case can prove the proxy passes
      // `Set-Cookie` out and the browser's `Cookie` back, unchanged.
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'kfin_probe=1; Path=/; HttpOnly; Secure; SameSite=Lax',
      });
      response.end(JSON.stringify({ method: request.method, url: request.url, body, csrf: request.headers['x-kfin-csrf'] ?? null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startDevServer(environment: Record<string, string>): Promise<number> {
  const port = await freePort();
  // The ambient shell may have sourced .env, which exports EMAIL_OUTBOX_DIR. These
  // cases assert what the dev server does with and without that directory, so each
  // one must state it itself instead of inheriting whatever the developer's shell
  // happens to hold: an inherited value made "no outbox directory is configured"
  // answer 200 where it must answer 404.
  const { EMAIL_OUTBOX_DIR: _ignored, ...ambient } = process.env;
  const child = spawn(process.execPath, [devServerPath], {
    env: { ...ambient, KFIN_WEB_PORT: String(port), KFIN_WEB_HOST: '127.0.0.1', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const started = new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`dev server did not start: ${output}`)), 8_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes('KFin testing client:')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`dev server exited with ${code}: ${output}`)));
  });
  await started;
  return port;
}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * `fetch` cannot set `Host` (it is a forbidden header), and the whole point of
 * these cases is what a proxy does to `Host`, so they go over raw sockets.
 */
function rawRequest(port: number, options: { method: string; path: string; headers: Record<string, string>; body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method: options.method,
      path: options.path,
      headers: options.headers,
    }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function outboxDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kfin-dev-outbox-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local testing client dev server', () => {
  it('serves the shell, the stylesheet and the compiled client modules, and proxies API calls to the API origin', async () => {
    const upstream = await startUpstream();
    const port = await startDevServer({ KFIN_API_ORIGIN: upstream.origin, KFIN_WEB_SKIP_BUILD: '1' });
    const base = `http://127.0.0.1:${port}`;

    const shell = await fetch(`${base}/`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-type')).toContain('text/html');
    expect(await shell.text()).toContain('id="app"');

    const styles = await fetch(`${base}/src/styles.css`);
    expect(styles.headers.get('content-type')).toContain('text/css');

    const module = await fetch(`${base}/src/main.js`);
    expect(module.status).toBe(200);
    expect(module.headers.get('content-type')).toContain('text/javascript');
    const source = await module.text();
    // `/src/*.js` is the TypeScript build output: real JavaScript, original comments kept.
    expect(source).toContain('createApi');
    expect(source).not.toContain('interface SessionState');
    expect(source).toContain("'./views/money.js'");

    const proxied = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kfin-csrf': 'csrf-from-test', origin: base },
      body: JSON.stringify({ email: 'beta.user@example.invalid', password: 'x' }),
    });
    expect(proxied.status).toBe(200);
    const echoed = await proxied.json() as { url: string; csrf: string | null };
    expect(echoed.url).toBe('/api/v1/auth/login');
    expect(echoed.csrf).toBe('csrf-from-test');
    expect(upstream.requests[0]?.body).toBe('{"email":"beta.user@example.invalid","password":"x"}');
    // The API's same-origin defense compares Origin against Host, so the proxy
    // must forward the browser's Host unchanged instead of rewriting it to the
    // API's address — rewriting it makes every real browser write a 403.
    expect(upstream.requests[0]?.headers.host).toBe(`127.0.0.1:${port}`);
    expect(upstream.requests[0]?.headers.origin).toBe(base);

    const readiness = await fetch(`${base}/health/ready`);
    expect(readiness.status).toBe(200);
    expect(upstream.requests[1]?.url).toBe('/health/ready');

    await upstream.close();
  }, 20_000);

  it('passes Set-Cookie out to the browser and the browser Cookie back to the API unchanged', async () => {
    // The 2026-10-13 sign-in bounce was *not* the proxy: a browser that keeps a
    // cookie can sign in through this proxy. This case pins that property, so a
    // future cookie-rewriting change cannot hide a real session loss behind a
    // proxy defect.
    const upstream = await startUpstream();
    const port = await startDevServer({ KFIN_API_ORIGIN: upstream.origin, KFIN_WEB_SKIP_BUILD: '1' });
    const base = `http://127.0.0.1:${port}`;

    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' },
      body: '{"email":"repro@example.invalid","password":"x"}',
    });
    expect(login.status).toBe(200);
    // Attributes arrive exactly as the API wrote them: no Domain rewrite, no
    // SameSite rewrite, HttpOnly intact.
    expect(login.headers.getSetCookie()).toEqual(['kfin_probe=1; Path=/; HttpOnly; Secure; SameSite=Lax']);

    const me = await fetch(`${base}/api/v1/auth/me`, {
      headers: { cookie: 'kfin_probe=1', origin: base, 'sec-fetch-site': 'same-origin' },
    });
    expect(me.status).toBe(200);
    expect(upstream.requests.at(-1)?.url).toBe('/api/v1/auth/me');
    expect(upstream.requests.at(-1)?.headers.cookie).toBe('kfin_probe=1');

    await upstream.close();
  }, 20_000);

  it('keeps the Host/Origin pair consistent when the preview proxy rewrites Host but forwards X-Forwarded-Host', async () => {
    const upstream = await startUpstream();
    const port = await startDevServer({ KFIN_API_ORIGIN: upstream.origin, KFIN_WEB_SKIP_BUILD: '1' });

    const response = await rawRequest(port, {
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: {
        'content-type': 'application/json',
        host: `localhost:${port}`,
        'x-forwarded-host': '5173-preview.e2b.app',
        'x-forwarded-proto': 'https',
        origin: 'https://5173-preview.e2b.app',
        'sec-fetch-site': 'same-origin',
      },
      body: '{"email":"a@example.invalid","password":"x"}',
    });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.headers.host).toBe('5173-preview.e2b.app');
    expect(upstream.requests[0]?.headers.origin).toBe('https://5173-preview.e2b.app');
    await upstream.close();
  }, 20_000);

  it('reconstructs the browser-facing host from the browser Origin when the proxy rewrote Host and forwards nothing else', async () => {
    const upstream = await startUpstream();
    const port = await startDevServer({ KFIN_API_ORIGIN: upstream.origin, KFIN_WEB_SKIP_BUILD: '1' });

    const response = await rawRequest(port, {
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: {
        'content-type': 'application/json',
        host: `localhost:${port}`,
        origin: 'https://5173-preview.e2b.app',
        'sec-fetch-site': 'same-origin',
      },
      body: '{"email":"a@example.invalid","password":"x"}',
    });

    expect(response.status).toBe(200);
    // The API compares Origin with Host, so the proxy must present the host the
    // browser used; otherwise every write is refused with 403.
    expect(upstream.requests[0]?.headers.host).toBe('5173-preview.e2b.app');
    await upstream.close();
  }, 20_000);

  it('refuses a cross-site write itself, without forwarding it to the API', async () => {
    const upstream = await startUpstream();
    const port = await startDevServer({ KFIN_API_ORIGIN: upstream.origin, KFIN_WEB_SKIP_BUILD: '1' });

    const response = await rawRequest(port, {
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: {
        'content-type': 'application/json',
        host: '5173-preview.e2b.app',
        origin: 'https://evil.invalid',
        'sec-fetch-site': 'cross-site',
      },
      body: '{"email":"a@example.invalid","password":"x"}',
    });

    expect(response.status).toBe(403);
    expect(response.body).toContain('LOCAL_PROXY_ORIGIN_REJECTED');
    expect(upstream.requests).toHaveLength(0);
    await upstream.close();
  }, 20_000);

  it('refuses a state-changing request that carries neither Origin nor Sec-Fetch-Site', async () => {
    const upstream = await startUpstream();
    const port = await startDevServer({ KFIN_API_ORIGIN: upstream.origin, KFIN_WEB_SKIP_BUILD: '1' });

    const response = await rawRequest(port, {
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json', host: `localhost:${port}` },
      body: '{"email":"a@example.invalid","password":"x"}',
    });

    expect(response.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
    await upstream.close();
  }, 20_000);

  it('reports the request context without ever echoing a cookie', async () => {
    const upstream = await startUpstream();
    const port = await startDevServer({ KFIN_API_ORIGIN: upstream.origin, KFIN_WEB_SKIP_BUILD: '1' });

    const response = await rawRequest(port, {
      method: 'GET',
      path: '/__dev__/request-context',
      headers: {
        host: '5173-preview.e2b.app',
        origin: 'https://5173-preview.e2b.app',
        'sec-fetch-site': 'same-origin',
        cookie: 'kfin_session=super-secret-session-value; kfin_csrf=csrf-value',
      },
    });

    expect(response.status).toBe(200);
    const context = JSON.parse(response.body) as Record<string, unknown>;
    expect(context.host).toBe('5173-preview.e2b.app');
    expect(context.forwardingHost).toBe('5173-preview.e2b.app');
    expect(context.writeWouldBeForwarded).toBe(true);
    expect(response.body).not.toContain('super-secret-session-value');
    expect(response.body).not.toContain('csrf-value');
    await upstream.close();
  }, 20_000);

  it('refuses to serve files outside the client root', async () => {
    const upstream = await startUpstream();
    const port = await startDevServer({ KFIN_API_ORIGIN: upstream.origin, KFIN_WEB_SKIP_BUILD: '1' });
    const response = await fetch(`http://127.0.0.1:${port}/%2e%2e%2fpackage.json`);
    expect(response.status).toBe(404);
    await upstream.close();
  }, 20_000);

  it('hides the local email sink when no outbox directory is configured', async () => {
    const upstream = await startUpstream();
    const port = await startDevServer({ KFIN_API_ORIGIN: upstream.origin, KFIN_WEB_SKIP_BUILD: '1' });
    const response = await fetch(`http://127.0.0.1:${port}/__dev__/outbox`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ directoryConfigured: false });
    await upstream.close();
  }, 20_000);

  it('exposes the newest messages from the configured outbox directory, and not the whole directory listing', async () => {
    const directory = await outboxDirectory();
    await writeFile(
      path.join(directory, '1000-aaaa.json'),
      JSON.stringify({ to: 'beta.user@example.invalid', template: 'password_reset', correlationId: 'c1', oneTimeSecret: '123456', recordedAt: '2026-10-12T00:00:00.000Z' }),
      'utf8',
    );
    await writeFile(path.join(directory, 'not-json.json'), '{ this file is torn', 'utf8');
    await writeFile(path.join(directory, 'ignored.txt'), 'not a message', 'utf8');

    const upstream = await startUpstream();
    const port = await startDevServer({ KFIN_API_ORIGIN: upstream.origin, EMAIL_OUTBOX_DIR: directory, KFIN_WEB_SKIP_BUILD: '1' });
    const response = await fetch(`http://127.0.0.1:${port}/__dev__/outbox`);
    expect(response.status).toBe(200);
    const payload = await response.json() as { items: Array<{ name: string; oneTimeSecret: string | null; template: string | null }> };
    expect(payload.items.map((item) => item.name).sort()).toEqual(['1000-aaaa.json', 'not-json.json']);
    const real = payload.items.find((item) => item.name === '1000-aaaa.json');
    expect(real).toMatchObject({ oneTimeSecret: '123456', template: 'password_reset' });
    // A torn file yields a placeholder rather than hiding the readable message.
    expect(payload.items.find((item) => item.name === 'not-json.json')?.oneTimeSecret).toBeNull();

    await upstream.close();
  }, 20_000);

  it('answers 502 with a next step when the API is not running', async () => {
    const port = await startDevServer({ KFIN_API_ORIGIN: 'http://127.0.0.1:1', KFIN_WEB_SKIP_BUILD: '1' });
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('api:dev');
  }, 20_000);
});
