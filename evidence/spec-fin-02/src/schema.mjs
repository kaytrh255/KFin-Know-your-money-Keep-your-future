import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionOptions } from './config.mjs';
import { SCHEMA_VERSION } from './constants.mjs';
import { quoteIdentifier, sha256 } from './util.mjs';

const { Client } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATION_PATH = path.resolve(
  here,
  '../migrations/001_account_financial_serialization_evidence.sql',
);

export async function migrationMetadata() {
  const sql = await fs.readFile(MIGRATION_PATH, 'utf8');
  return { version: SCHEMA_VERSION, sha256: sha256(sql), sql };
}

export async function resetEvidenceSchema(config, recorder = null) {
  assertSafeSchema(config.schema);
  const migration = await migrationMetadata();
  const client = new Client(pgConnectionOptions(config));
  await client.connect();
  try {
    recorder?.event('schema.reset_started', {
      schema: config.schema,
      migrationVersion: migration.version,
      migrationSha256: migration.sha256,
    });
    await client.query('BEGIN');
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(config.schema)} CASCADE`);
    await client.query(`CREATE SCHEMA ${quoteIdentifier(config.schema)}`);
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(config.schema)}, pg_catalog, public`);
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO evidence_schema_migrations(version, sha256) VALUES ($1, $2)',
      [migration.version, migration.sha256],
    );
    await client.query('COMMIT');
    recorder?.event('schema.reset_finished', {
      schema: config.schema,
      migrationVersion: migration.version,
      migrationSha256: migration.sha256,
    });
    return migration;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

export async function verifyEvidenceSchema(config) {
  const migration = await migrationMetadata();
  const client = new Client(pgConnectionOptions(config));
  await client.connect();
  try {
    await client.query(`SET search_path TO ${quoteIdentifier(config.schema)}, pg_catalog, public`);
    const result = await client.query(
      'SELECT version, sha256 FROM evidence_schema_migrations WHERE version = $1',
      [migration.version],
    );
    if (result.rowCount !== 1 || result.rows[0].sha256 !== migration.sha256) {
      throw new Error('Evidence schema migration is absent or has a different digest');
    }
    return migration;
  } finally {
    await client.end();
  }
}

export async function dropEvidenceSchema(config, recorder = null) {
  assertSafeSchema(config.schema);
  const client = new Client(pgConnectionOptions(config));
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(config.schema)} CASCADE`);
    recorder?.event('schema.dropped', { schema: config.schema });
  } finally {
    await client.end();
  }
}

export async function deleteSyntheticUser(client, userId) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL kfin.evidence_cleanup = 'on'");
    await client.query('DELETE FROM synthetic_users WHERE id = $1', [userId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function assertSafeSchema(schema) {
  if (!/^kfin_fin02_[a-z0-9_]{1,48}$/.test(schema)) {
    throw new Error('Refusing to alter a schema outside the kfin_fin02_* evidence namespace');
  }
}
