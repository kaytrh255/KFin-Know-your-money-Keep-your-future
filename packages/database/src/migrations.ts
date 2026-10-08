import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const MIGRATION_NAME = /^[0-9]{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK = '494261497005346612';

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
}

export async function migrateDatabase(
  pool: Pool,
  migrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url)),
): Promise<readonly AppliedMigration[]> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS kfin_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);

    const filenames = (await readdir(migrationsDirectory))
      .filter((filename) => MIGRATION_NAME.test(filename))
      .sort();
    const applied: AppliedMigration[] = [];

    for (const filename of filenames) {
      const sql = await readFile(path.join(migrationsDirectory, filename), 'utf8');
      const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
      const version = filename.slice(0, 4);
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM kfin_migrations WHERE version = $1',
        [version],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Migration ${version} checksum does not match the applied migration.`);
        }
        continue;
      }
      await applyMigration(client, { version, filename, checksum, sql });
      applied.push({ version, name: filename, checksum });
    }
    return applied;
  } catch (error) {
    destroy = true;
    throw error;
  } finally {
    if (!destroy) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK]);
      } catch {
        destroy = true;
      }
    }
    client.release(destroy);
  }
}

async function applyMigration(
  client: PoolClient,
  migration: { version: string; filename: string; checksum: string; sql: string },
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5000ms'");
    await client.query("SET LOCAL statement_timeout = '30000ms'");
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO kfin_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
      [migration.version, migration.filename, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Migration ${migration.version} failed and rollback was not confirmed.`);
    }
    throw error;
  }
}
