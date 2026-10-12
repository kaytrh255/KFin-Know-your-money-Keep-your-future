export const FROZEN_SOURCE_COMMIT = 'a48d2c5683550859c1b4e19e9d06750616adc0a2';

// Authoritative-document pinning. The five documents listed in AUTHORITATIVE_DOCS are the
// reviewed text the SPEC-FIN-02 candidate depends on. Three of them are shared specification
// documents that a dated, recorded product decision may legitimately amend; those are pinned
// to the SHA-256 of their reviewed amended content, because they can no longer equal the frozen
// candidate text. Any later edit fails exactly as a frozen-commit comparison would, so the
// control is unchanged in strength — it just names the revision it was reviewed against.
// The SPEC-FIN-02 candidate documents stay compared byte-for-byte with FROZEN_SOURCE_COMMIT.
export const AMENDED_AUTHORITATIVE_DOCS = Object.freeze({
  revision: Object.freeze({
    id: 'OQ-20',
    date: '2026-10-12',
    record: 'docs/evidence/2026-10-12-AUTH-POLICY-SPECIFICATION-REVISION.md',
  }),
  sha256: Object.freeze({
    'docs/architecture/DATABASE.md': '28edd67d4a5d2278222fe4ccc64be2262f6e9c412831f7c23e70ff230bad93eb',
    'docs/testing/TEST-STRATEGY.md': 'f94b9e01e76323bdd0a0c2354f997e4cd6d7af88b4dab2eb777654b931e718fc',
    'docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md': '1344761833a009f157a6b92abfe24c46427dfd04e6aa15e86bad2b131de86c9a',
  }),
});
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
