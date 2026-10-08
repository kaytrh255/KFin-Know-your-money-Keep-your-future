import { loadApiConfig } from '@kfin/config';
import {
  createDatabaseRuntime,
  PostgresFinancialRepository,
  PostgresScheduleRepository,
} from '@kfin/database';
import { buildApp } from './app.js';

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

// Authentication/session implementation is intentionally not bypassed with a
// trusted-header shortcut. Until the session module is wired, protected routes
// fail closed while liveness/readiness remain usable.
const app = await buildApp({
  financialService,
  scheduleService,
  authenticate: async () => null,
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
