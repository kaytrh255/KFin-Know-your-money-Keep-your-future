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
  correctionCommitBodySchema,
  correctionCommitResponseSchema,
  correctionPreviewBodySchema,
  correctionPreviewResponseSchema,
  confirmOccurrenceBodySchema,
  confirmOccurrenceResponseSchema,
  createOneOffScheduleBodySchema,
  createOneOffScheduleResponseSchema,
  createSnapshotBodySchema,
  createSnapshotResponseSchema,
  createTransactionBodySchema,
  createTransactionResponseSchema,
  currentBalanceSchema,
  errorResponseSchema,
  idempotencyHeadersSchema,
  monthlyActualsQuerySchema,
  monthlyActualsResponseSchema,
  occurrenceListQuerySchema,
  occurrenceListResponseSchema,
  occurrencePathSchema,
  occurrenceSchema,
  transactionCorrectionHistoryQuerySchema,
  transactionCorrectionHistoryResponseSchema,
  transactionListQuerySchema,
  transactionListResponseSchema,
  transactionPathSchema,
  transactionSchema,
  transitionOccurrenceBodySchema,
  transitionOccurrenceResponseSchema,
  voidCommitBodySchema,
  voidPreviewBodySchema,
} from '@kfin/contracts';
import type {
  CommitCorrectionInput,
  CommitVoidInput,
  ConfirmOccurrenceInput,
  ConfirmOccurrenceResult,
  CorrectionCommitResult,
  CorrectionPreviewView,
  CreateOneOffScheduleInput,
  CreateOneOffScheduleResult,
  CreateSnapshotInput,
  CreateSnapshotResult,
  CreateTransactionInput,
  CreateTransactionResult,
  CurrentBalanceView,
  MonthlyActualsView,
  OccurrenceView,
  PreviewCorrectionInput,
  PreviewVoidInput,
  TransactionCorrectionHistory,
  TransactionPage,
  TransactionView,
  TransitionOccurrenceInput,
  TransitionOccurrenceResult,
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
  getTransactionCorrectionHistory(
    ownerUserId: string,
    transactionId: string,
    options: { readonly limit: number; readonly cursor?: string },
  ): Promise<TransactionCorrectionHistory>;
  listTransactions(
    ownerUserId: string,
    options: {
      readonly limit: number;
      readonly cursor?: string;
      readonly month?: string;
      readonly categoryCode?: string;
      readonly kind?: 'income' | 'expense';
      readonly balanceEffect?: 'current' | 'historical';
    },
  ): Promise<TransactionPage>;
  previewTransactionCorrection(
    ownerUserId: string,
    sourceTransactionId: string,
    input: PreviewCorrectionInput,
  ): Promise<CorrectionPreviewView>;
  previewTransactionVoid(
    ownerUserId: string,
    sourceTransactionId: string,
    input: PreviewVoidInput,
  ): Promise<CorrectionPreviewView>;
  correctTransaction(
    ownerUserId: string,
    sourceTransactionId: string,
    input: CommitCorrectionInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CorrectionCommitResult>;
  voidTransaction(
    ownerUserId: string,
    sourceTransactionId: string,
    input: CommitVoidInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CorrectionCommitResult>;
  getMonthlyActuals(ownerUserId: string, month: string): Promise<MonthlyActualsView>;
}

export interface ScheduleApiService {
  createOneOff(
    ownerUserId: string,
    input: CreateOneOffScheduleInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CreateOneOffScheduleResult>;
  getOccurrence(ownerUserId: string, occurrenceId: string): Promise<OccurrenceView>;
  listOccurrences(
    ownerUserId: string,
    options: {
      readonly state?: 'scheduled' | 'confirmed' | 'skipped' | 'cancelled';
      readonly kind?: 'income' | 'expense';
      readonly limit: number;
      readonly cursor?: string;
    },
  ): Promise<{ readonly items: OccurrenceView[]; readonly nextCursor: string | null }>;
  confirmOccurrence(
    ownerUserId: string,
    occurrenceId: string,
    input: ConfirmOccurrenceInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<ConfirmOccurrenceResult>;
  transitionOccurrence(
    ownerUserId: string,
    occurrenceId: string,
    targetState: 'skipped' | 'cancelled',
    input: TransitionOccurrenceInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<TransitionOccurrenceResult>;
}

export interface BuildAppOptions {
  readonly financialService: FinancialApiService;
  readonly scheduleService?: ScheduleApiService;
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
    {
      limit: request.query.limit,
      ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      ...(request.query.month === undefined ? {} : { month: request.query.month }),
      ...(request.query.categoryCode === undefined ? {} : { categoryCode: request.query.categoryCode }),
      ...(request.query.kind === undefined ? {} : { kind: request.query.kind }),
      ...(request.query.balanceEffect === undefined ? {} : { balanceEffect: request.query.balanceEffect }),
    },
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

  app.get('/api/v1/transactions/:id/correction-history', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-corrections'],
      params: transactionPathSchema,
      querystring: transactionCorrectionHistoryQuerySchema,
      response: {
        200: transactionCorrectionHistoryResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request) => options.financialService.getTransactionCorrectionHistory(
    requireUserId(request),
    request.params.id,
    request.query.cursor === undefined
      ? { limit: request.query.limit }
      : { limit: request.query.limit, cursor: request.query.cursor },
  ));

  app.post('/api/v1/transactions/:id/correction-preview', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-corrections'],
      params: transactionPathSchema,
      body: correctionPreviewBodySchema,
      response: correctionResponses(200, correctionPreviewResponseSchema),
    },
  }, async (request) => options.financialService.previewTransactionCorrection(
    requireUserId(request),
    request.params.id,
    correctionPreviewInput(request.body),
  ));

  app.post('/api/v1/transactions/:id/void-preview', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-corrections'],
      params: transactionPathSchema,
      body: voidPreviewBodySchema,
      response: correctionResponses(200, correctionPreviewResponseSchema),
    },
  }, async (request) => options.financialService.previewTransactionVoid(
    requireUserId(request),
    request.params.id,
    { reason: request.body.reason },
  ));

  app.post('/api/v1/transactions/:id/corrections', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-corrections'],
      params: transactionPathSchema,
      headers: idempotencyHeadersSchema,
      body: correctionCommitBodySchema,
      response: correctionResponses(201, correctionCommitResponseSchema),
    },
  }, async (request, reply) => {
    const result = await options.financialService.correctTransaction(
      requireUserId(request),
      request.params.id,
      correctionCommitInput(request.body),
      request.headers['idempotency-key'],
      request.id,
    );
    return reply.code(201).send(result);
  });

  app.post('/api/v1/transactions/:id/void', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-corrections'],
      params: transactionPathSchema,
      headers: idempotencyHeadersSchema,
      body: voidCommitBodySchema,
      response: correctionResponses(200, correctionCommitResponseSchema),
    },
  }, async (request) => options.financialService.voidTransaction(
    requireUserId(request),
    request.params.id,
    { reason: request.body.reason, context: request.body.context },
    request.headers['idempotency-key'],
    request.id,
  ));

  const scheduleService = options.scheduleService;
  if (scheduleService) {
    app.post('/api/v1/schedule/one-off', {
      preHandler: requireAuthentication,
      schema: {
        tags: ['schedule'],
        headers: idempotencyHeadersSchema,
        body: createOneOffScheduleBodySchema,
        response: scheduleResponses(201, createOneOffScheduleResponseSchema),
      },
    }, async (request, reply) => {
      const body = request.body;
      const input: CreateOneOffScheduleInput = {
        title: body.title,
        kind: body.kind,
        expectedAmountMinor: body.expectedAmountMinor,
        dueOn: body.dueOn,
        categoryCode: body.categoryCode,
        expectedFinancialStateVersion: body.expectedFinancialStateVersion,
        reviewedLatestSnapshotId: body.reviewedLatestSnapshotId,
        ...(body.expenseClass === undefined ? {} : { expenseClass: body.expenseClass }),
      };
      const result = await scheduleService.createOneOff(
        requireUserId(request),
        input,
        request.headers['idempotency-key'],
        request.id,
      );
      return reply.code(201).send(result);
    });

    app.get('/api/v1/schedule/occurrences', {
      preHandler: requireAuthentication,
      schema: {
        tags: ['schedule'],
        querystring: occurrenceListQuerySchema,
        response: {
          200: occurrenceListResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    }, async (request) => scheduleService.listOccurrences(
      requireUserId(request),
      {
        limit: request.query.limit,
        ...(request.query.state === undefined ? {} : { state: request.query.state }),
        ...(request.query.kind === undefined ? {} : { kind: request.query.kind }),
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      },
    ));

    app.get('/api/v1/schedule/occurrences/:id', {
      preHandler: requireAuthentication,
      schema: {
        tags: ['schedule'],
        params: occurrencePathSchema,
        response: {
          200: occurrenceSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    }, async (request) => scheduleService.getOccurrence(
      requireUserId(request),
      request.params.id,
    ));

    app.post('/api/v1/schedule/occurrences/:id/confirm', {
      preHandler: requireAuthentication,
      schema: {
        tags: ['schedule'],
        params: occurrencePathSchema,
        headers: idempotencyHeadersSchema,
        body: confirmOccurrenceBodySchema,
        response: scheduleResponses(201, confirmOccurrenceResponseSchema),
      },
    }, async (request, reply) => {
      const body = request.body;
      const input: ConfirmOccurrenceInput = {
        amountMinor: body.amountMinor,
        occurredOn: body.occurredOn,
        categoryCode: body.categoryCode,
        isUnexpected: body.isUnexpected,
        expectedFinancialStateVersion: body.expectedFinancialStateVersion,
        reviewedLatestSnapshotId: body.reviewedLatestSnapshotId,
        reviewedOccurrenceVersion: body.reviewedOccurrenceVersion,
        ...(body.expenseClass === undefined ? {} : { expenseClass: body.expenseClass }),
        ...(body.alreadyIncludedInSnapshot === undefined
          ? {}
          : { alreadyIncludedInSnapshot: body.alreadyIncludedInSnapshot }),
        ...(body.note === undefined ? {} : { note: body.note }),
      };
      const result = await scheduleService.confirmOccurrence(
        requireUserId(request),
        request.params.id,
        input,
        request.headers['idempotency-key'],
        request.id,
      );
      return reply.code(201).send(result);
    });

    for (const target of ['skip', 'cancel'] as const) {
      app.post(`/api/v1/schedule/occurrences/:id/${target}`, {
        preHandler: requireAuthentication,
        schema: {
          tags: ['schedule'],
          params: occurrencePathSchema,
          headers: idempotencyHeadersSchema,
          body: transitionOccurrenceBodySchema,
          response: scheduleResponses(200, transitionOccurrenceResponseSchema),
        },
      }, async (request) => scheduleService.transitionOccurrence(
        requireUserId(request),
        request.params.id,
        target === 'skip' ? 'skipped' : 'cancelled',
        request.body,
        request.headers['idempotency-key'],
        request.id,
      ));
    }
  }

  app.get('/api/v1/reports/monthly-actuals', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-reporting'],
      querystring: monthlyActualsQuerySchema,
      response: {
        200: monthlyActualsResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request) => options.financialService.getMonthlyActuals(
    requireUserId(request),
    request.query.month,
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

function correctionPreviewInput(body: {
  reason: string;
  replacement: {
    amountMinor: string;
    occurredOn: string;
    categoryCode: string;
    expenseClass?: 'essential_fixed' | 'essential_variable' | 'daily' | undefined;
    isUnexpected: boolean;
    note?: string | null | undefined;
  };
}): PreviewCorrectionInput {
  return {
    reason: body.reason,
    replacement: {
      amountMinor: body.replacement.amountMinor,
      occurredOn: body.replacement.occurredOn,
      categoryCode: body.replacement.categoryCode,
      isUnexpected: body.replacement.isUnexpected,
      ...(body.replacement.expenseClass === undefined
        ? {}
        : { expenseClass: body.replacement.expenseClass }),
      ...(body.replacement.note === undefined ? {} : { note: body.replacement.note }),
    },
  };
}

function correctionCommitInput(body: {
  reason: string;
  replacement: {
    amountMinor: string;
    occurredOn: string;
    categoryCode: string;
    expenseClass?: 'essential_fixed' | 'essential_variable' | 'daily' | undefined;
    isUnexpected: boolean;
    note?: string | null | undefined;
  };
  context: CommitCorrectionInput['context'];
}): CommitCorrectionInput {
  return { ...correctionPreviewInput(body), context: body.context };
}

function scheduleResponses(successStatus: 200 | 201, successSchema: unknown) {
  return correctionResponses(successStatus, successSchema);
}

function correctionResponses(successStatus: 200 | 201, successSchema: unknown) {
  return {
    [successStatus]: successSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema,
    503: errorResponseSchema,
  };
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
