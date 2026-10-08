import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { runEvidence } from '../src/runner.mjs';

test('runner without DATABASE_URL emits BLOCKED artifacts and executes no PostgreSQL case', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'kfin-fin02-blocked-'));
  try {
    const config = loadConfig({
      env: { KFIN_EVIDENCE_OUTPUT: output },
      argv: ['run', '--run-token', 'unit-blocked'],
    });
    const result = await runEvidence(config);
    assert.equal(result.exitCode, 2);
    assert.equal(result.summary.overall, 'BLOCKED');
    assert.equal(result.summary.cases.every(({ status, executed }) => status === 'BLOCKED' && !executed), true);
    assert.equal(result.summary.events.some(({ type }) => type === 'transaction.attempt_started'), false);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('runner refuses a configured URL until non-production target is explicitly confirmed', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'kfin-fin02-target-guard-'));
  const databaseUrl = ['postgresql://', 'user', ':', 'password', '@', 'never-connect.invalid/db'].join('');
  try {
    const config = loadConfig({
      env: { DATABASE_URL: databaseUrl, KFIN_EVIDENCE_OUTPUT: output },
      argv: ['run', '--run-token', 'unit-target-guard', '--case', 'FIN-RACE-01'],
    });
    const result = await runEvidence(config);
    assert.equal(result.exitCode, 2);
    assert.equal(result.summary.cases[0].status, 'BLOCKED');
    assert.match(result.summary.cases[0].notes[0], /KFIN_EVIDENCE_TARGET=non-production/);
    assert.equal(result.summary.events.some(({ type }) => type === 'environment.verified'), false);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});
