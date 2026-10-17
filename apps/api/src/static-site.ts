/**
 * Static client serving for the production topology.
 *
 * Private Beta runs one origin: the API process also serves the compiled web
 * client. That is not a convenience — the browser client is same-origin-only by
 * design (`session-transport.ts` accepts no cross-origin credentialled write, and
 * `AUTH_ALLOWED_ORIGINS` must stay empty), so a separate static host would
 * require a credentialed CORS layer that does not exist.
 *
 * The development server (`tools/dev-server.mjs`) stays the development path;
 * this module serves the build artifact produced by `scripts/build-production.mjs`
 * (`apps/api/dist/web`), which contains `index.html`, `src/styles.css` and the
 * compiled `src/*.js` modules the page references.
 *
 * What it guarantees:
 *  - a request path can never escape the web root (decoded traversal is refused);
 *  - an unknown *asset* is a 404, never `index.html` with a JavaScript content type;
 *  - an unknown browser route falls back to `index.html` (the client routes itself);
 *  - an unknown `/api/*` or `/health/*` route stays a JSON 404, never HTML;
 *  - files are revalidated (`ETag` + `304`), so a deploy is picked up without a
 *    stale asset cache, and every response carries `X-Content-Type-Options: nosniff`.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface StaticSiteOptions {
  /** Absolute directory holding `index.html` and a `src/` subtree. */
  readonly root: string;
}

const CONTENT_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json'],
  ['.woff2', 'font/woff2'],
]);

const API_PREFIXES = ['/api/', '/health/'];

/**
 * Maps a request path to a file inside `root`, or `null` when the path would
 * leave it. `decodeURIComponent` runs first, so `%2e%2e` is caught as `..`.
 */
export function resolveSiteFile(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '');
  if (relative.split(/[\\/]+/).includes('..')) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return null;
  return resolved;
}

/** True for paths whose missing-route answer must stay JSON. */
export function isApiPath(url: string): boolean {
  const pathname = url.split('?')[0] ?? '/';
  return API_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || pathname === '/openapi.json';
}

export async function registerStaticSite(app: FastifyInstance, options: StaticSiteOptions): Promise<void> {
  const root = path.resolve(options.root);
  const indexFile = path.join(root, 'index.html');
  const indexInfo = await stat(indexFile).catch(() => null);
  if (!indexInfo?.isFile()) {
    throw new Error(`Static client root ${root} does not contain index.html; build the production artifact first.`);
  }

  const sendIndex = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await sendFile(request, reply, indexFile);
  };

  app.get('/', sendIndex);
  app.get('/index.html', sendIndex);

  app.get('/src/*', async (request, reply) => {
    const wildcard = (request.params as { '*'?: string })['*'] ?? '';
    const file = resolveSiteFile(root, `/src/${wildcard}`);
    if (file === null) {
      reply.code(404).type('text/plain; charset=utf-8').send('Not found');
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      // A missing module must not become the HTML entry point: the browser would
      // then execute markup as JavaScript and mask the real deployment fault.
      reply.code(404).type('text/plain; charset=utf-8').send('Not found');
      return;
    }
    await sendFile(request, reply, file, info);
  });

  app.setNotFoundHandler(async (request, reply) => {
    const method = request.method.toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    if (!isRead || isApiPath(request.url)) {
      // Same shape Fastify emits for an unknown route, kept JSON for API callers.
      reply.code(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: 'Not Found',
        statusCode: 404,
      });
      return;
    }
    await sendIndex(request, reply);
  });
}

async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: string,
  knownInfo?: Awaited<ReturnType<typeof stat>>,
): Promise<FastifyReply> {
  const info = knownInfo ?? await stat(file).catch(() => null);
  if (!info?.isFile()) {
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  }
  const size = Number(info.size);
  const mtimeMs = Number(info.mtimeMs);
  const etag = `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
  reply
    .header('etag', etag)
    .header('cache-control', 'no-cache')
    .header('last-modified', new Date(mtimeMs).toUTCString())
    .header('x-content-type-options', 'nosniff');
  if (request.headers['if-none-match'] === etag) {
    return reply.code(304).send();
  }
  reply
    .header('content-length', String(size))
    .type(CONTENT_TYPES.get(path.extname(file)) ?? 'application/octet-stream');
  return reply.send(createReadStream(file));
}
