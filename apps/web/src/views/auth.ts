/**
 * AUTH-01…AUTH-05 from `docs/ux/SCREEN-INVENTORY.md`, implemented as far as the
 * API actually goes: sign in, accept-invite registration, email verification,
 * password recovery, and the session screen. Nothing here invents an email
 * allowlist, a password-strength meter, or a "resend" that lies about the
 * resend window — the window comes from the API's own `resendAvailableAt`.
 */

import type { Api, ApiFailure } from '../api.js';
import { card, el, field, notice, readInput, selectField, toast, wire } from '../dom.js';
import { instantNow } from '../money.js';

const LOCALES = ['vi-VN', 'en-US', 'en-GB', 'ja-JP'];
const TIMEZONES = ['Asia/Ho_Chi_Minh', 'Asia/Tokyo', 'Asia/Singapore', 'UTC'];
const CURRENCIES = ['VND', 'USD', 'EUR', 'JPY', 'SGD'];

export interface AuthViewContext {
  readonly api: Api;
  readonly navigate: (route: string) => void;
  readonly refreshSession: () => Promise<void>;
}

function failureNotice(error: unknown): HTMLElement {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const failure = error as ApiFailure;
    return notice('error', `${failure.status} ${failure.code}: ${failure.message}`, failure.correlationId, failure.fields);
  }
  return notice('error', error instanceof Error ? error.message : 'The request failed.');
}

export function signInView(context: AuthViewContext): HTMLElement {
  const form = el('form', { class: 'stack' },
    field({ label: 'Email', name: 'email', type: 'email', required: true, placeholder: 'beta.user@example.invalid' }),
    field({ label: 'Password', name: 'password', type: 'password', required: true }),
    el('div', { class: 'actions' },
      el('button', { class: 'button', type: 'submit', text: 'Sign in' }),
      el('button', { class: 'button secondary', type: 'button', text: 'Register', on: { click: () => context.navigate('#/register') } }),
      el('button', { class: 'button secondary', type: 'button', text: 'Forgot password', on: { click: () => context.navigate('#/forgot') } }),
    ),
  );
  const result = el('div', { class: 'result' });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const email = readInput(form, 'email');
    const password = readInput(form, 'password');
    result.replaceChildren(el('p', { class: 'hint', text: 'Signing in…' }));
    void context.api.auth.login({ email, password })
      .then(async (response) => {
        result.replaceChildren(notice('ok', 'Signed in.'), wire('response', response.data));
        await context.refreshSession();
        toast('Signed in');
        context.navigate('#/money');
      })
      .catch((error: unknown) => { result.replaceChildren(failureNotice(error)); });
  });

  return el('div', { class: 'stack' }, card('Sign in (AUTH-01)', form, result));
}

export function registerView(context: AuthViewContext): HTMLElement {
  const form = el('form', { class: 'stack' },
    field({
      label: 'Invitation code',
      name: 'invitationCode',
      required: true,
      // The rule below is the contract's own: `invitationCodeSchema` enforces four
      // groups of eight Crockford characters. It used to be stated nowhere the
      // user could see, so a mistyped code answered only "does not match the API
      // contract" with no field named (2026-10-12).
      hint: 'Four groups of eight characters, for example XXXX-XXXX-XXXX-XXXX — digits and A–Z without I, L, O and U. Case and surrounding spaces are accepted. Minted by an operator: `corepack pnpm run invite:provision`; there is no HTTP route for this by design (SEC-AUTH-14).',
    }),
    field({ label: 'Email', name: 'email', type: 'email', required: true }),
    field({
      label: 'Password',
      name: 'password',
      type: 'password',
      required: true,
      // The contract bounds the transport (1–200); the service enforces its own
      // policy on top (`AUTH_PASSWORD_POLICY_FAILED`). Stating only the transport
      // bound sent users into a refusal they could not have predicted.
      hint: 'At least 12 characters, at most 128. The API also refuses a password that is too common or too similar to the email address.',
    }),
    field({ label: 'Display name (optional)', name: 'displayName' }),
    selectField('Locale', LOCALES, { value: 'vi-VN', name: 'locale' }),
    selectField('Timezone', TIMEZONES, { value: 'Asia/Ho_Chi_Minh', name: 'timezone' }),
    selectField('Base currency (locks after financial data exists)', CURRENCIES, { value: 'VND', name: 'baseCurrency' }),
    el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: 'Accept invite and register' })),
  );
  const result = el('div', { class: 'result' });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const displayName = readInput(form, 'displayName');
    const body = {
      email: readInput(form, 'email'),
      password: readInput(form, 'password'),
      invitationCode: readInput(form, 'invitationCode'),
      ...(displayName.length === 0 ? {} : { displayName }),
      locale: readInput(form, 'locale'),
      timezone: readInput(form, 'timezone'),
      baseCurrency: readInput(form, 'baseCurrency'),
    };
    result.replaceChildren(wire('request', body), el('p', { class: 'hint', text: 'Submitting…' }));
    void context.api.auth.register(body)
      .then((response) => {
        result.replaceChildren(wire('response', response.data));
        toast('Registration accepted');
        context.navigate(`#/verify-email?email=${encodeURIComponent(body.email)}`);
      })
      .catch((error: unknown) => { result.replaceChildren(wire('request', body), failureNotice(error)); });
  });

  return el('div', { class: 'stack' }, card('Accept invite and register (AUTH-02)', form, result));
}

