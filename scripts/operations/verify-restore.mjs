#!/usr/bin/env node
/**
 * Backup verification: compares a restored database with its source.
 *
 * A restore is only proven by what is inside the target, so this compares the
 * things an operator cannot eyeball:
 *
 *   - every base table in `public`, with row count and a content checksum
 *     (`md5` of the rows in canonical order);
 *   - the applied migration list and its checksums;
 *   - row-level security flags and policy definitions;
 *   - table privileges for the three KFin roles;
 *   - sequence positions.
 *
 * Usage:
 *   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... \
 *     node scripts/operations/verify-restore.mjs
 *
 * Both URLs must connect as a role that can read every table and see every
 * grant (the provisioning/admin role). Exit code 0 means the target is a
 * faithful copy; 1 means at least one difference was found; 2 means the check
 * could not run.
 */

import { Client } from 'pg';

const KFIN_ROLES = ['kfin_app', 'kfin_migrator', 'kfin_operator'];

/** Reads the comparable shape and content of one database. */
export async function snapshotDatabase(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tables = await client.query(`
      SELECT c.relname AS name, c.relrowsecurity AS rls
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `);

    const tableSnapshot = [];
    for (const row of tables.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(row.name)) {
        throw new Error(`unexpected table name: ${row.name}`);
      }
      const content = await client.query(
        `SELECT count(*)::text AS rows,
                md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS checksum
         FROM public."${row.name}" t`,
      );
      tableSnapshot.push({
        name: row.name,
        rls: row.rls,
        rows: content.rows[0].rows,
        checksum: content.rows[0].checksum,
      });
    }

    const migrations = await client.query(
      'SELECT version, name, checksum FROM kfin_migrations ORDER BY version',
    );

    const policies = await client.query(`
      SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
      FROM pg_policies WHERE schemaname = 'public'
      ORDER BY tablename, policyname
    `);

    const grants = await client.query(`
      SELECT grantee, table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee = ANY($1::text[])
      ORDER BY grantee, table_name, privilege_type
    `, [KFIN_ROLES]);

    const sequences = await client.query(`
      SELECT sequencename, last_value::text AS last_value
      FROM pg_sequences WHERE schemaname = 'public'
      ORDER BY sequencename
    `);

    return {
      tables: tableSnapshot,
      migrations: migrations.rows,
      policies: policies.rows,
      grants: grants.rows,
      sequences: sequences.rows,
    };
  } finally {
    await client.end();
  }
}

/** Returns human-readable differences; an empty array means the restore matched. */
export function compareSnapshots(source, target) {
  const differences = [];
  const index = (rows, key) => new Map(rows.map((row) => [key(row), row]));

  const sourceTables = index(source.tables, (row) => row.name);
  const targetTables = index(target.tables, (row) => row.name);
  for (const [name, table] of sourceTables) {
    const other = targetTables.get(name);
    if (!other) {
      differences.push(`table ${name} is missing from the restored database`);
      continue;
    }
    if (table.rows !== other.rows) {
      differences.push(`table ${name} row count ${table.rows} -> ${other.rows}`);
    }
    if (table.checksum !== other.checksum) {
      differences.push(`table ${name} content checksum differs`);
    }
    if (table.rls !== other.rls) {
      differences.push(`table ${name} RLS flag ${table.rls} -> ${other.rls}`);
    }
  }
  for (const name of targetTables.keys()) {
    if (!sourceTables.has(name)) differences.push(`table ${name} exists only in the restored database`);
  }

  const sourceMigration = index(source.migrations, (row) => row.version);
  const targetMigration = index(target.migrations, (row) => row.version);
  if (sourceMigration.size !== targetMigration.size) {
    differences.push(`migration count ${sourceMigration.size} -> ${targetMigration.size}`);
  }
  for (const [version, migration] of sourceMigration) {
    const other = targetMigration.get(version);
    if (!other) differences.push(`migration ${version} is missing after restore`);
    else if (other.checksum !== migration.checksum) differences.push(`migration ${version} checksum differs`);
  }

  const sourcePolicies = new Set(source.policies.map((row) => JSON.stringify(row)));
  const targetPolicies = new Set(target.policies.map((row) => JSON.stringify(row)));
  for (const policy of sourcePolicies) {
    if (!targetPolicies.has(policy)) differences.push(`policy missing after restore: ${policy}`);
  }
  for (const policy of targetPolicies) {
    if (!sourcePolicies.has(policy)) differences.push(`policy added by restore: ${policy}`);
  }

  const sourceGrants = new Set(source.grants.map((row) => JSON.stringify(row)));
  const targetGrants = new Set(target.grants.map((row) => JSON.stringify(row)));
  for (const grant of sourceGrants) {
    if (!targetGrants.has(grant)) differences.push(`grant missing after restore: ${grant}`);
  }
  for (const grant of targetGrants) {
    if (!sourceGrants.has(grant)) differences.push(`grant added by restore: ${grant}`);
  }

  const sourceSequences = index(source.sequences, (row) => row.sequencename);
  const targetSequences = index(target.sequences, (row) => row.sequencename);
  for (const [name, sequence] of sourceSequences) {
    const other = targetSequences.get(name);
    if (!other) differences.push(`sequence ${name} is missing after restore`);
    else if (other.last_value !== sequence.last_value) {
      differences.push(`sequence ${name} last_value ${sequence.last_value} -> ${other.last_value}`);
    }
  }

  return differences;
}

async function main() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!sourceUrl || !targetUrl) {
    console.error('SOURCE_DATABASE_URL and TARGET_DATABASE_URL are required.');
    process.exit(2);
  }
  const source = await snapshotDatabase(sourceUrl);
  const target = await snapshotDatabase(targetUrl);
  const differences = compareSnapshots(source, target);
  const summary = {
    status: differences.length === 0 ? 'pass' : 'fail',
    sourceTables: source.tables.length,
    restoredTables: target.tables.length,
    rows: source.tables.reduce((total, table) => total + Number(table.rows), 0),
    migrations: source.migrations.length,
    policies: source.policies.length,
    grants: source.grants.length,
    differences,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (differences.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`verify-restore failed: ${error.message}`);
    process.exit(2);
  });
}
