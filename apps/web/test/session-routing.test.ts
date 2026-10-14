import { describe, expect, it } from 'vitest';

import {
  routeNeedsSession,
  sessionGate,
  signInOutcome,
  type NavEntry,
} from '../src/session-routing.js';

/** The shape of `NAV` in main.ts: money screens need a session, auth screens do not. */
const nav: NavEntry[] = [
  { route: '#/money', needsSession: true },
  { route: '#/activity', needsSession: true },
  { route: '#/session', needsSession: true },
  { route: '#/self-check', needsSession: false },
  { route: '#/sign-in', needsSession: false },
  { route: '#/register', needsSession: false },
];

const liveSession = { userId: 'b7d8a7f6-f85d-4104-ac34-6a569357ae7e', email: 'repro@example.invalid' };

describe('session routing', () => {
  it('keeps a money screen on screen while a confirmed session exists (reload case)', () => {
    // Reloading the page with a cookie the API still accepts must not bounce.
    expect(sessionGate('/money', liveSession, nav)).toEqual({ redirectTo: null, notice: null });
    expect(sessionGate('/activity', liveSession, nav)).toEqual({ redirectTo: null, notice: null });
  });

  it('moves a money screen to sign-in when no session was confirmed', () => {
    // Covers both "no cookie at all" and "cookie the API refused": the client
    // cannot read the HttpOnly cookie, so it must treat them identically.
    const gate = sessionGate('/money', null, nav);
    expect(gate.redirectTo).toBe('#/sign-in');
    expect(gate.notice).toContain('Sign in first');
  });

  it('moves a money screen to sign-in after logout, because logout clears the session', () => {
    expect(sessionGate('/session', null, nav).redirectTo).toBe('#/sign-in');
  });

  it('never gats an auth screen, signed in or not', () => {
    for (const route of ['/sign-in', '/register', '/self-check']) {
      expect(sessionGate(route, null, nav)).toEqual({ redirectTo: null, notice: null });
      expect(sessionGate(route, liveSession, nav)).toEqual({ redirectTo: null, notice: null });
    }
  });

  it('knows which routes need a session', () => {
    expect(routeNeedsSession('/money', nav)).toBe(true);
    expect(routeNeedsSession('/session', nav)).toBe(true);
    expect(routeNeedsSession('/sign-in', nav)).toBe(false);
  });
});

describe('sign-in outcome', () => {
  it('claims success and leaves the sign-in screen only after /auth/me confirms the session', () => {
    const outcome = signInOutcome({ sessionConfirmed: true });
    expect(outcome.status).toBe('signed-in');
    expect(outcome.navigateTo).toBe('#/money');
  });

  it('never claims success when the browser did not keep the session cookie', () => {
    const outcome = signInOutcome({ sessionConfirmed: false });
    expect(outcome.status).toBe('session-not-kept');
    expect(outcome.navigateTo).toBeNull();
    expect(outcome.headline).toContain('did not keep the session cookie');
    expect(outcome.headline).not.toContain('Signed in.');
    // The reason has to be actionable, not just descriptive.
    expect(outcome.detail).toContain('SameSite=Lax');
    expect(outcome.detail).toContain('own tab');
  });
});
