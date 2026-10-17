import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authPolicy, loadApiConfig } from '@kfin/config';
import {
  PostgresAuthRepository,
  PostgresFinancialRepository,
  PostgresSavingsGoalRepository,
  PostgresScheduleRepository,
  assertApplicationDatabaseRole,
  createDatabaseRuntime,
} from '@kfin/database';
import { buildApp } from './app.js';
import { createEmailDeliveryAdapter } from './email-delivery.js';
import { readCookie, sessionCookieName } from './session-transport.js';

const config = loadApiConfig();
const runtime = createDatabaseRuntime(config.database);
// Fail closed before serving any request: RLS and the grant boundary only work
// when the API is the dedicated, non-owner, non-BYPASSRLS application role.
await assertApplicationDatabaseRole(runtime.pool);
const financialService = new PostgresFinancialRepository(
  runtime.pool,
  config.idempotencyRetentionMs,
  config.financialPreviewSigningKey,
);
const scheduleService = new PostgresScheduleRepository(
  runtime.pool,
  config.idempotencyRetentionMs,
);

const savingsService = new PostgresSavingsGoalRepository(runtime.pool, {
  idempotencyRetentionMs: config.idempotencyRetentionMs,
});

// Same-origin only: no credentialed CORS layer exists, so the browser client
// must be served from the API host (see `isBrowserSafeRequest`).
const transport = {
  secure: config.authCookieSecure,
  prefixHost: authPolicy.session.cookiePrefixHost,
};

const authService = new PostgresAuthRepository(runtime.pool, {
  secret: config.authSecret,
  policy: authPolicy,
});
const emailDelivery = createEmailDeliveryAdapter(config.emailDeliveryAdapter, {
  directory: config.emailOutboxDir,
  apiKey: config.resendApiKey,
  from: config.emailFromAddress,
  replyTo: config.emailReplyTo,
  baseUrl: config.emailProviderBaseUrl,
  timeoutMs: config.emailProviderTimeoutMs,
});

// Production runs one origin: this process serves the compiled client it was
// built with (`scripts/build-production.mjs` puts it next to this bundle).
// A production start without that directory is a broken artifact, not a
// configuration the API can improvise around.
const webRoot = config.webClientRoot
  ? path.resolve(config.webClientRoot)
  : fileURLToPath(new URL('./web', import.meta.url));
const staticSite = existsSync(path.join(webRoot, 'index.html')) ? { root: webRoot } : undefined;
if (config.environment === 'production' && !staticSite) {
  throw new Error(
    `The production artifact is incomplete: ${path.join(webRoot, 'index.html')} is missing. `
    + 'Build it with `corepack pnpm run build` instead of starting a source checkout.',
  );
}

// Sessions are opaque server-side records. The API resolves the bearer token
// from the host cookie only; no trusted user-ID header shortcut exists.
const cookieName = sessionCookieName(transport);
const app = await buildApp({
  financialService,
  scheduleService,
  savingsService,
  authService,
  emailDelivery,
  authTransport: transport,
  authAbsoluteLifetimeSeconds: Math.floor(authPolicy.session.absoluteLifetimeMs / 1_000),
  authenticate: async (request) => {
    const token = readCookie(request.headers.cookie, cookieName);
    if (!token) return null;
    return authService.authenticate(token);
  },
  readinessPool: runtime.pool,
  logger: true,
  trustProxy: config.trustedProxies,
  securityHeaders: {
    // HSTS only in production, and only after TLS termination.
    hstsMaxAgeSeconds: config.environment === 'production' ? config.hstsMaxAgeSeconds : 0,
  },
  ...(staticSite ? { staticSite } : {}),
});

if (config.environment === 'production' && config.trustedProxies.length === 0) {
  // Not fatal: a directly reachable API is a valid (if unusual) deployment.
  // But behind a proxy the audit trail would record the proxy address.
  app.log.warn(
    'TRUST_PROXY is empty: request.ip records the direct peer, not the browser. '
    + 'Set it to the reverse proxy address when a proxy terminates TLS.',
  );
}

runtime.pool.on('error', (error) => {
  app.log.error({ errorName: error.name, code: (error as { code?: unknown }).code }, 'Idle database connection error');
});

const close = async () => {
  await app.close();
  await runtime.pool.end();
};
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());

await app.listen({ host: config.host, port: config.port });
