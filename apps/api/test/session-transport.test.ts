import { describe, expect, it } from 'vitest';
import {
  CSRF_COOKIE_NAME,
  clearedCsrfCookie,
  clearedSessionCookie,
  isBrowserSafeRequest,
  readCookie,
  serializeCsrfCookie,
  serializeSessionCookie,
  sessionCookieName,
} from '../src/session-transport.js';

const SECURE = { secure: true, prefixHost: true, allowedOrigins: [] as readonly string[] };

describe('session cookie transport', () => {
  it('uses the host prefix only for secure deployments', () => {
    expect(sessionCookieName({ secure: true, prefixHost: true })).toBe('__Host-kfin_session');
    expect(sessionCookieName({ secure: false, prefixHost: true })).toBe('kfin_session');
    expect(sessionCookieName({ secure: true, prefixHost: false })).toBe('kfin_session');
  });

  it('sends the bearer token only in an HttpOnly Secure host cookie', () => {
    const cookie = serializeSessionCookie('token-value', SECURE, 7_776_000);
    expect(cookie).toContain('__Host-kfin_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=7776000');
    expect(cookie).not.toMatch(/Domain=/);
  });

  it('keeps the CSRF cookie readable by the client but Secure and same-site strict', () => {
    const cookie = serializeCsrfCookie('csrf-value', SECURE, 7_776_000);
    expect(cookie.startsWith(`${CSRF_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).not.toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('clears both cookies with an immediate expiry', () => {
    expect(clearedSessionCookie(SECURE)).toContain('Max-Age=0');
    expect(clearedCsrfCookie(SECURE)).toContain('Max-Age=0');
    expect(clearedSessionCookie({ ...SECURE, secure: false })).toContain('kfin_session=;');
  });

  it('reads one cookie by name from a combined header', () => {
    const header = 'kfin_csrf=abc123; __Host-kfin_session=token%2Bvalue; other=1';
    expect(readCookie(header, '__Host-kfin_session')).toBe('token+value');
    expect(readCookie(header, 'kfin_csrf')).toBe('abc123');
    expect(readCookie(header, 'missing')).toBeNull();
    expect(readCookie(undefined, 'kfin_csrf')).toBeNull();
  });
});

describe('browser origin and fetch-metadata enforcement', () => {
  it('never challenges safe methods', () => {
    expect(isBrowserSafeRequest({ method: 'GET', headers: {} }, [])).toBe(true);
    expect(isBrowserSafeRequest({ method: 'HEAD', headers: {} }, [])).toBe(true);
  });

  it('accepts a same-origin request and an allowlisted origin', () => {
    expect(isBrowserSafeRequest({
      method: 'POST',
      headers: { origin: 'https://api.kfin.test', host: 'api.kfin.test' },
    }, [])).toBe(true);
    expect(isBrowserSafeRequest({
      method: 'POST',
      headers: { origin: 'https://beta.kfin.example', host: 'api.kfin.test' },
    }, ['https://beta.kfin.example'])).toBe(true);
  });

  it('rejects a foreign origin even when a host matches', () => {
    expect(isBrowserSafeRequest({
      method: 'POST',
      headers: { origin: 'https://evil.example', host: 'api.kfin.test' },
    }, ['https://beta.kfin.example'])).toBe(false);
  });

  it('accepts fetch metadata only for same-site or user-initiated navigation', () => {
    expect(isBrowserSafeRequest({
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    }, [])).toBe(true);
    expect(isBrowserSafeRequest({
      method: 'POST',
      headers: { 'sec-fetch-site': 'none' },
    }, [])).toBe(true);
    expect(isBrowserSafeRequest({
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    }, [])).toBe(false);
  });

  it('rejects a state-changing request with neither origin nor fetch metadata', () => {
    expect(isBrowserSafeRequest({ method: 'POST', headers: {} }, [])).toBe(false);
    expect(isBrowserSafeRequest({ method: 'DELETE', headers: {} }, [])).toBe(false);
  });
});
