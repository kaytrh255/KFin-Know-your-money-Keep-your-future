import type { FastifyRequest } from 'fastify';

export interface AuthenticatedPrincipal {
  readonly userId: string;
  /** Present for session-backed principals; enables rotation and CSRF binding. */
  readonly sessionId?: string;
  readonly csrfDigest?: string;
}

export type AuthenticateRequest = (
  request: FastifyRequest,
) => Promise<AuthenticatedPrincipal | null>;

declare module 'fastify' {
  interface FastifyRequest {
    principal: AuthenticatedPrincipal | null;
  }
}
