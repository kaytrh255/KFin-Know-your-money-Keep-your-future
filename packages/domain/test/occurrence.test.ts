import { describe, expect, it } from 'vitest';
import { deriveOccurrencePresentation } from '../src/index.js';

describe('scheduled occurrence presentation', () => {
  it.each([
    ['2026-10-09', 'upcoming'],
    ['2026-10-08', 'due_today'],
    ['2026-10-07', 'overdue'],
  ] as const)('derives outgoing scheduled %s as %s without a stored alias', (dueOn, expected) => {
    expect(deriveOccurrencePresentation({
      state: 'scheduled',
      direction: 'outgoing',
      dueOn,
      localDate: '2026-10-08',
    })).toBe(expected);
  });

  it('maps confirmed direction to Paid/Received presentation keys', () => {
    expect(deriveOccurrencePresentation({
      state: 'confirmed', direction: 'outgoing', dueOn: '2026-10-08', localDate: '2026-10-08',
    })).toBe('paid');
    expect(deriveOccurrencePresentation({
      state: 'confirmed', direction: 'incoming', dueOn: '2026-10-08', localDate: '2026-10-08',
    })).toBe('received');
  });

  it('keeps scheduled income projected across date passage', () => {
    expect(deriveOccurrencePresentation({
      state: 'scheduled', direction: 'incoming', dueOn: '2026-01-01', localDate: '2026-10-08',
    })).toBe('projected');
  });

  it.each(['skipped', 'cancelled'] as const)('presents terminal %s directly', (state) => {
    expect(deriveOccurrencePresentation({
      state, direction: 'outgoing', dueOn: '2026-01-01', localDate: '2026-10-08',
    })).toBe(state);
  });
});
