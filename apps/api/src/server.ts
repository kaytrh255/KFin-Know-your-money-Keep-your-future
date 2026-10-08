import { authPolicy, loadApiConfig } from '@kfin/config';
import {
  PostgresAuthRepository,
  PostgresFinancialRepository,
  PostgresScheduleRepository,
  createDatabaseRuntime,
} from '@kfin/database';
import { buildApp } from './app.js';
import { createEmailDeliveryAdapter } from './email-delivery.js';
import { readCookie, sessionCookieName } from './session-transport.js';

const config = loadApiConfig();
const runtime = createDatabaseRuntime(config.database);
const financialService = new PostgresFinancialRepository(
  runtime.pool,
  config.idempotencyRetentionMs,
  config.financialPreviewSigningKey,
);
const scheduleService = new PostgresScheduleRepository(
  runtime.pool,
  config.idempotencyRetentionMs,
);

const transport = {
  secure: config.authCookieSecure,
  prefixHost: authPolicy.session.cookiePrefixHost,
  allowedOrigins: config.authAllowedOrigins,
};

const authService = new PostgresAuthRepository(runtime.pool, {
  secret: config.authSecret,
  policy: authPolicy,
});
const emailDelivery = createEmailDeliveryAdapter(config.emailDeliveryAdapter);

// Sessions are opaque server-side records. The API resolves the bearer token
// from the host cookie only; no trusted user-ID header shortcut exists.
const cookieName = sessionCookieName(transport);
const app = await buildApp({
  financialService,
  scheduleService,
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
});

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
