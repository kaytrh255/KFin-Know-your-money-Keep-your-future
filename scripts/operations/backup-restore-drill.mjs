#!/usr/bin/env node
/**
 * Disposable backup/restore drill.
 *
 * Creates two databases from scratch on a **non-production** cluster, migrates
 * the first one with the production migration bundle, seeds representative rows,
 * takes a logical backup, restores it into the second, and verifies the copy.
 * Both databases are dropped afterwards. Nothing here can reach production: it
 * only ever connects to the URLs given in the environment.
 *
 * Required:
 *   ADMIN_DATABASE_URL        superuser (or CREATEDB + role-admin) connection
 *   MIGRATION_DATABASE_URL    kfin_migrator connection (any database name;
 *                             this script rewrites the database name)
 *   APP_DATABASE_URL          kfin_app connection (same; rewritten)
 *
 * Optional:
 *   PG_DUMP / PG_RESTORE      explicit client binaries
 *   KFIN_APP_PASSWORD, KFIN_MIGRATOR_PASSWORD, KFIN_OPERATOR_PASSWORD
 *                             passed to provisioning (existing passwords are
 *                             kept when omitted)
 *   DRILL_KEEP=1              keep both databases for inspection
 *
 * Run: corepack pnpm run build && corepack pnpm run backup:drill
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { compareSnapshots, snapshotDatabase } from './verify-restore.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifact = path.join(repoRoot, 'apps', 'api', 'dist');

const REQUIRED = ['ADMIN_DATABASE_URL', 'MIGRATION_DATABASE_URL', 'APP_DATABASE_URL'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`backup drill needs: ${missing.join(', ')}`);
  process.exit(2);
}

const adminUrl = process.env.ADMIN_DATABASE_URL;
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;
const sslMode = process.env.DATABASE_SSL_MODE ?? 'disable';
const suffix = `${process.pid}_${Date.now().toString(36)}`;
const sourceDb = `kfin_drill_src_${suffix}`.toLowerCase().slice(0, 60);
const restoreDb = `kfin_drill_restore_${suffix}`.toLowerCase().slice(0, 60);

const summary = {
  status: 'fail',
  sourceDatabase: sourceDb,
  restoreDatabase: restoreDb,
  steps: [],
};

function record(step, ok, detail) {
  summary.steps.push({ step, status: ok ? 'pass' : 'fail', ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${step}: ${detail}`);
}

function databaseUrl(base, name) {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function run(command, args, env, label) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-1200);
    throw new Error(`${label} failed (exit ${result.status}): ${output}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

function requireArtifact() {
  const required = ['migrate.bundle.mjs', 'migrations'];
  for (const name of required) {
    try {
      execFileSync('test', ['-e', path.join(artifact, name)]);
    } catch {
      throw new Error(`the production artifact is missing ${name}; run \`corepack pnpm run build\` first`);
    }
  }
}

async function withClient(url, action) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

async function main() {
  requireArtifact();

  // 1. Two empty databases. The admin keeps ownership: making kfin_migrator the
  // database owner would put it in `pg_database_owner`, and provisioning
  // correctly refuses a role that can reach another role through a chain.
  await withClient(adminUrl, async (client) => {
    for (const name of [sourceDb, restoreDb]) {
      await client.query(`CREATE DATABASE "${name}"`);
      await client.query(`GRANT CONNECT, CREATE ON DATABASE "${name}" TO kfin_migrator`);
    }
  });
  record('databases.created', true, `${sourceDb}, ${restoreDb}`);

  const passwords = {
    ...(process.env.KFIN_APP_PASSWORD ? { KFIN_APP_PASSWORD: process.env.KFIN_APP_PASSWORD } : {}),
    ...(process.env.KFIN_MIGRATOR_PASSWORD ? { KFIN_MIGRATOR_PASSWORD: process.env.KFIN_MIGRATOR_PASSWORD } : {}),
    ...(process.env.KFIN_OPERATOR_PASSWORD ? { KFIN_OPERATOR_PASSWORD: process.env.KFIN_OPERATOR_PASSWORD } : {}),
  };

  // 2. Roles/grants on both databases (idempotent cluster-wide roles).
  for (const name of [sourceDb, restoreDb]) {
    run(process.execPath, [path.join(repoRoot, 'packages/database/scripts/provision-roles.mjs')], {
      ROLE_ADMIN_DATABASE_URL: databaseUrl(adminUrl, name),
      ...passwords,
    }, `provision roles on ${name}`);
  }
  record('roles.provisioned', true);

  // 3. Migrate the source with the artifact, not with `tsx`.
  const migrateOutput = run(process.execPath, [path.join(artifact, 'migrate.bundle.mjs')], {
    MIGRATION_DATABASE_URL: databaseUrl(migrationUrl, sourceDb),
    DATABASE_SSL_MODE: sslMode,
  }, 'artifact migration');
  record('source.migrated', true, migrateOutput.split('\n').at(-1));

  // 4. Seed rows a restore must preserve exactly.
  await withClient(databaseUrl(adminUrl, sourceDb), async (client) => {
    await client.query(`
      INSERT INTO users (
        id, email, email_normalized, email_verified_at, email_verification_state,
        locale, timezone, base_currency, status
      )
      VALUES
        ('11111111-1111-4111-8111-111111111111', 'beta.one@example.invalid',
         'beta.one@example.invalid', '2026-10-01T00:00:00Z', 'verified',
         'vi', 'Asia/Ho_Chi_Minh', 'VND', 'active'),
        ('11111111-1111-4111-8111-111111111112', 'beta.two@example.invalid',
         'beta.two@example.invalid', NULL, 'unverified',
         'vi', 'Asia/Ho_Chi_Minh', 'VND', 'active')
    `);
    await client.query(`
      INSERT INTO financial_accounts (id, user_id, name, currency, financial_state_version)
      VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
              'Ví beta', 'VND', 3)
    `);
  });
  record('source.seeded', true, '2 users, 1 financial account, 14 built-in categories');

  // 5. Backup with the operator script.
  const directory = await mkdtemp(path.join(tmpdir(), 'kfin-drill-'));
  const backupFile = path.join(directory, 'kfin.drill.dump');
  const backupStarted = Date.now();
  run('bash', [path.join(repoRoot, 'scripts/operations/backup-database.sh')], {
    SOURCE_DATABASE_URL: databaseUrl(adminUrl, sourceDb),
    BACKUP_FILE: backupFile,
  }, 'backup');
  const backupMs = Date.now() - backupStarted;
  record('backup.created', true, `${backupMs}ms`);

  // 6. Restore into the empty target with the operator script.
  const restoreStarted = Date.now();
  run('bash', [path.join(repoRoot, 'scripts/operations/restore-database.sh')], {
    TARGET_DATABASE_URL: databaseUrl(adminUrl, restoreDb),
    BACKUP_FILE: backupFile,
  }, 'restore');
  const restoreMs = Date.now() - restoreStarted;
  record('restore.completed', true, `${restoreMs}ms`);

  // 7. Content, schema, RLS, grants and sequences must match.
  const source = await snapshotDatabase(databaseUrl(adminUrl, sourceDb));
  const restored = await snapshotDatabase(databaseUrl(adminUrl, restoreDb));
  const differences = compareSnapshots(source, restored);
  record('restore.verified', differences.length === 0, JSON.stringify(differences.slice(0, 5)));

  // 8. The application role must still be least-privileged after the restore.
  const verifyOutput = run(process.execPath, [path.join(repoRoot, 'packages/database/scripts/verify-app-role.mjs')], {
    DATABASE_URL: databaseUrl(appUrl, restoreDb),
  }, 'least-privilege verification');
  record('restore.least-privilege', true, verifyOutput.split('\n').at(-1));

  // 9. The application must be able to read restored data through its own role.
  // `categories` is the global reference table, readable without a user context;
  // `users` is owner-scoped by RLS and would answer zero without `kfin.user_id`.
  const selected = await withClient(databaseUrl(appUrl, restoreDb), async (client) => {
    const result = await client.query('SELECT count(*)::int AS categories FROM categories');
    return result.rows[0].categories;
  });
  record('restore.app-read', selected === 14, `kfin_app saw ${selected} category row(s)`);

  summary.backupMs = backupMs;
  summary.restoreMs = restoreMs;
  summary.tables = source.tables.length;
  summary.rows = source.tables.reduce((total, table) => total + Number(table.rows), 0);
  summary.status = 'pass';
  summary.backupFile = backupFile;
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

function escapeWorkflowCommand(value) {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function emit() {
  const text = JSON.stringify(summary, null, 2);
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Annotations are readable through the checks API even when the job log is
    // not; this keeps a failed drill diagnosable without printing a secret.
    const payload = summary.status === 'pass'
      ? { status: summary.status, tables: summary.tables, rows: summary.rows, backupMs: summary.backupMs, restoreMs: summary.restoreMs }
      : {
        status: summary.status,
        error: (summary.error ?? 'unknown').slice(0, 400),
        steps: summary.steps.map((step) => `${step.step}:${step.status}`).join(','),
      };
    const command = summary.status === 'pass' ? '::notice' : '::error';
    process.stdout.write(`${command} title=backup-restore-drill::${escapeWorkflowCommand(JSON.stringify(payload))}\n`);
  }
}

try {
  await main();
  emit();
} catch (error) {
  summary.error = error.message;
  emit();
  process.exitCode = 1;
} finally {
  if (process.env.DRILL_KEEP !== '1' && process.env.ADMIN_DATABASE_URL) {
    await withClient(adminUrl, async (client) => {
      for (const name of [sourceDb, restoreDb]) {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    }).catch((error) => {
      process.stderr.write(`cleanup warning: ${error.message}\n`);
    });
  }
}
