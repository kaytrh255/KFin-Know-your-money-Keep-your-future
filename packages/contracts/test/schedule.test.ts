import { describe, expect, it } from 'vitest';
import {
  createOneOffScheduleBodySchema,
  occurrenceListQuerySchema,
  occurrenceListResponseSchema,
  occurrenceSchema,
  occurrenceStateSchema,
} from '../src/index.js';

const context = {
  expectedFinancialStateVersion: '1',
  reviewedLatestSnapshotId: '10000000-0000-4000-8000-000000000001',
};

describe('schedule contracts', () => {
  it('accepts a strict one-off schedule request', () => {
    expect(createOneOffScheduleBodySchema.parse({
      title: 'Rent',
      kind: 'expense',
      expectedAmountMinor: '12000000',
      dueOn: '2026-10-15',
      categoryCode: 'housing',
      expenseClass: 'essential_fixed',
      ...context,
    })).toMatchObject({ title: 'Rent', kind: 'expense' });
  });

  it('rejects daily/discretionary classification from the essential-expense slice', () => {
    expect(() => createOneOffScheduleBodySchema.parse({
      title: 'Coffee',
      kind: 'expense',
      expectedAmountMinor: '50000',
      dueOn: '2026-10-15',
      categoryCode: 'food',
      expenseClass: 'daily',
      ...context,
    })).toThrow();
  });

  it('rejects recurrence input rather than inventing unresolved semantics', () => {
    expect(() => createOneOffScheduleBodySchema.parse({
      title: 'Rent',
      kind: 'expense',
      expectedAmountMinor: '12000000',
      dueOn: '2026-10-15',
      categoryCode: 'housing',
      expenseClass: 'essential_fixed',
      frequency: 'monthly',
      ...context,
    })).toThrow();
  });

  it.each(['paid', 'received', 'due_today', 'overdue'])('rejects %s as a persisted state', (state) => {
    expect(() => occurrenceStateSchema.parse(state)).toThrow();
  });

  it('keeps confirmed as state and Paid as derived presentation', () => {
    const parsed = occurrenceSchema.parse({
      id: '20000000-0000-4000-8000-000000000001',
      scheduledItemId: '20000000-0000-4000-8000-000000000002',
      title: 'Rent',
      kind: 'expense',
      direction: 'outgoing',
      expectedAmountMinor: '12000000',
      currency: 'VND',
      dueOn: '2026-10-15',
      categoryCode: 'housing',
      expenseClass: 'essential_fixed',
      state: 'confirmed',
      presentation: 'paid',
      confirmedTransactionId: '20000000-0000-4000-8000-000000000003',
      confirmedAt: '2026-10-15T02:00:00.000Z',
      skippedAt: null,
      skipReason: null,
      cancelledAt: null,
      version: '2',
    });
    expect(parsed.state).toBe('confirmed');
    expect(parsed.presentation).toBe('paid');
  });

  it('requires bounded occurrence pages and exposes continuation cursors', () => {
    expect(occurrenceListQuerySchema.parse({ limit: '2', cursor: 'opaque-next' }))
      .toMatchObject({ limit: 2, cursor: 'opaque-next' });
    expect(occurrenceListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(occurrenceListResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(occurrenceListResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });

});
