import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  emailNormalized: text('email_normalized').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
  displayName: text('display_name'),
  locale: text('locale').notNull(),
  timezone: text('timezone').notNull(),
  baseCurrency: char('base_currency', { length: 3 }).notNull(),
  status: text('status').notNull(),
  ...auditColumns,
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true, mode: 'date' }),
  deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true, mode: 'date' }),
  version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
}, (table) => [
  unique('users_email_normalized_uq').on(table.emailNormalized),
  unique('users_id_currency_uq').on(table.id, table.baseCurrency),
  check('users_currency_ck', sql`${table.baseCurrency} ~ '^[A-Z]{3}$'`),
  check('users_version_ck', sql`${table.version} >= 1`),
]);

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey(),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  messageKey: text('message_key').notNull(),
  transactionKind: text('transaction_kind').notNull(),
  defaultExpenseClass: text('default_expense_class'),
  active: boolean('active').notNull().default(true),
  displayOrder: integer('display_order').notNull(),
  ...auditColumns,
}, (table) => [
  unique('categories_code_uq').on(table.code),
  unique('categories_id_kind_uq').on(table.id, table.transactionKind),
]);

export const financialAccounts = pgTable('financial_accounts', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  name: text('name').notNull(),
  accountType: text('account_type').notNull().default('aggregate_liquid'),
  currency: char('currency', { length: 3 }).notNull(),
  financialStateVersion: bigint('financial_state_version', { mode: 'bigint' }).notNull().default(1n),
  ...auditColumns,
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
}, (table) => [
  unique('financial_accounts_user_uq').on(table.userId),
  unique('financial_accounts_owner_id_uq').on(table.userId, table.id),
  unique('financial_accounts_owner_id_currency_uq').on(table.userId, table.id, table.currency),
  foreignKey({
    name: 'financial_accounts_user_currency_fk',
    columns: [table.userId, table.currency],
    foreignColumns: [users.id, users.baseCurrency],
  }).onDelete('restrict'),
  check('financial_accounts_state_version_ck', sql`${table.financialStateVersion} >= 1`),
]);

export const balanceSnapshots = pgTable('balance_snapshots', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  accountId: uuid('account_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  effectiveAt: timestamp('effective_at', { withTimezone: true, mode: 'date' }).notNull(),
  effectiveLocalDate: date('effective_local_date', { mode: 'string' }).notNull(),
  timezone: text('timezone').notNull(),
  reason: text('reason').notNull(),
  note: text('note'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  createdByOperatorId: uuid('created_by_operator_id'),
  correlationId: text('correlation_id').notNull(),
  ...auditColumns,
}, (table) => [
  unique('balance_snapshots_account_effective_uq').on(table.accountId, table.effectiveAt),
  unique('balance_snapshots_owner_account_id_currency_uq').on(
    table.userId,
    table.accountId,
    table.id,
    table.currency,
  ),
  foreignKey({
    name: 'balance_snapshots_account_currency_fk',
    columns: [table.userId, table.accountId, table.currency],
    foreignColumns: [financialAccounts.userId, financialAccounts.id, financialAccounts.currency],
  }).onDelete('restrict'),
  index('balance_snapshots_latest_idx').on(table.userId, table.accountId, table.effectiveAt),
]);

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  accountId: uuid('account_id').notNull(),
  balanceSnapshotId: uuid('balance_snapshot_id').notNull(),
  kind: text('kind').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  occurredOn: date('occurred_on', { mode: 'string' }).notNull(),
  balanceEffect: text('balance_effect').notNull(),
  alreadyIncludedInSnapshot: boolean('already_included_in_snapshot').notNull(),
  categoryId: uuid('category_id').notNull(),
  expenseClass: text('expense_class'),
  isUnexpected: boolean('is_unexpected').notNull().default(false),
  note: text('note'),
  status: text('status').notNull().default('posted'),
  voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'date' }),
  voidReason: text('void_reason'),
  supersedesTransactionId: uuid('supersedes_transaction_id'),
  ...auditColumns,
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
}, (table) => [
  unique('transactions_owner_account_id_uq').on(table.userId, table.accountId, table.id),
  uniqueIndex('transactions_successor_uq')
    .on(table.supersedesTransactionId)
    .where(sql`${table.supersedesTransactionId} IS NOT NULL`),
  foreignKey({
    name: 'transactions_snapshot_currency_fk',
    columns: [table.userId, table.accountId, table.balanceSnapshotId, table.currency],
    foreignColumns: [
      balanceSnapshots.userId,
      balanceSnapshots.accountId,
      balanceSnapshots.id,
      balanceSnapshots.currency,
    ],
  }).onDelete('restrict'),
  foreignKey({
    name: 'transactions_category_kind_fk',
    columns: [table.categoryId, table.kind],
    foreignColumns: [categories.id, categories.transactionKind],
  }).onDelete('restrict'),
  foreignKey({
    name: 'transactions_supersedes_same_owner_fk',
    columns: [table.userId, table.accountId, table.supersedesTransactionId],
    foreignColumns: [table.userId, table.accountId, table.id],
  }).onDelete('restrict'),
  index('transactions_activity_idx').on(table.userId, table.occurredOn, table.id),
  index('transactions_current_balance_idx').on(
    table.userId,
    table.balanceSnapshotId,
    table.balanceEffect,
    table.status,
  ),
  check('transactions_positive_amount_ck', sql`${table.amountMinor} > 0`),
]);

