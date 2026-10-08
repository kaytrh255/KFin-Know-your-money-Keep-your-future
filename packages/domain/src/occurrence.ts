import { assertLocalDate } from './dates.js';

export const OCCURRENCE_STATES = ['scheduled', 'confirmed', 'skipped', 'cancelled'] as const;
export type OccurrenceState = (typeof OCCURRENCE_STATES)[number];
export type OccurrenceDirection = 'incoming' | 'outgoing';
export type OccurrencePresentation =
  | 'upcoming'
  | 'due_today'
  | 'overdue'
  | 'projected'
  | 'paid'
  | 'received'
  | 'skipped'
  | 'cancelled';

/**
 * Derive display state without mutating financial authority.
 * FIN-OCC-02..04: Paid/Received and due boundaries are presentation only.
 */
export function deriveOccurrencePresentation(input: {
  state: OccurrenceState;
  direction: OccurrenceDirection;
  dueOn: string;
  localDate: string;
}): OccurrencePresentation {
  const dueOn = assertLocalDate(input.dueOn);
  const localDate = assertLocalDate(input.localDate);

  if (input.state === 'confirmed') {
    return input.direction === 'outgoing' ? 'paid' : 'received';
  }
  if (input.state === 'skipped') return 'skipped';
  if (input.state === 'cancelled') return 'cancelled';
  if (input.direction === 'incoming') return 'projected';
  if (dueOn < localDate) return 'overdue';
  if (dueOn === localDate) return 'due_today';
  return 'upcoming';
}
