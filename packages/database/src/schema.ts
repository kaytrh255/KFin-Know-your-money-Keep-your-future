import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
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
  idempotencyResults,
  auditEvents,
};
