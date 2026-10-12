/**
 * Local testing client bootstrap: hash router, session chip, and the panel wiring.
 *
 * Routes are the ones in `docs/ux/SCREEN-INVENTORY.md` that the implemented API
 * can actually answer today. A signed-out request to a money route redirects to
 * sign-in instead of rendering an empty shell, and a session is confirmed with
 * `GET /api/v1/auth/me` before any screen claims to be signed in.
 */

import { createApi, type Api } from './api.js';
import { el, notice, toast } from './dom.js';
import { mountOutboxPanel } from './outbox.js';
import { activityView } from './views/activity.js';
import {
  forgotPasswordView,
  registerView,
  resetPasswordView,
  sessionView,
  signInView,
  verifyEmailView,
  type AuthViewContext,
} from './views/auth.js';
import { moneyView } from './views/money.js';
import { savingsView } from './views/savings.js';
import { scheduleView } from './views/schedule.js';

interface SessionState {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly baseCurrency: string;
}

interface FinancialContext {
  readonly financialStateVersion: string;
  readonly snapshotId: string;
  readonly currency: string;
  readonly snapshotLocalDate: string;
}

const NAV: ReadonlyArray<{ readonly route: string; readonly label: string; readonly needsSession: boolean }> = [
  { route: '#/money', label: 'Money', needsSession: true },
  { route: '#/activity', label: 'Activity', needsSession: true },
  { route: '#/savings', label: 'Savings', needsSession: true },
  { route: '#/schedule', label: 'Schedule', needsSession: true },
  { route: '#/session', label: 'Session', needsSession: true },
  { route: '#/sign-in', label: 'Sign in', needsSession: false },
  { route: '#/register', label: 'Register', needsSession: false },
  { route: '#/forgot', label: 'Recover', needsSession: false },
];

/** Reads the CSRF cookie the API sets next to the HttpOnly session cookie. */
function cookieReader(): (name: string) => string | null {
  return (name: string) => {
    const parts = document.cookie.length === 0 ? [] : document.cookie.split(';');
    for (const part of parts) {
      const [key, ...rest] = part.trim().split('=');
      if (key === name) return decodeURIComponent(rest.join('='));
    }
    return null;
  };
}

const api: Api = createApi({
  fetch: (input, init) => fetch(input, init),
  cookie: cookieReader(),
});

let session: SessionState | null = null;

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const chip = document.getElementById('session-chip');
if (!app) throw new Error('The application shell is missing.');

const authContext: AuthViewContext = {
  api,
  navigate: (route) => { window.location.hash = route; },
  refreshSession: async () => { await loadSession(); renderNav(); render(); },
};

function currentRoute(): { readonly path: string; readonly query: URLSearchParams } {
  const raw = window.location.hash.replace(/^#/, '');
  const [path = '/money', query = ''] = raw.split('?');
  return { path, query: new URLSearchParams(query) };
}

async function loadSession(): Promise<void> {
  try {
    const response = await api.session.me();
    session = {
      userId: response.data.userId,
      email: response.data.email,
      displayName: response.data.displayName,
      baseCurrency: response.data.baseCurrency,
    };
  } catch {
    session = null;
  }
}

/** Financial writes need the version and snapshot the server currently holds. */
async function loadFinancialContext(): Promise<FinancialContext | null> {
  try {
    const response = await api.financial.account();
    return {
      financialStateVersion: response.data.financialStateVersion,
      snapshotId: response.data.snapshot.id,
      currency: response.data.currency,
      snapshotLocalDate: response.data.snapshot.effectiveLocalDate,
    };
  } catch {
    return null;
  }
}

function renderNav(): void {
  if (!nav) return;
  nav.replaceChildren(...NAV
    .filter((entry) => (entry.needsSession ? session !== null : true))
    .map((entry) => el('a', { class: 'nav-link', href: entry.route, text: entry.label })));
}

function renderChip(): void {
  if (!chip) return;
  chip.textContent = session ? `${session.email} · ${session.baseCurrency}` : 'not signed in';
  chip.className = session ? 'chip chip-on' : 'chip chip-off';
}

async function render(): Promise<void> {
  const { path, query } = currentRoute();
  if (!app) return;

  const needsSession = NAV.some((entry) => entry.route === `#${path}` && entry.needsSession);
  if (needsSession && session === null) {
    app.replaceChildren(notice('info', 'Sign in first: these screens read real API data and there is no placeholder mode.'));
    window.location.hash = '#/sign-in';
    return;
  }

  switch (path) {
    case '/sign-in':
      app.replaceChildren(signInView(authContext));
      return;
    case '/register':
      app.replaceChildren(registerView(authContext));
      return;
    case '/verify-email':
      app.replaceChildren(verifyEmailView(authContext, query.get('email') ?? ''));
      return;
    case '/forgot':
      app.replaceChildren(forgotPasswordView(authContext));
      return;
    case '/reset':
      app.replaceChildren(resetPasswordView(authContext, query.get('email') ?? ''));
      return;
    case '/session':
      if (session) app.replaceChildren(sessionView(authContext, session));
      return;
    case '/money':
      app.replaceChildren(moneyView({ api }));
      return;
    case '/activity': {
      const context = await loadFinancialContext();
      if (!context) { app.replaceChildren(moneyView({ api })); return; }
      app.replaceChildren(activityView(
        { api, currency: context.currency, snapshotLocalDate: context.snapshotLocalDate },
        {
          financialStateVersion: context.financialStateVersion,
          snapshotId: context.snapshotId,
          currency: context.currency,
        },
      ));
      return;
    }
    case '/savings': {
      const context = await loadFinancialContext();
      if (!context) { app.replaceChildren(moneyView({ api })); return; }
      app.replaceChildren(savingsView({ api, currency: context.currency }));
      return;
    }
    case '/schedule': {
      const context = await loadFinancialContext();
      if (!context) { app.replaceChildren(moneyView({ api })); return; }
      app.replaceChildren(scheduleView({
        api,
        currency: context.currency,
        financialStateVersion: context.financialStateVersion,
        snapshotId: context.snapshotId,
      }));
      return;
    }
    default:
      app.replaceChildren(notice('error', `No screen for ${path}. Use the navigation above.`));
  }
}

window.addEventListener('hashchange', () => { void render(); });

async function start(): Promise<void> {
  await loadSession();
  renderNav();
  renderChip();
  if (window.location.hash.length === 0) window.location.hash = session ? '#/money' : '#/sign-in';
  try {
    await api.health();
  } catch {
    toast('The API did not answer /health/ready. Is it running on the proxied origin?', 'error');
  }
  await render();
  mountOutboxPanel({
    onUseCode: (code) => {
      const input = document.querySelector<HTMLInputElement>('input[name="oneTimeCode"]');
      if (input) {
        input.value = code;
        input.focus();
        toast('Code filled from the local outbox');
      } else {
        window.location.hash = '#/verify-email';
        toast('Opened the verification screen; use the code from the panel.');
      }
    },
  });
}

void start();
