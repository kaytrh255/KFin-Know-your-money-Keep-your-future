/**
 * Preview self-check.
 *
 * Reasons this screen exists: the client cannot be opened through a terminal here,
 * and the exact behaviour of a preview proxy (does it keep the browser's `Host`
 * header, or rewrite it?) decides whether the API's same-origin defense accepts
 * writes. Rather than assume, this screen reports what the dev server actually
 * received and whether a real state-changing request reached the API.
 *
 * Every value is measured live. Nothing is inferred and nothing is hidden when it
 * fails: a broken origin chain is shown as such, with the numbers that broke it.
 */

import { el, notice, wire } from '../dom.js';

interface RequestContext {
  readonly host: string | null;
  readonly origin: string | null;
  readonly originHost: string | null;
  readonly forwardedHost: string | null;
  readonly forwardedProto: string | null;
  readonly secFetchSite: string | null;
  readonly sameOriginByBrowser: boolean;
  readonly originMatchesHost: boolean;
  readonly forwardingHost: string | null;
  readonly writeWouldBeForwarded: boolean;
  readonly apiOrigin: string;
}

/** A fixed address that is never registered, so a probe can never touch a real account. */
const PROBE_EMAIL = 'preview.self-check@example.invalid';

export function selfCheckView(): HTMLElement {
  const contextOutput = el('div', { class: 'result' });
  const healthOutput = el('div', { class: 'result' });
  const writeOutput = el('div', { class: 'result' });
  const host = el('div', { class: 'stack' });

  async function loadContext(): Promise<void> {
    contextOutput.replaceChildren(el('p', { class: 'hint', text: 'Reading /__dev__/request-context…' }));
    try {
      const response = await fetch('/__dev__/request-context', { headers: { accept: 'application/json' } });
      if (!response.ok) {
        contextOutput.replaceChildren(notice('error', `The dev server answered ${response.status} for /__dev__/request-context.`));
        return;
      }
      const context = (await response.json()) as RequestContext;
      const pairConsistent = context.originMatchesHost || context.sameOriginByBrowser;
      contextOutput.replaceChildren(
        pairConsistent
          ? notice('ok', 'The origin this page is served from is consistent, so the API will accept writes from this browser.')
          : notice('error', 'This page\'s origin and the host the server received disagree, and the browser did not attest same-origin. Writes will be refused.'),
        el('dl', { class: 'facts' },
          el('dt', { text: 'Host received' }), el('dd', { text: context.host ?? '—' }),
          el('dt', { text: 'Origin sent by browser' }), el('dd', { text: context.origin ?? '—' }),
          el('dt', { text: 'X-Forwarded-Host' }), el('dd', { text: context.forwardedHost ?? '(absent)' }),
          el('dt', { text: 'X-Forwarded-Proto' }), el('dd', { text: context.forwardedProto ?? '(absent)' }),
          el('dt', { text: 'Sec-Fetch-Site' }), el('dd', { text: context.secFetchSite ?? '(absent)' }),
          el('dt', { text: 'Host handed to the API' }), el('dd', { text: context.forwardingHost ?? '—' }),
          el('dt', { text: 'API target' }), el('dd', { text: context.apiOrigin }),
        ),
        wire('raw request context', context),
      );
    } catch (error) {
      contextOutput.replaceChildren(notice('error', `Could not reach the dev server: ${error instanceof Error ? error.message : 'unknown error'}`));
    }
  }

  async function loadHealth(): Promise<void> {
    healthOutput.replaceChildren(el('p', { class: 'hint', text: 'Calling the API through this same origin…' }));
    try {
      const response = await fetch('/health/ready', { headers: { accept: 'application/json' } });
      const body = await response.text();
      healthOutput.replaceChildren(
        response.ok
          ? notice('ok', 'The API answered through this origin, including its database readiness.')
          : notice('error', `The API answered ${response.status}.`),
        wire('GET /health/ready', body),
      );
    } catch (error) {
      healthOutput.replaceChildren(notice('error', `The API is not reachable through this origin: ${error instanceof Error ? error.message : 'unknown error'}`));
    }
  }

  async function probeWrite(): Promise<void> {
    writeOutput.replaceChildren(el('p', { class: 'hint', text: 'Sending one real state-changing request…' }));
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: PROBE_EMAIL, password: 'deliberately-not-a-password' }),
      });
      const body = await response.text();
      let code: string | null = null;
      try {
        code = (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? null;
      } catch {
        code = null;
      }
      const refusedByOrigin = code === 'AUTH_CSRF_FAILED' || code === 'LOCAL_PROXY_ORIGIN_REJECTED';
      writeOutput.replaceChildren(
        refusedByOrigin
          ? notice('error', `The write path is broken: ${code}. The API never evaluated the credentials, so the origin/host chain is the problem, not the account.`)
          : notice('ok', `The write reached the API and was evaluated (HTTP ${response.status}${code ? `, ${code}` : ''}). A credential error here is the expected answer for a deliberately unknown account.`),
        el('p', { class: 'hint', text: `The probe uses ${PROBE_EMAIL}, which is never registered, so any rate limit lands on that address and not on a real account.` }),
        wire('POST /api/v1/auth/login', body),
      );
    } catch (error) {
      writeOutput.replaceChildren(notice('error', `The request never completed: ${error instanceof Error ? error.message : 'unknown error'}`));
    }
  }

  const runAll = el('button', {
    class: 'button',
    type: 'button',
    text: 'Run all checks',
    on: { click: () => { void loadContext(); void loadHealth(); void probeWrite(); } },
  });

  host.append(
    el('p', { class: 'hint', text: 'Use this before reporting that the preview is broken: it separates "the API is not answering" from "the preview proxy broke the origin".' }),
    el('div', { class: 'actions' }, runAll,
      el('button', { class: 'button secondary', type: 'button', text: 'Re-read request context', on: { click: () => { void loadContext(); } } })),
    el('section', { class: 'card' }, el('h2', { class: 'card-title', text: 'Preview origin' }), contextOutput),
    el('section', { class: 'card' }, el('h2', { class: 'card-title', text: 'API reachability' }), healthOutput),
    el('section', { class: 'card' }, el('h2', { class: 'card-title', text: 'Write path' }), writeOutput),
  );

  void loadContext();
  void loadHealth();

  return host;
}
