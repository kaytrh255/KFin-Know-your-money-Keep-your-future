import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema.js';

export interface DatabaseConnectionConfig {
  readonly url: string;
  readonly sslMode: 'disable' | 'verify-full';
  readonly poolMaximum: number;
}

export interface DatabaseRuntime {
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;
}

export function createDatabaseRuntime(config: DatabaseConnectionConfig): DatabaseRuntime {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMaximum,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
    allowExitOnIdle: false,
    ssl: config.sslMode === 'disable' ? false : { rejectUnauthorized: true },
    application_name: 'kfin-api',
  });
  const db = drizzle({ client: pool, schema });
  return Object.freeze({ pool, db });
}