export const scheduledItems = pgTable('scheduled_items', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  accountId: uuid('account_id').notNull(),
  kind: text('kind').notNull(),
  transactionKind: text('transaction_kind').notNull(),
  title: text('title').notNull(),
  expectedAmountMinor: bigint('expected_amount_minor', { mode: 'bigint' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  categoryId: uuid('category_id').notNull(),
  expenseClass: text('expense_class'),
  frequency: text('frequency').notNull().default('one_off'),
  recurrenceInterval: integer('recurrence_interval').notNull().default(1),
  startOn: date('start_on', { mode: 'string' }).notNull(),
  endOn: date('end_on', { mode: 'string' }),
  timezone: text('timezone').notNull(),
  confirmationPolicy: text('confirmation_policy').notNull().default('explicit'),
  active: boolean('active').notNull().default(true),
  ...auditColumns,
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
}, (table) => [
  unique('scheduled_items_owner_account_id_uq').on(table.userId, table.accountId, table.id),
  unique('scheduled_items_owner_account_id_currency_kind_uq').on(
    table.userId,
    table.accountId,
    table.id,
    table.currency,
    table.transactionKind,
  ),
  foreignKey({
    name: 'scheduled_items_account_currency_fk',
    columns: [table.userId, table.accountId, table.currency],
    foreignColumns: [financialAccounts.userId, financialAccounts.id, financialAccounts.currency],
  }).onDelete('restrict'),
  foreignKey({
    name: 'scheduled_items_category_kind_fk',
    columns: [table.categoryId, table.transactionKind],
    foreignColumns: [categories.id, categories.transactionKind],
  }).onDelete('restrict'),
  index('scheduled_items_owner_active_idx').on(table.userId, table.active, table.startOn, table.id),
]);

export const scheduledOccurrences = pgTable('scheduled_occurrences', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  accountId: uuid('account_id').notNull(),
  scheduledItemId: uuid('scheduled_item_id').notNull(),
  transactionKind: text('transaction_kind').notNull(),
  dueOn: date('due_on', { mode: 'string' }).notNull(),
  expectedAmountMinor: bigint('expected_amount_minor', { mode: 'bigint' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  state: text('state').notNull().default('scheduled'),
  confirmedTransactionId: uuid('confirmed_transaction_id'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
  skippedAt: timestamp('skipped_at', { withTimezone: true, mode: 'date' }),
  skipReason: text('skip_reason'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  ...auditColumns,
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
}, (table) => [
  unique('scheduled_occurrences_item_due_uq').on(table.scheduledItemId, table.dueOn),
  unique('scheduled_occurrences_confirmed_transaction_uq').on(table.confirmedTransactionId),
  unique('scheduled_occurrences_owner_account_id_uq').on(table.userId, table.accountId, table.id),
  foreignKey({
    name: 'scheduled_occurrences_item_fk',
    columns: [
      table.userId,
      table.accountId,
      table.scheduledItemId,
      table.currency,
      table.transactionKind,
    ],
    foreignColumns: [
      scheduledItems.userId,
      scheduledItems.accountId,
      scheduledItems.id,
      scheduledItems.currency,
      scheduledItems.transactionKind,
    ],
  }).onDelete('restrict'),
  foreignKey({
    name: 'scheduled_occurrences_transaction_fk',
    columns: [table.userId, table.accountId, table.confirmedTransactionId],
    foreignColumns: [transactions.userId, transactions.accountId, transactions.id],
  }).onDelete('restrict'),
  index('scheduled_occurrences_owner_due_idx').on(table.userId, table.state, table.dueOn, table.id),
]);

export const idempotencyResults = pgTable('idempotency_results', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  accountId: uuid('account_id'),
  operation: text('operation').notNull(),
  keyDigest: text('key_digest').notNull(),
  requestDigest: text('request_digest').notNull(),
  priorFinancialStateVersion: bigint('prior_financial_state_version', { mode: 'bigint' }),
  committedFinancialStateVersion: bigint('committed_financial_state_version', { mode: 'bigint' }),
  responseStatus: smallint('response_status').notNull(),
  resultCode: text('result_code').notNull(),
  result: jsonb('result').notNull(),
  correlationId: text('correlation_id').notNull(),
  ...auditColumns,
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
}, (table) => [
  foreignKey({
    name: 'idempotency_results_account_owner_fk',
    columns: [table.userId, table.accountId],
    foreignColumns: [financialAccounts.userId, financialAccounts.id],
  }).onDelete('restrict'),
  uniqueIndex('idempotency_results_account_scope_uq')
    .on(table.userId, table.accountId, table.operation, table.keyDigest)
    .where(sql`${table.accountId} IS NOT NULL`),
  uniqueIndex('idempotency_results_user_scope_uq')
    .on(table.userId, table.operation, table.keyDigest)
    .where(sql`${table.accountId} IS NULL`),
]);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
  actorOperatorId: uuid('actor_operator_id'),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: uuid('resource_id').notNull(),
  outcome: text('outcome').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  correlationId: text('correlation_id').notNull(),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
});

export const schema = {
  users,
  categories,
  financialAccounts,
  balanceSnapshots,
  transactions,
  scheduledItems,
  scheduledOccurrences,
  idempotencyResults,
  auditEvents,
};

// Trusted Private Beta access tables (migration 0004). Bytea columns hold
// keyed digests only; no plaintext secret is ever persisted.
const digest = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const betaInvitations = pgTable('beta_invitations', {
  id: uuid('id').primaryKey(),
  codeDigest: digest('code_digest').notNull(),
  invitedEmailNormalized: text('invited_email_normalized'),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
  consumedByUserId: uuid('consumed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdByOperatorId: uuid('created_by_operator_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  unique('beta_invitations_code_digest_uq').on(table.codeDigest),
]);

export const passwordCredentials = pgTable('password_credentials', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  hashPolicyVersion: smallint('hash_policy_version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const authChallenges = pgTable('auth_challenges', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  targetDigest: digest('target_digest').notNull(),
  secretDigest: digest('secret_digest').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
  supersededAt: timestamp('superseded_at', { withTimezone: true, mode: 'date' }),
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: smallint('max_attempts').notNull().default(5),
  requestContextDigest: digest('request_context_digest'),
  deliveryStatus: text('delivery_status').notNull().default('pending'),
  lastDeliveryAttemptAt: timestamp('last_delivery_attempt_at', { withTimezone: true, mode: 'date' }),
  lastDeliveryStatus: text('last_delivery_status'),
  correlationId: text('correlation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  unique('auth_challenges_secret_digest_uq').on(table.secretDigest),
  index('auth_challenges_target_idx').on(table.purpose, table.targetDigest, table.issuedAt),
  index('auth_challenges_user_idx').on(table.userId, table.purpose, table.issuedAt),
]);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  familyId: uuid('family_id').notNull(),
  clientType: text('client_type').notNull().default('web'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  revocationReason: text('revocation_reason'),
  deviceLabel: text('device_label'),
  ipPrefixDigest: digest('ip_prefix_digest'),
  csrfDigest: digest('csrf_digest').notNull(),
  version: integer('version').notNull().default(1),
}, (table) => [
  index('sessions_user_active_idx').on(table.userId),
  index('sessions_user_last_seen_idx').on(table.userId, table.lastSeenAt),
  index('sessions_family_idx').on(table.familyId),
]);

export const sessionTokens = pgTable('session_tokens', {
  id: uuid('id').primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  tokenDigest: digest('token_digest').notNull(),
  generation: integer('generation').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
  graceExpiresAt: timestamp('grace_expires_at', { withTimezone: true, mode: 'date' }),
  replayedAt: timestamp('replayed_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  unique('session_tokens_digest_uq').on(table.tokenDigest),
  unique('session_tokens_generation_uq').on(table.sessionId, table.generation),
]);

export const securityEvents = pgTable('security_events', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  eventType: text('event_type').notNull(),
  outcome: text('outcome').notNull(),
  visibility: text('visibility').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  correlationId: text('correlation_id').notNull(),
  targetDigest: digest('target_digest'),
  ipPrefixDigest: digest('ip_prefix_digest'),
  metadata: jsonb('metadata').notNull().default({}),
}, (table) => [
  index('security_events_user_idx').on(table.userId, table.occurredAt, table.id),
  index('security_events_target_idx').on(table.targetDigest, table.occurredAt),
]);

export const authAttemptCounters = pgTable('auth_attempt_counters', {
  scopeKind: text('scope_kind').notNull(),
  scopeDigest: digest('scope_digest').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
  count: integer('count').notNull().default(1),
  firstAt: timestamp('first_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  lastAt: timestamp('last_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  unique('auth_attempt_counters_pkey').on(table.scopeKind, table.scopeDigest, table.windowStart),
  index('auth_attempt_counters_window_idx').on(table.windowStart),
]);
