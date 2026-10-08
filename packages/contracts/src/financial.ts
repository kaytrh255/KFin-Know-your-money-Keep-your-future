import { z } from 'zod';
import {
  idempotencyHeadersSchema,
  instantSchema,
  localDateSchema,
  positiveMinorSchema,
  positiveVersionSchema,
  signedMinorSchema,
  uuidSchema,
} from './common.js';

export const transactionKindSchema = z.enum(['income', 'expense']);
export const expenseClassSchema = z.enum(['essential_fixed', 'essential_variable', 'daily']);
export const balanceEffectSchema = z.enum(['current', 'historical']);

export const currentBalanceSchema = z.strictObject({
  accountId: uuidSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  financialStateVersion: positiveVersionSchema,
  snapshot: z.strictObject({
    id: uuidSchema,
    amountMinor: signedMinorSchema,
    effectiveAt: instantSchema,
    effectiveLocalDate: localDateSchema,
  }),
  postedCurrentIncomeMinor: signedMinorSchema,
  postedCurrentExpenseMinor: signedMinorSchema,
  currentBalanceMinor: signedMinorSchema,
});

export const createSnapshotBodySchema = z.strictObject({
  amountMinor: signedMinorSchema,
  effectiveAt: instantSchema,
  note: z.string().trim().min(1).max(1_000).optional(),
  expectedFinancialStateVersion: positiveVersionSchema,
  reviewedLatestSnapshotId: uuidSchema,
});

export const createSnapshotResponseSchema = z.strictObject({
  snapshotId: uuidSchema,
  financialStateVersion: positiveVersionSchema,
});

export const createTransactionBodySchema = z.strictObject({
  kind: transactionKindSchema,
  amountMinor: positiveMinorSchema,
  occurredOn: localDateSchema,
  categoryCode: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  expenseClass: expenseClassSchema.optional(),
  isUnexpected: z.boolean().default(false),
  alreadyIncludedInSnapshot: z.boolean().optional(),
  note: z.string().trim().min(1).max(1_000).optional(),
  expectedFinancialStateVersion: positiveVersionSchema,
  reviewedLatestSnapshotId: uuidSchema,
});

export const transactionSchema = z.strictObject({
  id: uuidSchema,
  kind: transactionKindSchema,
  amountMinor: positiveMinorSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  occurredOn: localDateSchema,
  balanceEffect: balanceEffectSchema,
  alreadyIncludedInSnapshot: z.boolean(),
  categoryCode: z.string(),
  expenseClass: expenseClassSchema.nullable(),
  isUnexpected: z.boolean(),
  note: z.string().nullable(),
  status: z.enum(['posted', 'voided']),
  balanceSnapshotId: uuidSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
  version: positiveVersionSchema,
});

export const createTransactionResponseSchema = z.strictObject({
  transactionId: uuidSchema,
  financialStateVersion: positiveVersionSchema,
});

export const transactionPathSchema = z.strictObject({ id: uuidSchema });
export const transactionListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export const transactionListResponseSchema = z.strictObject({
  items: z.array(transactionSchema),
  nextCursor: z.string().nullable(),
});

export {
  idempotencyHeadersSchema,
};

export type CreateSnapshotBody = z.infer<typeof createSnapshotBodySchema>;
export type CreateSnapshotResponse = z.infer<typeof createSnapshotResponseSchema>;
export type CreateTransactionBody = z.infer<typeof createTransactionBodySchema>;
export type CreateTransactionResponse = z.infer<typeof createTransactionResponseSchema>;
export type CurrentBalance = z.infer<typeof currentBalanceSchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;
