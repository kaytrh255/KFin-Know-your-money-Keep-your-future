/**
 * Response security headers for the deployed path.
 *
 * The API and the compiled client share one origin, and in production that
 * origin is behind a TLS-terminating proxy. TLS protects the transport; these
 * headers stop the browser from downgrading it, sniffing a content type,
 * framing the app, or leaking the origin through `Referer`.
 *
 * Deliberately no `helmet` dependency: the policy is small, explicit and
 * covered by tests, and every header here has a reason a reader can check.
 *
 * Trace: SEC-APP-10/12 (browser transport), SEC-SES-07 (cookie/origin defense),
 * release readiness item 10 (HTTPS and headers in a deployed path).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface SecurityHeaderOptions {
  /**
   * HSTS lifetime in seconds. `0` omits the header. Only ever non-zero in
   * production: a browser that receives HSTS from a plain-HTTP development
   * host would then refuse to downgrade it for local work.
   */
  readonly hstsMaxAgeSeconds: number;
}

/**
 * The client is plain ES modules plus one stylesheet served from the same
 * origin: it needs no inline script, inline style, external host, frame, form
 * action or plugin. `connect-src 'self'` still permits the same-origin `fetch`
 * calls the client makes.
 */
export const DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** A JSON response never needs to load anything. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export function securityHeadersFor(
  contentType: string | undefined,
  options: SecurityHeaderOptions,
): Record<string, string> {
  const isHtml = (contentType ?? '').startsWith('text/html');
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    // The client is same-origin only, so no other origin may embed its assets.
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'content-security-policy': isHtml ? DOCUMENT_CSP : API_CSP,
  };
  if (options.hstsMaxAgeSeconds > 0) {
    headers['strict-transport-security'] = `max-age=${options.hstsMaxAgeSeconds}; includeSubDomains`;
  }
  return headers;
}

/**
 * Applies the headers in `onSend`, so every response gets them — including
 * errors, 404s, redirects and the static client — instead of only the routes
 * that remember to set them.
 */
export function registerSecurityHeaders(app: FastifyInstance, options: SecurityHeaderOptions): void {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    const headers = securityHeadersFor(reply.getHeader('content-type') as string | undefined, options);
    for (const [name, value] of Object.entries(headers)) {
      // Route-level code may already have set a deliberate value; do not fight it.
      if (reply.getHeader(name) === undefined) reply.header(name, value);
    }
    return payload;
  });
}
