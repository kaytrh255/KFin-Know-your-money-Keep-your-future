// Post-run guard for the PostgreSQL integration step.
//
// `describe.skipIf(!integrationEnabled)` is the right default for a developer laptop — the suite is
// skipped instead of failing when no database is configured. In CI that default is dangerous: if the
// environment variables were ever dropped, every integration case would skip and the job would still
// report success. A skipped test is not a passing test.
//
// This guard reads the machine-readable report from the run and fails the job unless the suite really
// executed: no failures, no skips, no todos, and at least the expected number of cases.
//
// Usage: node .github/scripts/assert-integration-ran.mjs <vitest-json-report> [minimum-expected-tests]

import fs from 'node:fs';

// The suite runs 69 cases across 7 files as of 2026-10-12. The floor is deliberately a little below
// that: it is an anti-silent-shrink guard, not a count that must be bumped by hand for every new test.
const DEFAULT_MINIMUM_TESTS = 60;
const MINIMUM_SUITES = 7;

const reportPath = process.argv[2];
const minimumTests = Number(process.argv[3] ?? DEFAULT_MINIMUM_TESTS);

function fail(lines) {
  console.error('Integration execution guard FAILED:');
  for (const line of lines) console.error(`  - ${line}`);
  process.exit(1);
}

if (!reportPath) fail(['no report path was given']);
if (!fs.existsSync(reportPath)) fail([`no machine-readable report at ${reportPath} — the suite did not run`]);

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (error) {
  fail([`the report at ${reportPath} is not readable JSON: ${error.message}`]);
}

const total = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
const failed = report.numFailedTests ?? 0;
const skipped = report.numPendingTests ?? 0;
const todo = report.numTodoTests ?? 0;
const suites = report.numTotalTestSuites ?? 0;
// A file can fail before any case runs (for example when `beforeAll` cannot reach the database). Vitest
// then reports zero failed *tests* and a pile of skips, which is precisely the shape a naive check
// would wave through, so the file-level status is inspected directly as well.
const failedFiles = report.numFailedTestSuites ?? 0;
const files = Array.isArray(report.testResults) ? report.testResults : [];
const failedFileNames = files
  .filter((file) => file?.status === 'failed')
  .map((file) => (file.name ?? 'unknown file').split('/').slice(-2).join('/'));
const filesReported = files.length;

const failures = [];
if (failed > 0) failures.push(`${failed} test(s) FAILED`);
if (failedFiles > 0) {
  failures.push(`${failedFiles} report suite(s) FAILED — files: ${failedFileNames.join(', ') || 'unnamed'}`);
}
if (skipped > 0) failures.push(`${skipped} test(s) were SKIPPED — a skipped integration test is not a pass`);
if (todo > 0) failures.push(`${todo} test(s) are marked TODO`);
if (total === 0) failures.push('no tests were collected at all');
if (total > 0 && passed !== total) failures.push(`${passed} of ${total} collected tests passed`);
if (suites < MINIMUM_SUITES) failures.push(`only ${suites} of the ${MINIMUM_SUITES} integration files reported`);
if (filesReported < MINIMUM_SUITES) failures.push(`only ${filesReported} of the ${MINIMUM_SUITES} integration files are present in the report`);
if (total < minimumTests) failures.push(`only ${total} tests ran, below the ${minimumTests}-test floor`);

const summary = [
  `### PostgreSQL integration: ${passed}/${total} passed, ${skipped} skipped, ${failed} failed`,
  '',
  `- files reported: ${filesReported} (failed: ${failedFiles})`,
  `- tests: ${total} (floor ${minimumTests})`,
  '',
  failures.length === 0
    ? 'Executed against the isolated disposable database seeded by the workflow service container.'
    : `**Guard failed**: ${failures.join('; ')}`,
].join('\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (failures.length > 0) fail(failures);

console.log(`Integration execution guard passed: ${passed}/${total} tests passed across ${filesReported} files, 0 skipped, 0 failed.`);
