// Pre-flight safety guard for the PostgreSQL integration step.
//
// The integration suite is destructive by design: it creates schemas, applies every migration, and
// writes synthetic rows. It runs only against a throwaway database. This guard refuses to let the job
// proceed unless the target is provably one of those, so a misconfigured environment fails loudly
// instead of quietly running the suite against something that matters.
//
// It never prints the connection string — only the host, port, database name and user, which is what a
// reader needs to confirm the target, and which cannot leak a password.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const EXPECTED_DATABASE = 'kfin_test';
const EXPECTED_USER = 'postgres';
const EXPECTED_PORT = '5432';
const EXPECTED_TARGET_FLAG = 'non-production';

const problems = [];
const url = process.env.TEST_DATABASE_URL;
const targetFlag = process.env.KFIN_INTEGRATION_TARGET;

if (!url) problems.push('TEST_DATABASE_URL is not set; the suite would silently skip.');
if (targetFlag !== EXPECTED_TARGET_FLAG) {
  problems.push(`KFIN_INTEGRATION_TARGET must be "${EXPECTED_TARGET_FLAG}" (got ${targetFlag ?? 'undefined'}).`);
}

let parsed = null;
if (url) {
  try {
    parsed = new URL(url);
  } catch {
    problems.push('TEST_DATABASE_URL is not a parseable URL.');
  }
}

const host = parsed?.hostname;
const database = parsed?.pathname.replace(/^\//, '');
const user = parsed ? decodeURIComponent(parsed.username) : undefined;

if (parsed) {
  if (!LOOPBACK_HOSTS.has(host)) {
    problems.push(`TEST_DATABASE_URL must point at a loopback host (got "${host}").`);
  }
  if (parsed.port !== EXPECTED_PORT) {
    problems.push(`TEST_DATABASE_URL must use port ${EXPECTED_PORT} (got "${parsed.port || '(default)'}").`);
  }
  if (database !== EXPECTED_DATABASE) {
    problems.push(`TEST_DATABASE_URL must name the disposable database "${EXPECTED_DATABASE}" (got "${database}").`);
  }
  if (user !== EXPECTED_USER) {
    problems.push(`TEST_DATABASE_URL must use the local superuser "${EXPECTED_USER}" (got "${user}").`);
  }
}

if (problems.length > 0) {
  console.error('Integration target guard FAILED:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('Refusing to run the destructive integration suite. No database was contacted.');
  process.exit(1);
}

console.log('Integration target guard passed:');
console.log(`  host=${host} port=${parsed.port} database=${database} user=${user}`);
console.log(`  KFIN_INTEGRATION_TARGET=${targetFlag}`);
console.log('  (derived from TEST_DATABASE_URL; no credential is printed)');
