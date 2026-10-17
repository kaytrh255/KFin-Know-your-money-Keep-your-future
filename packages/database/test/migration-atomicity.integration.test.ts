/**
 * Migration failure behaviour, proven against a disposable database.
 *
 * The release runbook claims two things an operator relies on during a failed
 * deploy:
 *
 *   1. one migration file is atomic — a statement that fails leaves neither its
 *      tables nor a `kfin_migrations` row behind;
 *   2. an already-applied migration cannot be edited — the checksum guard stops
 *      the next run before anything executes.
 *
 * This test creates (and drops) its own database so it never disturbs the shared
 * integration database. It is skipped when the integration URLs are absent.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../src/migrations.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const migratorUrl = process.env.TEST_MIGRATION_DATABASE_URL;

function withDatabaseName(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseName = `kfin_migration_atomicity_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const directories: string[] = [];
let admin: Pool | null = null;
let migrator: Pool | null = null;

async function migrationDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kfin-migrations-'));
  directories.push(directory);
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(directory, name), sql, 'utf8');
  }
  return directory;
}

describe.skipIf(!adminUrl || !migratorUrl)('migration failure atomicity', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.query(`GRANT CONNECT, CREATE ON DATABASE "${databaseName}" TO kfin_migrator`);
    await admin.end();
    admin = new Pool({ connectionString: withDatabaseName(adminUrl as string, databaseName), max: 1 });
    await admin.query('GRANT CREATE, USAGE ON SCHEMA public TO kfin_migrator');
    migrator = new Pool({ connectionString: withDatabaseName(migratorUrl as string, databaseName), max: 1 });
  });

  afterAll(async () => {
    await migrator?.end();
    await admin?.end();
    const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('rolls one failing migration file back completely', async () => {
    const directory = await migrationDirectory({
      '0001_partial.sql': [
        'CREATE TABLE atomicity_probe (id INTEGER PRIMARY KEY);',
        'INSERT INTO atomicity_probe (id) VALUES (1);',
        'SELECT function_that_does_not_exist();',
      ].join('\n'),
    });

    await expect(migrateDatabase(migrator as Pool, directory)).rejects.toThrow();

    const table = await (migrator as Pool).query("SELECT to_regclass('public.atomicity_probe') AS name");
    expect(table.rows[0].name).toBeNull();
    const applied = await (migrator as Pool).query('SELECT count(*)::int AS count FROM kfin_migrations');
    expect(applied.rows[0].count).toBe(0);
  });

  it('keeps an earlier file applied when a later file fails, and records only the earlier one', async () => {
    const directory = await migrationDirectory({
      '0002_good.sql': 'CREATE TABLE atomicity_kept (id INTEGER PRIMARY KEY);',
      '0003_bad.sql': 'CREATE TABLE atomicity_lost (id INTEGER PRIMARY KEY);\nSELECT 1/0;',
    });

    await expect(migrateDatabase(migrator as Pool, directory)).rejects.toThrow();

    const kept = await (migrator as Pool).query("SELECT to_regclass('public.atomicity_kept') AS name");
    const lost = await (migrator as Pool).query("SELECT to_regclass('public.atomicity_lost') AS name");
    expect(kept.rows[0].name).not.toBeNull();
    expect(lost.rows[0].name).toBeNull();

    const applied = await (migrator as Pool).query('SELECT version FROM kfin_migrations ORDER BY version');
    expect(applied.rows.map((row) => row.version)).toEqual(['0002']);
  });

  it('refuses to run when an applied migration file was edited', async () => {
    const directory = await migrationDirectory({
      '0004_stable.sql': 'CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY);',
    });
    await expect(migrateDatabase(migrator as Pool, directory)).resolves.toHaveLength(1);

    const edited = await migrationDirectory({
      '0004_stable.sql': 'CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY);\n-- edited after it was applied',
    });
    await expect(migrateDatabase(migrator as Pool, edited)).rejects.toThrow(/checksum/);
  });

  it('is idempotent for an unchanged migration set', async () => {
    const directory = await migrationDirectory({
      '0005_once.sql': 'CREATE TABLE idempotency_probe (id INTEGER PRIMARY KEY);',
    });
    expect(await migrateDatabase(migrator as Pool, directory)).toHaveLength(1);
    expect(await migrateDatabase(migrator as Pool, directory)).toHaveLength(0);
  });
});
