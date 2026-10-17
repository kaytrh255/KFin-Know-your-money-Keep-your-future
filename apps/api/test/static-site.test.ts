import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isApiPath, registerStaticSite, resolveSiteFile } from '../src/static-site.js';

let root: string;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'kfin-static-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><div id="app"></div><script type="module" src="/src/main.js"></script>');
  await writeFile(path.join(root, 'src', 'main.js'), 'export const booted = true;\n');
  await writeFile(path.join(root, 'src', 'styles.css'), ':root { color-scheme: light; }\n');
  await writeFile(path.join(root, 'src', 'main.js.map'), '{}\n');
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWithSite(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerStaticSite(app, { root });
  await app.ready();
  apps.push(app);
  return app;
}

describe('static client serving', () => {
  it('serves the entry document at the root with revalidation and nosniff', async () => {
    const app = await appWithSite();
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers.etag).toBeDefined();
    expect(response.body).toContain('<div id="app"></div>');
  });

  it('serves compiled modules and the stylesheet with their real content types', async () => {
    const app = await appWithSite();

    const module = await app.inject({ method: 'GET', url: '/src/main.js' });
    expect(module.statusCode).toBe(200);
    expect(module.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(module.body).toContain('booted');

    const styles = await app.inject({ method: 'GET', url: '/src/styles.css' });
    expect(styles.statusCode).toBe(200);
    expect(styles.headers['content-type']).toBe('text/css; charset=utf-8');

    const map = await app.inject({ method: 'GET', url: '/src/main.js.map' });
    expect(map.statusCode).toBe(200);
    expect(map.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('answers a missing asset with a 404 instead of the HTML entry point', async () => {
    const app = await appWithSite();
    const response = await app.inject({ method: 'GET', url: '/src/not-built.js' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.body).not.toContain('<div id="app">');
  });

  it('falls back to the entry document for an unknown client route', async () => {
    const app = await appWithSite();
    const response = await app.inject({ method: 'GET', url: '/money/accounts?tab=open' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('<div id="app"></div>');
  });

  it('keeps an unknown API or health route a JSON 404', async () => {
    const app = await appWithSite();

    for (const url of ['/api/v1/does-not-exist', '/health/does-not-exist']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(JSON.parse(response.body)).toMatchObject({ statusCode: 404, error: 'Not Found' });
    }
  });

  it('revalidates a cached file with an ETag and answers 304 without a body', async () => {
    const app = await appWithSite();
    const first = await app.inject({ method: 'GET', url: '/src/main.js' });
    const etag = first.headers.etag as string;

    const second = await app.inject({ method: 'GET', url: '/src/main.js', headers: { 'if-none-match': etag } });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('answers a HEAD request without a body', async () => {
    const app = await appWithSite();
    const response = await app.inject({ method: 'HEAD', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
  });

  it('refuses to register when the artifact has no index.html', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'kfin-static-empty-'));
    const app = Fastify({ logger: false });
    try {
      await expect(registerStaticSite(app, { root: empty })).rejects.toThrow(/index\.html/);
    } finally {
      await app.close();
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('static path resolution', () => {
  it('refuses decoded traversal instead of reading outside the web root', () => {
    expect(resolveSiteFile('/srv/web', '/src/../../package.json')).toBeNull();
    expect(resolveSiteFile('/srv/web', '/src/%2e%2e/%2e%2e/package.json')).toBeNull();
    expect(resolveSiteFile('/srv/web', '/src/%00main.js')).toBeNull();
  });

  it('resolves an ordinary asset inside the root', () => {
    expect(resolveSiteFile('/srv/web', '/src/main.js')).toBe(path.resolve('/srv/web/src/main.js'));
    expect(resolveSiteFile('/srv/web', '/index.html')).toBe(path.resolve('/srv/web/index.html'));
  });

  it('classifies API and health paths separately from browser routes', () => {
    expect(isApiPath('/api/v1/auth/session')).toBe(true);
    expect(isApiPath('/health/ready')).toBe(true);
    expect(isApiPath('/openapi.json')).toBe(true);
    expect(isApiPath('/money')).toBe(false);
    expect(isApiPath('/')).toBe(false);
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
