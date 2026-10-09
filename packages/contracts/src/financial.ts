import { z } from 'zod';
import {
  idempotencyHeadersSchema,
  instantSchema,
  localDateSchema,
  positiveMinorSchema,
  positiveVersionSchema,
  signedMinorSchema,
  uuidSchema,
  yearMonthSchema,
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

export const correctionOwningDomainReviewSchema = z.strictObject({
  type: z.enum(['none', 'schedule']),
  scheduleOccurrenceId: uuidSchema.nullable(),
  scheduleOccurrenceVersion: positiveVersionSchema.nullable(),
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
  reviewedUserTimezone: z.string().min(1).max(255),
  reviewedUserVersion: positiveVersionSchema,
  reviewedOwningDomain: correctionOwningDomainReviewSchema,
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
  month: yearMonthSchema,
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
    unsupportedReasonCode: z.literal('FIN_CORRECTION_LINKED_DOMAIN_REQUIRED').nullable(),
    scheduleOccurrenceId: uuidSchema.nullable(),
    scheduleOccurrenceVersion: positiveVersionSchema.nullable(),
  }),
  context: correctionReviewContextSchema,
});

export const correctionCommitResponseSchema = z.strictObject({
  sourceTransactionId: uuidSchema,
  replacementTransactionId: uuidSchema.nullable(),
  financialStateVersion: positiveVersionSchema,
  consequence: z.strictObject({
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
      type: z.enum(['none', 'schedule']),
      scheduleOccurrenceId: uuidSchema.nullable(),
      scheduleOccurrenceVersion: positiveVersionSchema.nullable(),
    }),
  }),
});

export const monthlyActualsQuerySchema = z.strictObject({
  month: yearMonthSchema,
});

export const monthlyActualsResponseSchema = z.strictObject({
  month: yearMonthSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  incomeMinor: signedMinorSchema,
  expenseMinor: signedMinorSchema,
  netMinor: signedMinorSchema,
  groups: z.array(z.strictObject({
    categoryCode: z.string(),
    kind: transactionKindSchema,
    balanceEffect: balanceEffectSchema,
    amountMinor: signedMinorSchema,
    transactionCount: z.number().int().nonnegative(),
    amended: z.boolean(),
    drilldown: z.strictObject({
      month: yearMonthSchema,
      categoryCode: z.string(),
      kind: transactionKindSchema,
      balanceEffect: balanceEffectSchema,
    }),
  })),
});

export const transactionPathSchema = z.strictObject({ id: uuidSchema });
export const transactionListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
  month: yearMonthSchema.optional(),
  categoryCode: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/).optional(),
  kind: transactionKindSchema.optional(),
  balanceEffect: balanceEffectSchema.optional(),
});
export const transactionListResponseSchema = z.strictObject({
  items: z.array(transactionSchema),
  nextCursor: z.string().nullable(),
});
export const transactionCorrectionHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export const transactionCorrectionHistoryResponseSchema = z.strictObject({
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
export type TransactionCorrectionHistoryQuery = z.infer<typeof transactionCorrectionHistoryQuerySchema>;

/**
 * Milestone 05 — authenticated financial-account onboarding.
 *
 * The body carries only the opening known balance and its effective instant.
 * Ownership is never accepted from the client: a strict object rejects any
 * `ownerId`, `userId`, `accountId`, currency, or version field. The opening
 * amount is typed as a bounded string here and validated semantically by the
 * service so a malformed amount yields `422 FIN_OPENING_BALANCE_INVALID`
 * rather than a generic contract failure.
 */
export const openFinancialAccountBodySchema = z.strictObject({
  openingBalanceMinor: z.string().max(64),
  effectiveAt: instantSchema,
});

export const openFinancialAccountResponseSchema = z.strictObject({
  accountId: uuidSchema,
  snapshotId: uuidSchema,
  financialStateVersion: positiveVersionSchema,
});

export const financialAccountSummarySchema = z.strictObject({
  accountId: uuidSchema,
  name: z.string().min(1).max(120),
  accountType: z.literal('aggregate_liquid'),
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

export const financialAccountListResponseSchema = z.strictObject({
  items: z.array(financialAccountSummarySchema).max(100),
});
