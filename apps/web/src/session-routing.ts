/**
 * Session routing decisions, kept free of the DOM so the rules that decide
 * "which screen may a session see" and "did the sign-in actually take" are
 * unit-testable in this repository's node test environment.
 *
 * Why this exists (2026-10-13): the sign-in screen printed a green "Signed in."
 * and then the hash was rewritten to `#/sign-in`, because the session cookie had
 * not been kept and `GET /api/v1/auth/me` answered 401. The API was right and the
 * routing was right; the *claim* was wrong. The copy below states what was
 * observed instead of what was hoped for.
 */

export interface NavEntry {
  readonly route: string;
  readonly needsSession: boolean;
}

export interface SessionGate {
  /** Non-null when the screen may not be shown and the hash must move. */
  readonly redirectTo: string | null;
  /** Shown in place of the screen when a redirect happens. */
  readonly notice: string | null;
}

export interface SignInOutcome {
  readonly status: 'signed-in' | 'session-not-kept';
  readonly headline: string;
  readonly detail: string | null;
  /** Null means: stay where you are and show the headline. */
  readonly navigateTo: string | null;
}

export const SIGN_IN_ROUTE = '#/sign-in';
export const SESSION_ROUTE = '#/session';

const SIGNED_OUT_NOTICE =
  'Sign in first: these screens read real API data and there is no placeholder mode.';

export function routeNeedsSession(path: string, nav: readonly NavEntry[]): boolean {
  return nav.some((entry) => entry.route === `#${path}` && entry.needsSession);
}

/**
 * A screen that needs a session is not rendered without one; an absent session is
 * relocated to sign-in exactly like an expired or invalidated one — the client
 * never distinguishes "no cookie" from "cookie the API refused", because it cannot
 * read the HttpOnly cookie and must not guess.
 */
export function sessionGate(
  path: string,
  session: unknown | null,
  nav: readonly NavEntry[],
): SessionGate {
  const needsSession = routeNeedsSession(path, nav);
  if (needsSession && session === null) {
    return { redirectTo: SIGN_IN_ROUTE, notice: SIGNED_OUT_NOTICE };
  }
  return { redirectTo: null, notice: null };
}

/**
 * What the sign-in screen may claim once `POST /api/v1/auth/login` answered 200.
 *
 * A 200 there is not a signed-in state: the session lives in an opaque HttpOnly
 * cookie, so the only proof this browser kept it is a confirmed
 * `GET /api/v1/auth/me`. When that call fails, the screen says so — the defect
 * this function exists to prevent is a success message next to a signed-out
 * screen. (An API that *rejects* the credentials never reaches this function; the
 * sign-in screen reports the failure envelope itself.)
 */
export function signInOutcome(input: { readonly sessionConfirmed: boolean }): SignInOutcome {
  if (!input.sessionConfirmed) {
    return {
      status: 'session-not-kept',
      headline:
        'The API accepted the sign-in, but this browser did not keep the session cookie, so you are still signed out.',
      detail:
        'The session cookie is HttpOnly, Secure and SameSite=Lax, and a browser stores and sends a Lax cookie only when the page is same-site with the top-level document. An embedded cross-site preview frame is not, so no session can be held there. Open the client in its own tab and sign in again.',
      navigateTo: null,
    };
  }
  return {
    status: 'signed-in',
    headline: 'Signed in.',
    detail: null,
    navigateTo: '#/money',
  };
}
