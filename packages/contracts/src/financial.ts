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
  voidedAt: instantSchema.nullable(),
  voidReason: z.string().nullable(),
  supersedesTransactionId: uuidSchema.nullable(),
  supersededByTransactionId: uuidSchema.nullable(),
  corrected: z.boolean(),
  balanceSnapshotId: uuidSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
  version: positiveVersionSchema,
});

export const createTransactionResponseSchema = z.strictObject({
  transactionId: uuidSchema,
  financialStateVersion: positiveVersionSchema,
});

export const correctionReplacementSchema = z.strictObject({
  amountMinor: positiveMinorSchema,
  occurredOn: localDateSchema,
  categoryCode: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  expenseClass: expenseClassSchema.optional(),
  isUnexpected: z.boolean(),
  note: z.string().trim().min(1).max(1_000).nullable().optional(),
});

export const correctionReasonSchema = z.string().trim().min(1).max(1_000);

export const correctionPreviewBodySchema = z.strictObject({
  replacement: correctionReplacementSchema,
  reason: correctionReasonSchema,
});

export const voidPreviewBodySchema = z.strictObject({
  reason: correctionReasonSchema,
});

export const correctionReviewContextSchema = z.strictObject({
  expectedFinancialStateVersion: positiveVersionSchema,
  reviewedLatestSnapshotId: uuidSchema,
  reviewedSourceVersion: positiveVersionSchema,
  reviewedSourceSnapshotId: uuidSchema,
  reviewedSourceBalanceEffect: balanceEffectSchema,
  reviewedSourceAlreadyIncludedInSnapshot: z.boolean(),
  reviewedSourceKind: transactionKindSchema,
  reviewedSourceCurrency: z.string().regex(/^[A-Z]{3}$/),
  reviewedPreviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export const correctionCommitBodySchema = z.strictObject({
  replacement: correctionReplacementSchema,
  reason: correctionReasonSchema,
  context: correctionReviewContextSchema,
});

export const voidCommitBodySchema = z.strictObject({
  reason: correctionReasonSchema,
  context: correctionReviewContextSchema,
});

const correctionReplacementFactSchema = z.strictObject({
  amountMinor: positiveMinorSchema,
  occurredOn: localDateSchema,
  categoryCode: z.string(),
  expenseClass: expenseClassSchema.nullable(),
  isUnexpected: z.boolean(),
  note: z.string().nullable(),
});

const correctionSourceFactSchema = correctionReplacementFactSchema.extend({
  transactionId: uuidSchema,
});

const reportImpactSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  categoryCode: z.string(),
  kind: transactionKindSchema,
});

export const correctionPreviewResponseSchema = z.strictObject({
  operation: z.enum(['correction', 'void']),
  source: correctionSourceFactSchema,
  replacement: correctionReplacementFactSchema.nullable(),
  authority: z.strictObject({
    currency: z.string().regex(/^[A-Z]{3}$/),
    balanceSnapshotId: uuidSchema,
    snapshotEffectiveAt: instantSchema,
    balanceEffect: balanceEffectSchema,
    alreadyIncludedInSnapshot: z.boolean(),
    segment: z.enum(['latest', 'closed']),
  }),
  currentBalance: z.strictObject({
    beforeMinor: signedMinorSchema,
    deltaMinor: signedMinorSchema,
    afterMinor: signedMinorSchema,
    changes: z.boolean(),
  }),
  reports: z.strictObject({
    removed: reportImpactSchema,
    added: reportImpactSchema.nullable(),
  }),
  owningDomain: z.strictObject({
    type: z.enum(['none', 'schedule', 'debt', 'planned_purchase']),
    genericCorrectionSupported: z.boolean(),
    genericVoidSupported: z.boolean(),
  }),
  context: correctionReviewContextSchema,
});

export const correctionCommitResponseSchema = z.strictObject({
  sourceTransactionId: uuidSchema,
  replacementTransactionId: uuidSchema.nullable(),
  financialStateVersion: positiveVersionSchema,
});

export const monthlyActualsQuerySchema = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

export const monthlyActualsResponseSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  incomeMinor: signedMinorSchema,
  expenseMinor: signedMinorSchema,
  netMinor: signedMinorSchema,
  groups: z.array(z.strictObject({
    categoryCode: z.string(),
    kind: transactionKindSchema,
    amountMinor: signedMinorSchema,
    transactionCount: z.number().int().nonnegative(),
    amended: z.boolean(),
  })),
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
export const transactionCorrectionHistoryResponseSchema = z.strictObject({
  items: z.array(transactionSchema).min(1),
});

export {
  idempotencyHeadersSchema,
};

export type CreateSnapshotBody = z.infer<typeof createSnapshotBodySchema>;
export type CreateSnapshotResponse = z.infer<typeof createSnapshotResponseSchema>;
export type CreateTransactionBody = z.infer<typeof createTransactionBodySchema>;
export type CreateTransactionResponse = z.infer<typeof createTransactionResponseSchema>;
export type CorrectionPreviewBody = z.infer<typeof correctionPreviewBodySchema>;
export type VoidPreviewBody = z.infer<typeof voidPreviewBodySchema>;
export type CorrectionCommitBody = z.infer<typeof correctionCommitBodySchema>;
export type VoidCommitBody = z.infer<typeof voidCommitBodySchema>;
export type CorrectionPreviewResponse = z.infer<typeof correctionPreviewResponseSchema>;
export type CorrectionCommitResponse = z.infer<typeof correctionCommitResponseSchema>;
export type CurrentBalance = z.infer<typeof currentBalanceSchema>;
export type MonthlyActuals = z.infer<typeof monthlyActualsResponseSchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;
