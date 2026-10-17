import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // The application role must never hold DDL privileges. This is a cheap
  // early guard; migration 0008 repeats the assertion at the schema level.
  const identity = await runtime.pool.query<{ current_user: string }>('SELECT current_user');
  if (identity.rows[0]?.current_user === 'kfin_app') {
    throw new Error('Refusing to run migrations as the application role kfin_app.');
  }
  // Two layouts run this file: the TypeScript source (`tsx`, migrations one
  // level up) and the bundled production artifact (`dist/migrate.bundle.mjs`,
  // migrations alongside it). `MIGRATIONS_DIR` overrides both for an operator
  // who ships reviewed SQL separately from the bundle.
  const beside = fileURLToPath(new URL('./migrations', import.meta.url));
  const above = fileURLToPath(new URL('../migrations', import.meta.url));
  const directory = process.env.MIGRATIONS_DIR
    ? path.resolve(process.env.MIGRATIONS_DIR)
    : existsSync(beside) ? beside : above;
  const applied = await migrateDatabase(runtime.pool, directory);
  console.log(`Applied ${applied.length} KFin migration(s).`);
} finally {
  await runtime.pool.end();
}
