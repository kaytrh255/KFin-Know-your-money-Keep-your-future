import { z } from 'zod';
import {
  instantSchema,
  localDateSchema,
  positiveMinorSchema,
  positiveVersionSchema,
  uuidSchema,
} from './common.js';

// Savings goals (PRD-SAV-01..07, DATABASE §9). Amounts are integer minor-unit
// strings in the user's base currency; a goal is a declared reserve estimate,
// not a cash ledger.

export const nonNegativeMinorSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
export const contributionFrequencySchema = z.enum(['weekly', 'monthly', 'yearly']);
export const savingsGoalStatusSchema = z.enum(['active', 'archived']);
const goalNameSchema = z.string().trim().min(1).max(120);

export const createSavingsGoalBodySchema = z.strictObject({
  name: goalNameSchema,
  targetAmountMinor: positiveMinorSchema,
  currentAmountMinor: nonNegativeMinorSchema,
  currentAmountAsOf: localDateSchema,
  targetDate: localDateSchema.nullable().optional(),
  plannedContributionMinor: positiveMinorSchema.nullable().optional(),
  contributionFrequency: contributionFrequencySchema.nullable().optional(),
});

export const updateSavingsGoalPlanBodySchema = z.strictObject({
  expectedVersion: positiveVersionSchema,
  name: goalNameSchema.optional(),
  targetAmountMinor: positiveMinorSchema.optional(),
  targetDate: localDateSchema.nullable().optional(),
  plannedContributionMinor: positiveMinorSchema.nullable().optional(),
  contributionFrequency: contributionFrequencySchema.nullable().optional(),
}).refine(
  (body) => Object.keys(body).some((key) => key !== 'expectedVersion'),
  { message: 'At least one plan field must be provided.' },
);

export const updateSavingsCurrentAmountBodySchema = z.strictObject({
  expectedVersion: positiveVersionSchema,
  currentAmountMinor: nonNegativeMinorSchema,
  asOf: localDateSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});

export const archiveSavingsGoalBodySchema = z.strictObject({
  expectedVersion: positiveVersionSchema,
});

export const savingsGoalPathSchema = z.strictObject({ id: uuidSchema });

export const savingsProgressSchema = z.strictObject({
  percentBasisPoints: z.string().regex(/^[0-9]+$/),
  achieved: z.boolean(),
  overTarget: z.boolean(),
  remainingMinor: nonNegativeMinorSchema,
});

export const savingsGoalSchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  targetAmountMinor: positiveMinorSchema,
  currentAmountMinor: nonNegativeMinorSchema,
  currentAmountAsOf: localDateSchema,
  targetDate: localDateSchema.nullable(),
  plannedContributionMinor: positiveMinorSchema.nullable(),
  contributionFrequency: contributionFrequencySchema.nullable(),
  status: savingsGoalStatusSchema,
  archivedAt: instantSchema.nullable(),
  progress: savingsProgressSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
  version: positiveVersionSchema,
});

export const savingsGoalListQuerySchema = z.strictObject({
  status: z.enum(['active', 'archived', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const savingsGoalListResponseSchema = z.strictObject({
  items: z.array(savingsGoalSchema),
  nextCursor: z.string().nullable(),
});

export const savingsAmountChangeSchema = z.strictObject({
  id: uuidSchema,
  goalVersion: positiveVersionSchema,
  previousAmountMinor: nonNegativeMinorSchema.nullable(),
  newAmountMinor: nonNegativeMinorSchema,
  asOf: localDateSchema,
  source: z.enum(['initial', 'manual_update', 'planned_purchase_use', 'recovery_correction']),
  reason: z.string().nullable(),
  actorType: z.enum(['user', 'operator']),
  createdAt: instantSchema,
});

export const savingsAmountChangeListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const savingsAmountChangeListResponseSchema = z.strictObject({
  items: z.array(savingsAmountChangeSchema),
  nextCursor: z.string().nullable(),
});

export const savingsGoalAmountReceiptSchema = z.strictObject({
  goalId: uuidSchema,
  version: positiveVersionSchema,
  amountChangeId: uuidSchema,
});

export const savingsGoalReceiptSchema = z.strictObject({
  goalId: uuidSchema,
  version: positiveVersionSchema,
});

export type CreateSavingsGoalBody = z.infer<typeof createSavingsGoalBodySchema>;
export type UpdateSavingsGoalPlanBody = z.infer<typeof updateSavingsGoalPlanBodySchema>;
export type UpdateSavingsCurrentAmountBody = z.infer<typeof updateSavingsCurrentAmountBodySchema>;
export type SavingsGoal = z.infer<typeof savingsGoalSchema>;
export type SavingsAmountChange = z.infer<typeof savingsAmountChangeSchema>;
