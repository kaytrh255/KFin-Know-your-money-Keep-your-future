import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EvidenceRecorder } from '../src/evidence.mjs';

test('PASS requires execution and at least one successful assertion', () => {
  const recorder = new EvidenceRecorder({ sourceCommit: 'synthetic', harnessCommit: 'synthetic' });
  assert.throws(() => recorder.passCase('FIN-RACE-01'), /unexecuted/);
  recorder.startCase('FIN-RACE-01');
  assert.throws(() => recorder.passCase('FIN-RACE-01'), /without assertions/);
  recorder.assertion('FIN-RACE-01', 'actual PostgreSQL observation placeholder', true);
  recorder.passCase('FIN-RACE-01');
  assert.equal(recorder.results.get('FIN-RACE-01').status, 'PASS');
  assert.equal(recorder.summary().overall, 'NOT RUN');
});

test('blocked environment writes sanitized machine and human artifacts without claiming PASS', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kfin-fin02-evidence-'));
  const recorder = new EvidenceRecorder({
    sourceCommit: 'synthetic',
    harnessCommit: 'synthetic+dirty',
    endpoint: { configured: false, poolMode: 'unknown' },
  });
  for (let index = 1; index <= 8; index += 1) {
    recorder.blockCase(`FIN-RACE-${String(index).padStart(2, '0')}`, 'DATABASE_URL absent');
  }
  const artifact = await recorder.write(directory, 'blocked-run');
  const json = JSON.parse(await fs.readFile(path.join(artifact.directory, 'evidence.json'), 'utf8'));
  const markdown = await fs.readFile(path.join(artifact.directory, 'summary.md'), 'utf8');
  assert.equal(json.overall, 'BLOCKED');
  assert.equal(json.cases.every(({ status }) => status === 'BLOCKED'), true);
  assert.match(markdown, /Overall: \*\*BLOCKED\*\*/);
  assert.doesNotMatch(markdown, /Overall: \*\*PASS\*\*/);
  await fs.rm(directory, { recursive: true, force: true });
});
