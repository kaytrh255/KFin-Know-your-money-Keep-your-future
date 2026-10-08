export const FROZEN_SOURCE_COMMIT = 'e298e6b4e142d79a9be0b317d6925c53e9c19d69';
export const POLICY_ID = 'account_financial_serialization.v1';
export const SCHEMA_VERSION = '001';

export const POLICY = Object.freeze({
  isolationLevel: 'READ COMMITTED',
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000,
  databaseBudgetMs: 8_000,
  retryBackoffMinMs: 25,
  retryBackoffMaxMs: 75,
  maxAttempts: 2,
  maxInternalRetries: 1,
  commitRecoveryBudgetMs: 2_000,
  // Evidence-only operational reserve. It is emitted in every artifact and does
  // not approve or amend the frozen specification's candidate bounds.
  cleanupReserveMs: 500,
});

export const RETRYABLE_SQLSTATES = new Set(['55P03', '40P01', '40001']);
export const NON_RETRYABLE_TIMEOUT_SQLSTATE = '57014';

export const CASE_IDS = Object.freeze([
  'FIN-RACE-01',
  'FIN-RACE-02',
  'FIN-RACE-03',
  'FIN-RACE-04',
  'FIN-RACE-05',
  'FIN-RACE-06',
  'FIN-RACE-07',
  'FIN-RACE-08',
]);

export const RESULT_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_RUN: 'NOT RUN',
  BLOCKED: 'BLOCKED',
});

export const RESULT_CODES = Object.freeze({
  SNAPSHOT_STALE: 'FIN_SNAPSHOT_STALE_STATE',
  CORRECTION_STALE: 'FIN_CORRECTION_STALE_STATE',
  FINANCIAL_STALE: 'FINANCIAL_STATE_STALE',
  IDEMPOTENCY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  CONCURRENCY_BUSY: 'FINANCIAL_CONCURRENCY_BUSY',
  OPERATION_TIMEOUT: 'FINANCIAL_OPERATION_TIMEOUT',
  RESULT_UNKNOWN: 'FINANCIAL_RESULT_UNKNOWN',
  ACCOUNT_UNAVAILABLE: 'FINANCIAL_ACCOUNT_UNAVAILABLE',
  COMMITTED: 'FINANCIAL_MUTATION_COMMITTED',
});

export const LOCK_RANK = Object.freeze({
  account: 1,
  snapshot: 2,
  transaction: 3,
  occurrence: 4,
  debt: 5,
  purchase: 6,
  savings: 7,
  result: 8,
});
