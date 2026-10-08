import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, parseArguments } from '../src/config.mjs';
import { sanitize } from '../src/evidence.mjs';

const syntheticUrl = [
  'postgresql://',
  'synthetic_user',
  ':',
  'synthetic_password',
  '@',
  'db.example.invalid:5432/synthetic_db?sslmode=require',
].join('');

test('DATABASE_URL remains non-enumerable and endpoint metadata omits host/user/password', () => {
  const config = loadConfig({
    env: { DATABASE_URL: syntheticUrl, KFIN_EVIDENCE_POOL_MODE: 'direct' },
    argv: ['run', '--case', 'FIN-RACE-01', '--repetitions', '1'],
  });
  assert.equal(config.databaseUrl, syntheticUrl);
  assert.equal(Object.keys(config).includes('databaseUrl'), false);
  const serialized = JSON.stringify(config);
  assert.equal(serialized.includes('synthetic_password'), false);
  assert.equal(serialized.includes('db.example.invalid'), false);
  assert.deepEqual(config.selectedCases, ['FIN-RACE-01']);
  assert.equal(config.repetitions, 1);
});

test('artifact sanitizer removes URLs and secret-bearing keys', () => {
  const safe = sanitize({
    databaseUrl: syntheticUrl,
    password: 'do-not-retain',
    message: `connect failed for ${syntheticUrl}`,
    sqlstate: '55P03',
  });
  assert.equal(safe.databaseUrl, '[REDACTED]');
  assert.equal(safe.password, '[REDACTED]');
  assert.equal(safe.message, '[REDACTED_DATABASE_URL]');
  assert.equal(safe.sqlstate, '55P03');

  const endpointSafe = sanitize({
    hostname: 'db.example.invalid',
    username: 'synthetic_user',
    error: 'getaddrinfo ENOTFOUND db.example.invalid for user "synthetic_user"',
  }, '', {
    literals: ['db.example.invalid'],
    usernames: ['synthetic_user'],
  });
  assert.equal(endpointSafe.hostname, '[REDACTED]');
  assert.equal(endpointSafe.username, '[REDACTED]');
  assert.equal(endpointSafe.error.includes('db.example.invalid'), false);
  assert.equal(endpointSafe.error.includes('synthetic_user'), false);
});

test('argument parser accepts individual cases and rejects unknown switches', () => {
  const parsed = parseArguments(['run', '--case', 'FIN-RACE-06', '--keep-schema']);
  assert.deepEqual(parsed.cases, ['FIN-RACE-06']);
  assert.equal(parsed.keepSchema, true);
  assert.throws(() => parseArguments(['run', '--unknown']), /Unknown argument/);
});
