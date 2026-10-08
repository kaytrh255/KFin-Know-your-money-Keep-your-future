import { z } from 'zod';
import {
  localDateSchema,
  positiveMinorSchema,
  positiveVersionSchema,
  uuidSchema,
} from './common.js';
import { expenseClassSchema, transactionKindSchema } from './financial.js';

export const occurrenceStateSchema = z.enum(['scheduled', 'confirmed', 'skipped', 'cancelled']);
export const occurrencePresentationSchema = z.enum([
  'upcoming',
  'due_today',
  'overdue',
  'projected',
  'paid',
  'received',
  'skipped',
  'cancelled',
]);

export const scheduleExpenseClassSchema = z.enum(['essential_fixed', 'essential_variable']);

export const createOneOffScheduleBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  kind: transactionKindSchema,
  expectedAmountMinor: positiveMinorSchema,
  dueOn: localDateSchema,
  categoryCode: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  expenseClass: scheduleExpenseClassSchema.optional(),
  expectedFinancialStateVersion: positiveVersionSchema,
  reviewedLatestSnapshotId: uuidSchema,
});

export const createOneOffScheduleResponseSchema = z.strictObject({
  scheduledItemId: uuidSchema,
  occurrenceId: uuidSchema,
  financialStateVersion: positiveVersionSchema,
});

export const occurrenceSchema = z.strictObject({
  id: uuidSchema,
  scheduledItemId: uuidSchema,
  title: z.string(),
  kind: transactionKindSchema,
  direction: z.enum(['incoming', 'outgoing']),
  expectedAmountMinor: positiveMinorSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  dueOn: localDateSchema,
  categoryCode: z.string(),
  expenseClass: expenseClassSchema.nullable(),
  state: occurrenceStateSchema,
  presentation: occurrencePresentationSchema,
  confirmedTransactionId: uuidSchema.nullable(),
  confirmedAt: z.string().datetime({ offset: true }).nullable(),
  skippedAt: z.string().datetime({ offset: true }).nullable(),
  skipReason: z.string().nullable(),
  cancelledAt: z.string().datetime({ offset: true }).nullable(),
  version: positiveVersionSchema,
});

export const occurrenceListQuerySchema = z.strictObject({
  state: occurrenceStateSchema.optional(),
  kind: transactionKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const occurrenceListResponseSchema = z.strictObject({
  items: z.array(occurrenceSchema),
  nextCursor: z.string().nullable(),
});

export const occurrencePathSchema = z.strictObject({ id: uuidSchema });

export const confirmOccurrenceBodySchema = z.strictObject({
  amountMinor: positiveMinorSchema,
  occurredOn: localDateSchema,
  categoryCode: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  expenseClass: expenseClassSchema.optional(),
  isUnexpected: z.boolean().default(false),
  alreadyIncludedInSnapshot: z.boolean().optional(),
  note: z.string().trim().min(1).max(1_000).optional(),
  expectedFinancialStateVersion: positiveVersionSchema,
  reviewedLatestSnapshotId: uuidSchema,
  reviewedOccurrenceVersion: positiveVersionSchema,
});

export const confirmOccurrenceResponseSchema = z.strictObject({
  occurrenceId: uuidSchema,
  transactionId: uuidSchema,
  state: z.literal('confirmed'),
  financialStateVersion: positiveVersionSchema,
  occurrenceVersion: positiveVersionSchema,
});

export const transitionOccurrenceBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(1_000),
  expectedFinancialStateVersion: positiveVersionSchema,
  reviewedLatestSnapshotId: uuidSchema,
  reviewedOccurrenceVersion: positiveVersionSchema,
});

export const transitionOccurrenceResponseSchema = z.strictObject({
  occurrenceId: uuidSchema,
  state: z.enum(['skipped', 'cancelled']),
  financialStateVersion: positiveVersionSchema,
  occurrenceVersion: positiveVersionSchema,
});

export type CreateOneOffScheduleBody = z.infer<typeof createOneOffScheduleBodySchema>;
export type CreateOneOffScheduleResponse = z.infer<typeof createOneOffScheduleResponseSchema>;
export type Occurrence = z.infer<typeof occurrenceSchema>;
export type OccurrenceListQuery = z.infer<typeof occurrenceListQuerySchema>;
export type ConfirmOccurrenceBody = z.infer<typeof confirmOccurrenceBodySchema>;
export type ConfirmOccurrenceResponse = z.infer<typeof confirmOccurrenceResponseSchema>;
export type TransitionOccurrenceBody = z.infer<typeof transitionOccurrenceBodySchema>;
export type TransitionOccurrenceResponse = z.infer<typeof transitionOccurrenceResponseSchema>;