export function verifyEmailView(context: AuthViewContext, email: string): HTMLElement {
  const form = el('form', { class: 'stack' },
    field({ label: 'Email', name: 'email', type: 'email', required: true, value: email }),
    field({ label: 'Six-digit code from the email', name: 'oneTimeCode', required: true, placeholder: '000000', min: '000000', max: '999999' }),
    el('div', { class: 'actions' },
      el('button', { class: 'button', type: 'submit', text: 'Verify email' }),
      el('button', { class: 'button secondary', type: 'button', text: 'Resend code', on: { click: () => { void resend(); } } }),
    ),
  );
  const result = el('div', { class: 'result' });

  async function resend(): Promise<void> {
    const target = readInput(form, 'email');
    result.replaceChildren(el('p', { class: 'hint', text: 'Requesting a new code…' }));
    try {
      const response = await context.api.auth.resendVerification({ email: target });
      result.replaceChildren(
        notice('ok', 'The API accepted the resend request.'),
        el('p', { class: 'hint', text: `Next resend allowed at ${response.data.resendAvailableAt}` }),
        wire('response', response.data),
      );
    } catch (error) {
      result.replaceChildren(failureNotice(error));
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = { email: readInput(form, 'email'), oneTimeCode: readInput(form, 'oneTimeCode') };
    result.replaceChildren(wire('request', body));
    void context.api.auth.verifyEmail(body)
      .then(async (response) => {
        result.replaceChildren(notice('ok', 'Email verified; a session was issued.'), wire('response', response.data));
        await context.refreshSession();
        toast('Email verified');
        context.navigate('#/money');
      })
      .catch((error: unknown) => {
        const code = (error as ApiFailure)?.code ?? '';
        const extra = code.startsWith('AUTH_') && code.includes('CHALLENGE')
          ? [el('p', { class: 'hint', text: 'Attempt counts and expiry are enforced server-side; the exact rule is in the API response above, not in this client.' })]
          : [];
        result.replaceChildren(wire('request', body), failureNotice(error), ...extra);
      });
  });

  return el('div', { class: 'stack' },
    card('Verify email (AUTH-03)', form, result),
    el('p', { class: 'hint' },
      'No code yet? With EMAIL_DELIVERY_ADAPTER=file the adapter writes the message to the local outbox — open the ',
      el('em', { text: 'Local email outbox' }),
      ' panel in the corner of this page. That panel is the dev server reading a directory on your machine; the API itself has no route that exposes a one-time code.',
    ),
  );
}

export function forgotPasswordView(context: AuthViewContext): HTMLElement {
  const form = el('form', { class: 'stack' },
    field({ label: 'Email', name: 'email', type: 'email', required: true }),
    el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: 'Request recovery' })),
  );
  const result = el('div', { class: 'result' });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const email = readInput(form, 'email');
    result.replaceChildren(el('p', { class: 'hint', text: 'Requesting…' }));
    void context.api.auth.resetRequest({ email })
      .then((response) => {
        result.replaceChildren(
          el('p', { class: 'hint', text: 'The API answers identically for known and unknown addresses (enumeration resistance), so this message says nothing about whether the account exists.' }),
          wire('response', response.data),
          el('div', { class: 'actions' },
            el('button', {
              class: 'button',
              type: 'button',
              text: 'I have a recovery secret',
              on: { click: () => context.navigate(`#/reset?email=${encodeURIComponent(email)}`) },
            }),
          ),
        );
      })
      .catch((error: unknown) => { result.replaceChildren(failureNotice(error)); });
  });

  return el('div', { class: 'stack' }, card('Forgot password (AUTH-04)', form, result));
}

