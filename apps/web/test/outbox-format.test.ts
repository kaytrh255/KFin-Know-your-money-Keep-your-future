import { describe, expect, it } from 'vitest';
import { parseOutbox } from '../src/outbox-format.js';

/**
 * The panel reads a directory, so any single bad file must degrade locally:
 * a message without a secret is shown as such instead of being rendered as an
 * empty code the tester would paste into the verify form.
 */

describe('local outbox payload reader', () => {
  it('reads the fields the file sink writes', () => {
    const messages = parseOutbox({
      directoryConfigured: true,
      items: [{
        name: '1.json',
        template: 'password_reset',
        to: 'beta.user@example.invalid',
        oneTimeSecret: '123456',
        recordedAt: '2026-10-12T00:00:00.000Z',
      }],
    });
    expect(messages).toEqual([{
      name: '1.json',
      template: 'password_reset',
      to: 'beta.user@example.invalid',
      oneTimeSecret: '123456',
      recordedAt: '2026-10-12T00:00:00.000Z',
    }]);
  });

  it('keeps a message that has no secret instead of dropping it silently', () => {
    const [message] = parseOutbox({ items: [{ name: '2.json', template: 'security_notice' }] });
    expect(message?.oneTimeSecret).toBeNull();
    expect(message?.template).toBe('security_notice');
  });

  it('treats an empty secret string as absent', () => {
    const [message] = parseOutbox({ items: [{ name: '3.json', oneTimeSecret: '' }] });
    expect(message?.oneTimeSecret).toBeNull();
  });

  it('ignores junk entries and non-object payloads', () => {
    expect(parseOutbox(null)).toEqual([]);
    expect(parseOutbox({ items: 'nope' })).toEqual([]);
    expect(parseOutbox({ items: [null, 42, { name: 'ok.json' }] })).toHaveLength(1);
  });
});
