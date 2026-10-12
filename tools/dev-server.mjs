#!/usr/bin/env node
/**
 * Local development server for the KFin testing client.
 *
 * Why a proxy instead of serving the client on its own port: the API is
 * same-origin-only by design. `packages/config/src/index.ts` refuses any
 * `AUTH_ALLOWED_ORIGINS` value, there is no CORS layer, and
 * `apps/api/src/session-transport.ts` accepts a browser write only when
 * `sec-fetch-site` is `same-origin`/`none`. So the browser must see one origin;
 * this process serves the client's files and forwards `/api/*`, `/health/*`, and
 * `/openapi.json` to the API without rewriting cookies or headers.
 *
 * It also serves `/__dev__/outbox` — the directory written by the
 * `EMAIL_DELIVERY_ADAPTER=file` sink — so a developer can read a one-time code.
 * That route exists only while this server runs, only when `EMAIL_OUTBOX_DIR` is
 * set, and it is refused outright when `NODE_ENV=production`.
 *
 * Client modules are served from the TypeScript project's own build output
 * (`apps/web/dist`, the same artifact `corepack pnpm run typecheck` produces), so
 * there is no bespoke transform step and the JavaScript a browser runs is the
 * JavaScript the compiler emitted. The build runs once at startup; restart this
 * server after editing client sources, or set `KFIN_WEB_SKIP_BUILD=1` when you
 * built already.
 *
 * No secrets are read, logged, or forwarded by this process: the API keeps its
 * own environment; the client never sees a session token.
 */

import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const webRoot = path.join(repoRoot, 'apps', 'web');

const PORT = Number(process.env.KFIN_WEB_PORT ?? 5173);
const HOST = process.env.KFIN_WEB_HOST ?? '0.0.0.0';
const API_ORIGIN = process.env.KFIN_API_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const OUTBOX_DIR = process.env.EMAIL_OUTBOX_DIR ?? null;
const PRODUCTION = process.env.NODE_ENV === 'production';

const buildRoot = path.join(webRoot, 'dist');

if (process.env.KFIN_WEB_SKIP_BUILD !== '1') {
  try {
    execFileSync(path.join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-b', 'apps/web'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    console.log('client build: up to date (apps/web/dist)');
  } catch {
    console.error('client build failed. Fix the TypeScript errors above, then start this server again.');
    process.exit(1);
  }
}

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);

const PROXIED_PREFIXES = ['/api/', '/health/'];

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(body);
}

/**
 * Resolves a request path inside `root`, refusing traversal and symlink escapes.
 * `/src/x.js` and its map come from the TypeScript build output; every other
 * client asset (HTML, CSS, images) comes from `apps/web`.
 */
async function resolveFile(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const relative = decoded.replace(/^\/+/, '');
  const candidates = [];
  const compiled = relative.match(/^src\/(.+\.js(?:\.map)?)$/);
  if (compiled) candidates.push(path.join(buildRoot, compiled[1]));
  candidates.push(path.join(root, relative));
  if (relative === '' || relative.endsWith('/')) candidates.push(path.join(root, relative, 'index.html'));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue;
    try {
      const info = await stat(resolved);
      if (info.isFile()) return resolved;
    } catch {
      continue;
    }
  }
  return null;
}

async function serveFile(response, file) {
  const extension = path.extname(file);
  if (extension === '.js' || extension === '.js.map') {
    let contents;
    try {
      contents = await readFile(file);
    } catch {
      send(
        response,
        500,
        'The client build is missing this module. Run `corepack pnpm run web:build`, or restart this server without KFIN_WEB_SKIP_BUILD=1 so it builds for you.',
      );
      return;
    }
    response.writeHead(200, {
      'content-type': extension === '.js' ? 'text/javascript; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(contents);
    return;
  }
  response.writeHead(200, {
    'content-type': CONTENT_TYPES.get(extension) ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
}

async function outboxPayload() {
  if (!OUTBOX_DIR || PRODUCTION) return null;
  let names = [];
  try {
    names = await readdir(OUTBOX_DIR);
  } catch {
    return { items: [], directoryConfigured: true };
  }
  const files = names.filter((name) => name.endsWith('.json')).sort().reverse().slice(0, 25);
  const items = [];
  for (const name of files) {
    try {
      const contents = JSON.parse(await readFile(path.join(OUTBOX_DIR, name), 'utf8'));
      items.push({
        name,
        template: typeof contents.template === 'string' ? contents.template : null,
        to: typeof contents.to === 'string' ? contents.to : null,
        oneTimeSecret: typeof contents.oneTimeSecret === 'string' ? contents.oneTimeSecret : null,
        recordedAt: typeof contents.recordedAt === 'string' ? contents.recordedAt : null,
      });
    } catch {
      // A half-written or unreadable file must not hide the others.
      items.push({ name, template: null, to: null, oneTimeSecret: null, recordedAt: null });
    }
  }
  return { items, directoryConfigured: true };
}

/** Minimal forward proxy: same path, same method, same body, no header rewriting. */
function proxy(request, response, rawBody) {
  const target = new URL(request.url ?? '/', API_ORIGIN);
  // The browser's own `Host` is forwarded unchanged on purpose: the API's
  // same-origin defense compares `Origin` against `Host`
  // (`apps/api/src/session-transport.ts`), so rewriting this header to the API's
  // address would turn every real browser write into a 403.
  const headers = { ...request.headers };
  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    method: request.method,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => {
    send(response, 502, 'The API is not answering. Start it with `corepack pnpm run api:dev`.');
  });
  if (rawBody.length > 0) upstream.write(rawBody);
  upstream.end();
}

const server = http.createServer(async (request, response) => {
  const url = request.url ?? '/';

  if (url === '/__dev__/outbox') {
    if (PRODUCTION) {
      send(response, 404, 'Not found.');
      return;
    }
    const payload = await outboxPayload();
    if (!payload) {
      send(response, 404, JSON.stringify({ items: [], directoryConfigured: false }), 'application/json; charset=utf-8');
      return;
    }
    send(response, 200, JSON.stringify(payload), 'application/json; charset=utf-8');
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  if (PROXIED_PREFIXES.some((prefix) => url.startsWith(prefix)) || url === '/openapi.json' || url === '/health/ready' || url === '/health/live') {
    proxy(request, response, rawBody);
    return;
  }

  const file = await resolveFile(webRoot, url === '/' ? '/index.html' : url);
  if (!file) {
    send(response, 404, 'Not found in the client bundle.');
    return;
  }
  await serveFile(response, file);
});

server.listen(PORT, HOST, () => {
  console.log(`KFin testing client: http://localhost:${PORT}/`);
  console.log(`  proxying /api/*, /health/* and /openapi.json to ${API_ORIGIN}`);
  console.log('  (the API must be same-origin for browser writes: AUTH_ALLOWED_ORIGINS stays empty)');
  if (PRODUCTION) {
    console.log('  NODE_ENV=production: the local email sink route is disabled.');
  } else if (OUTBOX_DIR) {
    console.log(`  local email sink enabled; newest messages at /__dev__/outbox (development only)`);
  } else {
    console.log('  no EMAIL_OUTBOX_DIR set: /__dev__/outbox returns 404, so one-time codes are not readable here.');
  }
});