export function resetPasswordView(context: AuthViewContext, email: string): HTMLElement {
  const form = el('form', { class: 'stack' },
    field({ label: 'Email', name: 'email', type: 'email', required: true, value: email }),
    field({ label: 'Recovery secret', name: 'resetSecret', required: true, hint: 'From the outbox message; the API never returns it in a response body.' }),
    field({ label: 'New password', name: 'newPassword', type: 'password', required: true }),
    el('div', { class: 'actions' },
      el('button', { class: 'button', type: 'submit', text: 'Set new password' }),
      el('button', { class: 'button secondary', type: 'button', text: 'Back to sign in', on: { click: () => context.navigate('#/sign-in') } }),
    ),
  );
  const result = el('div', { class: 'result' });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = {
      email: readInput(form, 'email'),
      resetSecret: readInput(form, 'resetSecret'),
      newPassword: readInput(form, 'newPassword'),
    };
    result.replaceChildren(el('p', { class: 'hint', text: 'Submitting…' }));
    void context.api.auth.reset(body)
      .then((response) => {
        result.replaceChildren(
          notice('ok', `Password set. Sessions revoked: ${response.data.sessionsRevoked}.`),
          wire('response', response.data),
        );
        toast('Password reset');
      })
      .catch((error: unknown) => { result.replaceChildren(failureNotice(error)); });
  });

  return el('div', { class: 'stack' }, card('Reset password (AUTH-05)', form, result));
}

export function sessionView(
  context: AuthViewContext,
  state: { readonly userId: string; readonly email: string; readonly displayName: string | null; readonly baseCurrency: string },
): HTMLElement {
  const output = el('div', { class: 'result' });
  const changeForm = el('form', { class: 'stack' },
    field({ label: 'Current password', name: 'currentPassword', type: 'password', required: true }),
    field({ label: 'New password', name: 'newPassword', type: 'password', required: true }),
    el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: 'Change password' })),
  );
  changeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = { currentPassword: readInput(changeForm, 'currentPassword'), newPassword: readInput(changeForm, 'newPassword') };
    output.replaceChildren(el('p', { class: 'hint', text: 'Submitting…' }));
    void context.api.auth.changePassword(body)
      .then(async (response) => {
        output.replaceChildren(notice('ok', `Other sessions revoked: ${response.data.revokedOtherSessions}.`), wire('response', response.data));
        await context.refreshSession();
      })
      .catch((error: unknown) => { output.replaceChildren(failureNotice(error)); });
  });

  const actions = el('div', { class: 'actions' },
    el('button', {
      class: 'button secondary', type: 'button', text: 'Load sessions',
      on: { click: () => { void context.api.session.sessions().then((r) => output.replaceChildren(wire('sessions', r.data))).catch((e: unknown) => output.replaceChildren(failureNotice(e))); } },
    }),
    el('button', {
      class: 'button secondary', type: 'button', text: 'Load security events',
      on: { click: () => { void context.api.session.securityEvents().then((r) => output.replaceChildren(wire('security events', r.data))).catch((e: unknown) => output.replaceChildren(failureNotice(e))); } },
    }),
    el('button', {
      class: 'button secondary', type: 'button', text: 'Log out this session',
      on: {
        click: () => {
          void context.api.session.logout().then(async (r) => {
            output.replaceChildren(wire('response', r.data));
            await context.refreshSession();
            toast('Logged out');
            context.navigate('#/sign-in');
          }).catch((e: unknown) => output.replaceChildren(failureNotice(e)));
        },
      },
    }),
    el('button', {
      class: 'button secondary', type: 'button', text: 'Log out everywhere',
      on: {
        click: () => {
          void context.api.session.logoutAll().then(async (r) => {
            output.replaceChildren(wire('response', r.data));
            await context.refreshSession();
            toast('All sessions revoked');
            context.navigate('#/sign-in');
          }).catch((e: unknown) => output.replaceChildren(failureNotice(e)));
        },
      },
    }),
  );

  return el('div', { class: 'stack' },
    card('Session',
      el('dl', { class: 'facts' },
        el('dt', { text: 'User id' }), el('dd', { text: state.userId }),
        el('dt', { text: 'Email' }), el('dd', { text: state.email }),
        el('dt', { text: 'Display name' }), el('dd', { text: state.displayName ?? '—' }),
        el('dt', { text: 'Base currency' }), el('dd', { text: state.baseCurrency }),
        el('dt', { text: 'Checked at' }), el('dd', { text: instantNow() }),
      ),
      actions, output),
    card('Change password', changeForm),
  );
}
