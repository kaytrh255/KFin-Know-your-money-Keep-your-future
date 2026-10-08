import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import {
  createSnapshotBodySchema,
  createSnapshotResponseSchema,
  createTransactionBodySchema,
  createTransactionResponseSchema,
  currentBalanceSchema,
  errorResponseSchema,
  idempotencyHeadersSchema,
  transactionListQuerySchema,
  transactionListResponseSchema,
  transactionPathSchema,
  transactionSchema,
} from '@kfin/contracts';
import type {
  CreateSnapshotInput,
  CreateSnapshotResult,
  CreateTransactionInput,
  CreateTransactionResult,
  CurrentBalanceView,
  TransactionPage,
  TransactionView,
} from '@kfin/database';
import { FinancialError } from '@kfin/domain';
import type { AuthenticateRequest } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FinancialApiService {
  getCurrentBalance(ownerUserId: string): Promise<CurrentBalanceView>;
  createSnapshot(
    ownerUserId: string,
    input: CreateSnapshotInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CreateSnapshotResult>;
  createTransaction(
    ownerUserId: string,
    input: CreateTransactionInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CreateTransactionResult>;
  getTransaction(ownerUserId: string, transactionId: string): Promise<TransactionView>;
  listTransactions(
    ownerUserId: string,
    options: { readonly limit: number; readonly cursor?: string },
  ): Promise<TransactionPage>;
}

export interface BuildAppOptions {
  readonly financialService: FinancialApiService;
  readonly authenticate: AuthenticateRequest;
  readonly readinessPool?: Pick<Pool, 'query'>;
  readonly logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
    requestIdHeader: false,
    genReqId: (request) => {
      const proposed = request.headers['x-correlation-id'];
      return typeof proposed === 'string' && UUID_PATTERN.test(proposed)
        ? proposed
        : randomUUID();
    },
    logController: new LogController({ disableRequestLogging: true }),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: {
      info: { title: 'KFin API', version: '0.1.0' },
      servers: [{ url: '/api/v1' }],
    },
    transform: jsonSchemaTransform,
  });

  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/v1/')) reply.header('Cache-Control', 'no-store');
  });

  const requireAuthentication = async (request: FastifyRequest): Promise<void> => {
    const principal = await options.authenticate(request);
    if (!principal) {
      throw new FinancialError({
        code: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
        safeMessage: 'Authentication is required.',
      });
    }
    request.principal = principal;
  };

  app.get('/health/live', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { schema: { hide: true } }, async (_request, reply) => {
    if (!options.readinessPool) return { status: 'ok', database: 'not-configured' };
    try {
      await options.readinessPool.query('SELECT 1');
      return { status: 'ok', database: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'unavailable' });
    }
  });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.get('/api/v1/financial-account', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-foundation'],
      response: { 200: currentBalanceSchema, 401: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request) => options.financialService.getCurrentBalance(requireUserId(request)));

  app.post('/api/v1/financial-account/snapshots', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-foundation'],
      headers: idempotencyHeadersSchema,
      body: createSnapshotBodySchema,
      response: {
        201: createSnapshotResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema,
        409: errorResponseSchema,
        422: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body;
    const input: CreateSnapshotInput = {
      amountMinor: body.amountMinor,
      effectiveAt: body.effectiveAt,
      expectedFinancialStateVersion: body.expectedFinancialStateVersion,
      reviewedLatestSnapshotId: body.reviewedLatestSnapshotId,
      ...(body.note === undefined ? {} : { note: body.note }),
    };
    const result = await options.financialService.createSnapshot(
      requireUserId(request),
      input,
      request.headers['idempotency-key'],
      request.id,
    );
    return reply.code(201).send(result);
  });

  app.post('/api/v1/transactions', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-foundation'],
      headers: idempotencyHeadersSchema,
      body: createTransactionBodySchema,
      response: {
        201: createTransactionResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema,
        409: errorResponseSchema,
        422: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body;
    const input: CreateTransactionInput = {
      kind: body.kind,
      amountMinor: body.amountMinor,
      occurredOn: body.occurredOn,
      categoryCode: body.categoryCode,
      isUnexpected: body.isUnexpected,
      expectedFinancialStateVersion: body.expectedFinancialStateVersion,
      reviewedLatestSnapshotId: body.reviewedLatestSnapshotId,
      ...(body.expenseClass === undefined ? {} : { expenseClass: body.expenseClass }),
      ...(body.alreadyIncludedInSnapshot === undefined
        ? {}
        : { alreadyIncludedInSnapshot: body.alreadyIncludedInSnapshot }),
      ...(body.note === undefined ? {} : { note: body.note }),
    };
    const result = await options.financialService.createTransaction(
      requireUserId(request),
      input,
      request.headers['idempotency-key'],
      request.id,
    );
    return reply.code(201).send(result);
  });

  app.get('/api/v1/transactions', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-foundation'],
      querystring: transactionListQuerySchema,
      response: {
        200: transactionListResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
      },
    },
  }, async (request) => options.financialService.listTransactions(
    requireUserId(request),
    request.query.cursor === undefined
      ? { limit: request.query.limit }
      : { limit: request.query.limit, cursor: request.query.cursor },
  ));

  app.get('/api/v1/transactions/:id', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-foundation'],
      params: transactionPathSchema,
      response: {
        200: transactionSchema,
        401: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request) => options.financialService.getTransaction(
    requireUserId(request),
    request.params.id,
  ));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof FinancialError) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(error.retryAfterSeconds));
      }
      return reply.code(error.statusCode).send(errorEnvelope(error.code, error.safeMessage, request.id));
    }
    if (error !== null && typeof error === 'object' && 'validation' in error && error.validation) {
      return reply.code(400).send(errorEnvelope(
        'REQUEST_VALIDATION_FAILED',
        'The request does not match the API contract.',
        request.id,
      ));
    }
    request.log.error({
      errorName: error instanceof Error ? error.name : 'UnknownError',
      correlationId: request.id,
    }, 'Unhandled API error');
    return reply.code(500).send(errorEnvelope(
      'INTERNAL_ERROR',
      'The request could not be completed.',
      request.id,
    ));
  });

  await app.ready();
  return app;
}

function requireUserId(request: FastifyRequest): string {
  const userId = request.principal?.userId;
  if (!userId || !UUID_PATTERN.test(userId)) {
    throw new FinancialError({
      code: 'AUTHENTICATION_REQUIRED',
      statusCode: 401,
      safeMessage: 'Authentication is required.',
    });
  }
  return userId;
}

function errorEnvelope(code: string, message: string, correlationId: string) {
  return { error: { code, message, correlationId } };
}
