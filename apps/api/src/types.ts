import type { FastifyRequest } from 'fastify';

export interface AuthenticatedPrincipal {
  readonly userId: string;
}

export type AuthenticateRequest = (
  request: FastifyRequest,
) => Promise<AuthenticatedPrincipal | null>;

declare module 'fastify' {
  interface FastifyRequest {
    principal: AuthenticatedPrincipal | null;
  }
}
