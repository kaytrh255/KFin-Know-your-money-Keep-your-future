/**
 * The "local email outbox" panel.
 *
 * This is **not** an API surface and not something that exists in a deployed
 * KFin: it is the local development server reading a directory that the
 * `EMAIL_DELIVERY_ADAPTER=file` sink writes to (see `apps/api/src/email-delivery.ts`
 * and the `Local email sink` section of `docs/development/LOCAL-DEVELOPMENT.md`).
 * The API itself still exposes no route that reveals a one-time code.
 *
 * The panel exists because a reset secret otherwise lives only in a request
 * process: with `EMAIL_DELIVERY_ADAPTER=none` (the default) the API reports
 * delivery failure and a local reset cannot be completed. Rather than fake a
 * delivered message in the client, the developer reads the real code the API
 * generated. Since OQ-20 (2026-10-12) the emailed code exists only for password
 * reset, so this panel is the local stand-in for exactly one message type.
 */

import { el } from './dom.js';
import { parseOutbox, type OutboxMessage } from './outbox-format.js';

export interface OutboxPanelOptions {
  /** Fills the six-digit reset-code field; other secrets are copied instead. */
  readonly onUseCode: (code: string) => void;
}

export function mountOutboxPanel(options: OutboxPanelOptions): void {
  const panel = document.getElementById('outbox');
  if (!panel) return;

  const body = el('div', { class: 'outbox-body' });
  const refresh = el('button', {
    class: 'button secondary', type: 'button', text: 'Refresh',
    on: { click: () => { void load(); } },
  });

  async function load(): Promise<void> {
    body.replaceChildren(el('p', { class: 'hint', text: 'Reading the local outbox…' }));
    try {
      const response = await fetch('/__dev__/outbox', { headers: { accept: 'application/json' } });
      const payload: unknown = await response.json();
      const messages = parseOutbox(payload);
      if (messages.length === 0) {
        body.replaceChildren(el('p', { class: 'hint', text: 'The outbox directory is empty. Start the API with EMAIL_DELIVERY_ADAPTER=file, then request a password reset.' }));
        return;
      }
      body.replaceChildren(...messages.slice(0, 10).map((message) => messageCard(message)));
    } catch {
      body.replaceChildren(el('p', { class: 'hint', text: 'The dev server did not answer /__dev__/outbox, so the local email sink is not configured for this run.' }));
    }
  }

  function messageCard(message: OutboxMessage): HTMLElement {
    return el('article', { class: 'outbox-message' },
      el('p', { class: 'hint', text: `${message.template ?? 'message'} → ${message.to ?? 'unknown recipient'} · ${message.recordedAt ?? ''}` }),
      message.oneTimeSecret
        ? el('p', { class: 'outbox-secret' },
          el('code', { text: message.oneTimeSecret }),
          el('button', {
            class: 'button secondary', type: 'button', text: 'Use code',
            on: { click: () => { options.onUseCode(message.oneTimeSecret as string); } },
          }),
          el('button', {
            class: 'button secondary', type: 'button', text: 'Copy',
            on: { click: () => { void navigator.clipboard?.writeText(message.oneTimeSecret as string); } },
          }),
        )
        : el('p', { class: 'hint', text: 'No secret in this message.' }),
    );
  }

  panel.replaceChildren(
    el('header', { class: 'outbox-header' },
      el('strong', { text: 'Local email outbox' }),
      el('span', { class: 'hint', text: 'development sink only' }),
      refresh,
    ),
    body,
  );
  panel.hidden = false;
  void load();
}
