#!/usr/bin/env node
/**
 * Verifies the deployable artifact the way a production host installs it.
 *
 * A production install must not need `tsx`, TypeScript sources, or any
 * devDependency. This script proves that instead of asserting it:
 *
 *   1. copies the built artifact (`apps/api/dist`) into a clean directory;
 *   2. turns `runtime-package.json` into the only `package.json`;
 *   3. runs `npm install --omit=dev` there — a real registry install;
 *   4. asserts `tsx` cannot be resolved and is not in `node_modules`;
 *   5. starts `server.bundle.mjs` from that directory with NODE_ENV=production
 *      and runs the same 12 deployment checks as `smoke:production`.
 *
 * Nothing from the repository's own `node_modules` is on the resolution path:
 * the artifact runs only with what the production install fetched.
 *
 * Required environment: DATABASE_URL, AUTH_SECRET,
 * FINANCIAL_PREVIEW_SIGNING_KEY, IDEMPOTENCY_RETENTION_HOURS.
 *
 * Run: corepack pnpm run build && corepack pnpm run verify:production-install
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(repoRoot, 'apps', 'api', 'dist');

const REQUIRED = ['DATABASE_URL', 'AUTH_SECRET', 'FINANCIAL_PREVIEW_SIGNING_KEY', 'IDEMPOTENCY_RETENTION_HOURS'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`production install verification needs: ${missing.join(', ')}`);
  process.exit(2);
}

const summary = { status: 'fail', artifact: 'apps/api/dist', steps: [] };

function record(step, ok, detail) {
  summary.steps.push({ step, status: ok ? 'pass' : 'fail', ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${step}: ${detail}`);
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-1500);
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status}): ${output}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

let directory = null;

async function main() {
  // 1. The artifact must exist and be complete.
  const manifest = JSON.parse(await readFile(path.join(dist, 'runtime-package.json'), 'utf8'));
  const artifactFiles = await readdir(dist);
  for (const requiredFile of ['server.bundle.mjs', 'web', 'migrations', 'runtime-package.json']) {
    if (!artifactFiles.includes(requiredFile)) {
      throw new Error(`the artifact is incomplete: ${requiredFile} is missing. Run \`corepack pnpm run build\` first.`);
    }
  }
  record('artifact.present', true, `${artifactFiles.length} entries`);

  // 2. A clean directory holding only the artifact.
  directory = await mkdtemp(path.join(tmpdir(), 'kfin-production-install-'));
  for (const entry of artifactFiles) {
    await cp(path.join(dist, entry), path.join(directory, entry), { recursive: true });
  }
  await rename(path.join(directory, 'runtime-package.json'), path.join(directory, 'package.json'));
  const installManifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  record('install.manifest', Object.keys(installManifest.dependencies ?? {}).length > 0,
    `${Object.keys(installManifest.dependencies).length} runtime dependencies, no devDependencies`);
  record('install.no-dev-dependencies', installManifest.devDependencies === undefined, 'package.json has no devDependencies');

  // 3. A real production-only install.
  const started = Date.now();
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: directory,
    env: { npm_config_update_notifier: 'false' },
  });
  const installMs = Date.now() - started;
  const installed = await readdir(path.join(directory, 'node_modules'));
  record('install.completed', installed.length > 0, `${installMs}ms, ${installed.length} top-level entries`);

  // 4. The development runner must be absent, not merely unused.
  const tsxPresent = installed.includes('tsx') || await readdir(path.join(directory, 'node_modules', '.bin'))
    .then((entries) => entries.includes('tsx'))
    .catch(() => false);
  record('install.no-tsx', !tsxPresent, `tsx present: ${tsxPresent}`);
  let resolved = 'not-found';
  try {
    resolved = run(process.execPath, ['-e', "console.log(require.resolve('tsx'))"], {
      cwd: directory,
      env: {},
      timeoutMs: 30_000,
    });
  } catch {
    resolved = 'not-found';
  }
  record('install.tsx-unresolvable', resolved === 'not-found', resolved);

  // 5. Start from that directory and run the deployment checks against it.
  const smokeOutput = run(process.execPath, [path.join(repoRoot, 'scripts', 'smoke', 'production-smoke.mjs')], {
    cwd: directory,
    env: {
      SMOKE_ENTRYPOINT: path.join(directory, 'server.bundle.mjs'),
      SMOKE_CWD: directory,
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE ?? 'disable',
      AUTH_SECRET: process.env.AUTH_SECRET,
      FINANCIAL_PREVIEW_SIGNING_KEY: process.env.FINANCIAL_PREVIEW_SIGNING_KEY,
      IDEMPOTENCY_RETENTION_HOURS: process.env.IDEMPOTENCY_RETENTION_HOURS,
    },
    timeoutMs: 180_000,
  });
  const smoke = JSON.parse(smokeOutput.slice(smokeOutput.indexOf('{')));
  record('smoke.production', smoke.status === 'pass',
    `${smoke.checks.filter((check) => check.status === 'pass').length}/${smoke.checks.length} checks`);

  summary.status = 'pass';
  summary.installMs = installMs;
  summary.dependencies = Object.keys(installManifest.dependencies).length;
  summary.smokeChecks = smoke.checks.map((check) => `${check.name}:${check.status}`);
}

try {
  await main();
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
} finally {
  if (directory !== null && process.env.KEEP_PRODUCTION_INSTALL !== '1') {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
