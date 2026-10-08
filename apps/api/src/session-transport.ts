import type { FastifyRequest } from 'fastify';

/**
 * Browser transport for opaque server-side sessions.
 *
 * Trace: SEC-SES-01..03/07, SEC-APP-10/12, ADR-004.
 *
 * The bearer token lives only in a host-prefixed `HttpOnly` cookie; the CSRF
 * token lives in a readable cookie so the Web/PWA client can echo it in the
 * `x-kfin-csrf` header. Session tokens never enter JSON bodies, URLs, or logs.
 */

export const SESSION_COOKIE_BASE_NAME = 'kfin_session';
export const CSRF_COOKIE_NAME = 'kfin_csrf';
export const CSRF_HEADER_NAME = 'x-kfin-csrf';

export interface SessionTransportOptions {
  readonly secure: boolean;
  readonly prefixHost: boolean;
  readonly allowedOrigins: readonly string[];
}

export function sessionCookieName(options: Pick<SessionTransportOptions, 'secure' | 'prefixHost'>): string {
  // `__Host-` requires Secure, Path=/ and no Domain; browser support depends on
  // an HTTPS deployment, so the prefix is used only where the flag allows it.
  return options.secure && options.prefixHost ? `__Host-${SESSION_COOKIE_BASE_NAME}` : SESSION_COOKIE_BASE_NAME;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

export function serializeSessionCookie(
  token: string,
  options: Pick<SessionTransportOptions, 'secure' | 'prefixHost'>,
  maxAgeSeconds: number,
): string {
  return serializeCookie(sessionCookieName(options), token, {
    secure: options.secure,
    httpOnly: true,
    maxAgeSeconds,
  });
}

export function serializeCsrfCookie(
  token: string,
  options: Pick<SessionTransportOptions, 'secure'>,
  maxAgeSeconds: number,
): string {
  // Deliberately not HttpOnly: the double-submit pattern needs the client to
  // read and echo the value. It is still Secure, SameSite=Strict and host-only.
  return serializeCookie(CSRF_COOKIE_NAME, token, {
    secure: options.secure,
    httpOnly: false,
    maxAgeSeconds,
    sameSite: 'Strict',
  });
}

export function clearedSessionCookie(options: Pick<SessionTransportOptions, 'secure' | 'prefixHost'>): string {
  return clearCookie(sessionCookieName(options), options.secure);
}

export function clearedCsrfCookie(options: Pick<SessionTransportOptions, 'secure'>): string {
  return clearCookie(CSRF_COOKIE_NAME, options.secure);
}

/**
 * State-changing browser requests must show an allowed origin or Fetch Metadata
 * proving a same-site navigation. `SameSite` alone is not accepted as a CSRF
 * defense (SEC-SES-07).
 */
export function isBrowserSafeRequest(
  request: Pick<FastifyRequest, 'method' | 'headers'>,
  allowedOrigins: readonly string[],
): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

  const origin = firstHeader(request.headers.origin);
  const host = firstHeader(request.headers.host);
  if (origin) {
    if (allowedOrigins.includes(origin)) return true;
    if (!host) return false;
    // Same-origin: the deployment host under either scheme.
    return origin === `https://${host}` || origin === `http://${host}`;
  }

  const fetchSite = firstHeader(request.headers['sec-fetch-site']);
  return fetchSite === 'same-origin' || fetchSite === 'none';
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    readonly secure: boolean;
    readonly httpOnly: boolean;
    readonly maxAgeSeconds: number;
    readonly sameSite?: 'Strict' | 'Lax';
  },
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `SameSite=${options.sameSite ?? 'Lax'}`,
  ];
  if (options.httpOnly) attributes.push('HttpOnly');
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}

function clearCookie(name: string, secure: boolean): string {
  return [
    `${name}=`,
    'Path=/',
    'Max-Age=0',
    'SameSite=Lax',
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
