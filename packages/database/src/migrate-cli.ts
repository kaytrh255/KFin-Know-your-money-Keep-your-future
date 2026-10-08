import { createDatabaseRuntime } from './pool.js';
import { migrateDatabase } from './migrations.js';

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL is required for the separate migration role.');
const sslMode = process.env.DATABASE_SSL_MODE === 'disable' ? 'disable' : 'verify-full';
const runtime = createDatabaseRuntime({
  url: databaseUrl,
  sslMode,
  poolMaximum: 1,
});

try {
  const applied = await migrateDatabase(runtime.pool);
  console.log(`Applied ${applied.length} KFin migration(s).`);
} finally {
  await runtime.pool.end();
}
