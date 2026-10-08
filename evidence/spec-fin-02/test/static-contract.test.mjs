import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { FROZEN_SOURCE_COMMIT, POLICY, RETRYABLE_SQLSTATES } from '../src/constants.mjs';
import { verifyFrozenAuthoritativeDocs } from '../src/runner.mjs';

test('authoritative documents remain byte-identical to frozen candidate', () => {
  assert.doesNotThrow(() => verifyFrozenAuthoritativeDocs());
  assert.equal(FROZEN_SOURCE_COMMIT, 'e298e6b4e142d79a9be0b317d6925c53e9c19d69');
});

test('physical evidence schema contains required state and ownership constraints', async () => {
  const migration = await fs.readFile(
    new URL('../migrations/001_account_financial_serialization_evidence.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /financial_state_version BIGINT NOT NULL/);
  assert.match(migration, /UNIQUE \(user_id, id\)/);
  assert.match(migration, /user_id UUID NOT NULL UNIQUE REFERENCES synthetic_users/);
  assert.match(migration, /CREATE TABLE balance_snapshots/);
  assert.match(migration, /CREATE TABLE transactions/);
  assert.match(migration, /CREATE TABLE idempotency_keys/);
  assert.match(migration, /CREATE TABLE audit_events/);
  assert.doesNotMatch(migration, /advisory_lock/i);
});

test('protocol source contains exact owner-scoped account lock and post-lock idempotency lookup', async () => {
  const protocol = await fs.readFile(new URL('../src/protocol.mjs', import.meta.url), 'utf8');
  const accountLock = protocol.indexOf('FROM financial_accounts');
  const ownerPredicate = protocol.indexOf('WHERE id = $1 AND user_id = $2', accountLock);
  const forUpdate = protocol.indexOf('FOR UPDATE', ownerPredicate);
  const idempotency = protocol.indexOf('FROM idempotency_keys', forUpdate);
  assert.ok(accountLock >= 0 && ownerPredicate > accountLock && forUpdate > ownerPredicate);
  assert.ok(idempotency > forUpdate, 'idempotency lookup must occur after account FOR UPDATE');
  const db = await fs.readFile(new URL('../src/db.mjs', import.meta.url), 'utf8');
  assert.match(db, /BEGIN ISOLATION LEVEL READ COMMITTED/);
  assert.match(db, /after\.status === 'I'/);
  assert.doesNotMatch(db, /after\.status === null/);
  assert.match(protocol, /lease\.rollback\(\)/);
  assert.match(db, /'ROLLBACK'/);
});

test('retry constants exactly match frozen candidate policy', () => {
  assert.deepEqual([...RETRYABLE_SQLSTATES].sort(), ['40001', '40P01', '55P03']);
  assert.equal(POLICY.maxInternalRetries, 1);
  assert.equal(POLICY.maxAttempts, 2);
  assert.equal(POLICY.retryBackoffMinMs, 25);
  assert.equal(POLICY.retryBackoffMaxMs, 75);
  assert.equal(POLICY.lockTimeoutMs, 2_000);
  assert.equal(POLICY.statementTimeoutMs, 5_000);
  assert.equal(POLICY.databaseBudgetMs, 8_000);
  assert.equal(POLICY.commitRecoveryBudgetMs, 2_000);
});
