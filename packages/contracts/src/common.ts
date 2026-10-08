import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const positiveVersionSchema = z.string().regex(/^[1-9][0-9]*$/);
export const positiveMinorSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const signedMinorSchema = z.string().regex(/^(?:0|-?[1-9][0-9]{0,18})$/);
export const localDateSchema = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/);
export const yearMonthSchema = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/);
export const instantSchema = z.string().datetime({ offset: true });

// Request headers necessarily include transport headers (host, content-type,
// content-length, and others). Validate the required financial header without
// treating those transport fields as application input.
export const idempotencyHeadersSchema = z.object({
  'idempotency-key': z.string().trim().min(1).max(256),
});

export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(240),
    correlationId: z.string().min(1).max(128),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
