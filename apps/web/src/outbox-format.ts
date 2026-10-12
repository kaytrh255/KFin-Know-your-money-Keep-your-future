/**
 * Parsing for the local development outbox payload.
 *
 * Kept separate from the panel so the reader can be unit-tested without a DOM:
 * one unreadable entry must not hide the messages around it, and a missing
 * secret must be reported as missing rather than rendered as a blank code.
 */

export interface OutboxMessage {
  readonly name: string;
  readonly template: string | null;
  readonly to: string | null;
  readonly oneTimeSecret: string | null;
  readonly recordedAt: string | null;
}

export interface OutboxPayload {
  readonly directoryConfigured: boolean;
  readonly items: readonly OutboxMessage[];
}

export function parseOutbox(payload: unknown): OutboxMessage[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const secret = typeof record.oneTimeSecret === 'string' && record.oneTimeSecret.length > 0 ? record.oneTimeSecret : null;
    return [{
      name: typeof record.name === 'string' ? record.name : 'message',
      template: typeof record.template === 'string' ? record.template : null,
      to: typeof record.to === 'string' ? record.to : null,
      oneTimeSecret: secret,
      recordedAt: typeof record.recordedAt === 'string' ? record.recordedAt : null,
    }];
  });
}
