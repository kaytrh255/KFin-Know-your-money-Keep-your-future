#!/usr/bin/env node
/**
 * Builds the deployable production artifact.
 *
 * Output (all under `apps/api/dist`):
 *
 *   server.bundle.mjs   the API server with every `@kfin/*` workspace package
 *                       inlined, so a production install only needs the
 *                       published dependencies of `apps/api` — no `tsx`, no
 *                       TypeScript sources, no workspace resolution rules.
 *   migrate.bundle.mjs  `db:migrate` for the same reason: an operator must be
 *                       able to apply the reviewed SQL without devDependencies.
 *   provision-invitation.bundle.mjs
 *                       the operator invitation CLI, likewise.
 *   migrations/         the reviewed SQL the bundle above applies.
 *   web/                the static client: `index.html`, `src/styles.css` and
 *                       the compiled `src/*.js` modules it references.
 *   BUILD-INFO.json     commit, build time and Node version, so an operator can
 *                       tell which artifact is running.
 *   runtime-package.json
 *                       the install manifest for a production-only deployment:
 *                       exactly the external packages the bundle imports, at
 *                       the versions this repository resolved. `npm install
 *                       --omit=dev` against it is the whole runtime install.
 *
 * `tsc -b` has already run (the root `build` script runs it first) so the
 * client modules exist and the API has been typechecked. This script only
 * assembles: it does not typecheck.
 *
 * The bundle deliberately externalizes Fastify, `pg`, `zod` and the other
 * runtime dependencies: they stay ordinary `apps/api` dependencies, and
 * bundling them would fight their optional native/conditional requires.
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = path.join(repoRoot, 'apps', 'api');
const webRoot = path.join(repoRoot, 'apps', 'web');
const databaseRoot = path.join(repoRoot, 'packages', 'database');
const outRoot = path.join(apiRoot, 'dist');
const webOut = path.join(outRoot, 'web');

/** Packages that stay external because they are real runtime dependencies. */
const EXTERNAL = [
  '@fastify/swagger',
  '@node-rs/argon2',
  'fastify',
  'fastify-type-provider-zod',
  'pg',
  'zod',
];

async function main() {
  await assertSourcePresent(path.join(webRoot, 'dist', 'main.js'),
    'apps/web/dist is missing. Run `corepack pnpm run build` (which typechecks first), not this script alone.');
  await assertSourcePresent(path.join(webRoot, 'index.html'), 'apps/web/index.html is missing.');

  await rm(webOut, { recursive: true, force: true });
  await mkdir(path.join(webOut, 'src'), { recursive: true });

  await bundle(path.join(apiRoot, 'src', 'server.ts'), path.join(outRoot, 'server.bundle.mjs'));
  await bundle(path.join(databaseRoot, 'src', 'migrate-cli.ts'), path.join(outRoot, 'migrate.bundle.mjs'));
  await bundle(
    path.join(apiRoot, 'tools', 'provision-invitation.ts'),
    path.join(outRoot, 'provision-invitation.bundle.mjs'),
  );

  await rm(path.join(outRoot, 'migrations'), { recursive: true, force: true });
  await cp(path.join(databaseRoot, 'migrations'), path.join(outRoot, 'migrations'), { recursive: true });

  await cp(path.join(webRoot, 'index.html'), path.join(webOut, 'index.html'));
  await cp(path.join(webRoot, 'src', 'styles.css'), path.join(webOut, 'src', 'styles.css'));
  for (const name of await readdir(path.join(webRoot, 'dist'))) {
    if (!/\.(js|js\.map)$/.test(name)) continue;
    await cp(path.join(webRoot, 'dist', name), path.join(webOut, 'src', name));
  }

  const apiManifest = JSON.parse(await readFile(path.join(apiRoot, 'package.json'), 'utf8'));
  const runtimeDependencies = {};
  for (const name of EXTERNAL) {
    const version = apiManifest.dependencies?.[name];
    if (typeof version !== 'string' || version.startsWith('workspace:')) {
      throw new Error(`Runtime dependency ${name} is missing from apps/api/package.json; the artifact cannot be installed.`);
    }
    runtimeDependencies[name] = version;
  }
  await writeFile(path.join(outRoot, 'runtime-package.json'), `${JSON.stringify({
    name: 'kfin-runtime',
    version: apiManifest.version,
    private: true,
    type: 'module',
    dependencies: runtimeDependencies,
  }, null, 2)}\n`);

  // A container build has no `.git`; the Dockerfile passes the commit in.
  let commit = process.env.BUILD_COMMIT?.trim() || 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    if (commit === 'unknown') process.stderr.write('warning: no git metadata and no BUILD_COMMIT; the artifact cannot be traced to a commit.\n');
  }
  await writeFile(path.join(outRoot, 'BUILD-INFO.json'), `${JSON.stringify({
    commit,
    builtAt: new Date().toISOString(),
    node: process.version,
    entrypoint: 'dist/server.bundle.mjs',
    webRoot: 'dist/web',
  }, null, 2)}\n`);

  await assertArtifact(path.join(outRoot, 'server.bundle.mjs'));
  await assertRuntimeManifest(path.join(outRoot, 'runtime-package.json'));
  await assertArtifact(path.join(outRoot, 'migrate.bundle.mjs'));
  await assertArtifact(path.join(outRoot, 'provision-invitation.bundle.mjs'));
  const migrations = await readdir(path.join(outRoot, 'migrations'));
  if (!migrations.some((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))) {
    throw new Error('The production artifact has no migrations.');
  }
  await assertSourcePresent(path.join(webOut, 'src', 'main.js'), 'The client bundle is incomplete.');
  await assertSourcePresent(path.join(webOut, 'src', 'styles.css'), 'The client stylesheet is missing.');

  process.stdout.write(`production artifact ready: apps/api/dist (commit ${commit.slice(0, 9)})\n`);
}

async function bundle(entryPoint, outfile) {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: EXTERNAL,
    sourcemap: true,
    logLevel: 'warning',
    absWorkingDir: repoRoot,
    banner: {
      js: "import { createRequire as __kfinCreateRequire } from 'node:module'; const require = __kfinCreateRequire(import.meta.url);",
    },
  });
}

async function assertRuntimeManifest(file) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  for (const name of EXTERNAL) {
    if (typeof manifest.dependencies?.[name] !== 'string') {
      throw new Error(`runtime-package.json does not pin ${name}.`);
    }
    if (String(manifest.dependencies[name]).startsWith('workspace:')) {
      throw new Error(`runtime-package.json still resolves ${name} from the workspace.`);
    }
  }
}

async function assertSourcePresent(file, message) {
  try {
    await stat(file);
  } catch {
    throw new Error(message);
  }
}

async function assertArtifact(file) {
  const contents = await readFile(file, 'utf8');
  if (contents.length === 0) throw new Error('The server bundle is empty.');
  // A production artifact must never need the development TypeScript runner.
  if (/(?:from|require\()\s*['"]tsx['"]/.test(contents)) {
    throw new Error('The server bundle references `tsx`; the production artifact may not need a dev runner.');
  }
  if (/\bfrom\s*['"][^'"]+\.ts['"]/.test(contents)) {
    throw new Error('The server bundle imports a TypeScript source module at runtime.');
  }
}

await main();
