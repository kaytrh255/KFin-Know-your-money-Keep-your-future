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
  financialAccountListResponseSchema,
  idempotencyHeadersSchema,
  monthlyActualsQuerySchema,
  monthlyActualsResponseSchema,
  occurrenceListQuerySchema,
  occurrenceListResponseSchema,
  occurrencePathSchema,
  occurrenceSchema,
  openFinancialAccountBodySchema,
  openFinancialAccountResponseSchema,
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
  FinancialAccountList,
  MonthlyActualsView,
  OccurrenceView,
  OpenFinancialAccountInput,
  OpenFinancialAccountResult,
  PreviewCorrectionInput,
  PreviewVoidInput,
  TransactionCorrectionHistory,
  TransactionPage,
  TransactionView,
  TransitionOccurrenceInput,
  TransitionOccurrenceResult,
} from '@kfin/database';
import { csrfFailedError, FinancialError, KfinServiceError } from '@kfin/domain';
import { registerAuthRoutes, type AuthApiService } from './auth-routes.js';
import { registerSavingsRoutes, type SavingsApiService } from './savings-routes.js';
import { UnavailableEmailAdapter, type EmailDeliveryAdapter } from './email-delivery.js';
import {
  isBrowserSafeRequest,
  readCsrfHeader,
  type SessionTransportOptions,
} from './session-transport.js';
import type { AuthenticateRequest } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FinancialApiService {
  /** Owner always comes from the authenticated principal, never from input. */
  openFinancialAccount(
    ownerUserId: string,
    input: OpenFinancialAccountInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<OpenFinancialAccountResult>;
  listFinancialAccounts(ownerUserId: string): Promise<FinancialAccountList>;
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

export type { SavingsApiService } from './savings-routes.js';

export interface BuildAppOptions {
  readonly financialService: FinancialApiService;
  readonly scheduleService?: ScheduleApiService;
  /** Milestone 06 savings goals. Absent means the savings routes stay unregistered. */
  readonly savingsService?: SavingsApiService;
  readonly authenticate: AuthenticateRequest;
  readonly readinessPool?: Pick<Pool, 'query'>;
  readonly logger?: boolean;
  /** Trusted Private Beta access. Absent means every auth route stays unregistered. */
  readonly authService?: AuthApiService;
  readonly emailDelivery?: EmailDeliveryAdapter;
  readonly authTransport?: SessionTransportOptions;
  readonly authAbsoluteLifetimeSeconds?: number;
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

  /**
   * Authentication plus the Milestone 04 browser state-change defense:
   * same-origin (or same-site Fetch Metadata) and the session-bound
   * double-submit CSRF token. Runs at `onRequest` (before content-type
   * parsing), so a cross-site or token-less request — including an HTML form
   * or malformed body — is rejected with 401/403 before its body is parsed or
   * validated. Fails closed when no session-backed CSRF binding or verifier is
   * available.
   */
  const requireCsrfProtectedAuthentication = async (request: FastifyRequest): Promise<void> => {
    await requireAuthentication(request);
    if (!isBrowserSafeRequest(request)) throw csrfFailedError();
    const csrfDigest = request.principal?.csrfDigest;
    const verifier = options.authService;
    if (typeof csrfDigest !== 'string' || !verifier) throw csrfFailedError();
    if (!verifier.verifyCsrfToken(readCsrfHeader(request), csrfDigest)) throw csrfFailedError();
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

  if (options.authService) {
    await registerAuthRoutes({
      app,
      authenticate: options.authenticate,
      authService: options.authService,
      emailDelivery: options.emailDelivery ?? new UnavailableEmailAdapter(),
      transport: options.authTransport ?? {
        secure: true,
        prefixHost: true,
      },
      absoluteLifetimeSeconds: options.authAbsoluteLifetimeSeconds ?? 90 * 24 * 60 * 60,
    });
  }

  app.post('/api/v1/financial-account', {
    onRequest: requireCsrfProtectedAuthentication,
    schema: {
      tags: ['financial-accounts'],
      headers: idempotencyHeadersSchema,
      body: openFinancialAccountBodySchema,
      response: {
        201: openFinancialAccountResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
        409: errorResponseSchema,
        422: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const result = await options.financialService.openFinancialAccount(
      requireUserId(request),
      {
        openingBalanceMinor: request.body.openingBalanceMinor,
        effectiveAt: request.body.effectiveAt,
      },
      request.headers['idempotency-key'],
      request.id,
    );
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    return reply.code(201).send({
      accountId: result.accountId,
      snapshotId: result.snapshotId,
      financialStateVersion: result.financialStateVersion,
    });
  });

  app.get('/api/v1/financial-accounts', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-accounts'],
      response: { 200: financialAccountListResponseSchema, 401: errorResponseSchema },
    },
  }, async (request) => options.financialService.listFinancialAccounts(requireUserId(request)));

  app.get('/api/v1/financial-account', {
    preHandler: requireAuthentication,
    schema: {
      tags: ['financial-foundation'],
      response: { 200: currentBalanceSchema, 401: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request) => options.financialService.getCurrentBalance(requireUserId(request)));

  // Milestone 08: a manual balance snapshot is a state-changing browser write
  // whose client-supplied `amountMinor` becomes the authoritative current
  // balance, so it takes the Milestone 04 defense at `onRequest` (before
  // content-type parsing) like every other financial mutation. This closes the
  // gap Milestone 07 recorded as a deferred observation.
  app.post('/api/v1/financial-account/snapshots', {
    onRequest: requireCsrfProtectedAuthentication,
    schema: {
      tags: ['financial-foundation'],
      headers: idempotencyHeadersSchema,
      body: createSnapshotBodySchema,
      response: {
        201: createSnapshotResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
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

  // Milestone 07: the one-time transaction write uses the Milestone 04 browser
  // state-change defense at `onRequest` (before content-type parsing), the same
  // convention Milestones 05/06 apply to their mutations, and reports an
  // idempotent replay at the transport level like every newer financial write.
  app.post('/api/v1/transactions', {
    onRequest: requireCsrfProtectedAuthentication,
    schema: {
      tags: ['financial-foundation'],
      headers: idempotencyHeadersSchema,
      body: createTransactionBodySchema,
      response: {
        201: createTransactionResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
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
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    return reply.code(201).send({
      transactionId: result.transactionId,
      financialStateVersion: result.financialStateVersion,
    });
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

  // E-4 (Milestone 09): the correction write surface takes the Milestone 04
  // browser state-change defense at `onRequest` (before content-type parsing),
  // the same convention Milestones 05/06/07/08 apply to every other financial
  // mutation. Preview is a write surface here: it binds the authoritative
  // review context that the commit route later accepts.
  app.post('/api/v1/transactions/:id/correction-preview', {
    onRequest: requireCsrfProtectedAuthentication,
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

  // E-4 (Milestone 09): as above, the void preview binds the review context
  // that the void commit route later accepts, so it is guarded as a write.
  app.post('/api/v1/transactions/:id/void-preview', {
    onRequest: requireCsrfProtectedAuthentication,
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

  // E-4 (Milestone 09): the correction commit appends an immutable correcting
  // entry and can move the authoritative current balance, so it takes the
  // Milestone 04 defense at `onRequest` like every other financial mutation.
  app.post('/api/v1/transactions/:id/corrections', {
    onRequest: requireCsrfProtectedAuthentication,
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

  // E-4 (Milestone 09): the void commit withdraws a posted amount from the
  // authoritative balance, so it takes the same `onRequest` defense.
  app.post('/api/v1/transactions/:id/void', {
    onRequest: requireCsrfProtectedAuthentication,
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
    // E-4 (Milestone 09): one-off schedule creation writes a new scheduled
    // item for the victim account, so it takes the Milestone 04 defense at
    // `onRequest` (before content-type parsing).
    app.post('/api/v1/schedule/one-off', {
      onRequest: requireCsrfProtectedAuthentication,
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

    // E-4 (Milestone 09): confirming an occurrence posts a real transaction
    // against the balance, so it takes the same `onRequest` defense.
    app.post('/api/v1/schedule/occurrences/:id/confirm', {
      onRequest: requireCsrfProtectedAuthentication,
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
      // E-4 (Milestone 09): skipping or cancelling an occurrence mutates the
      // schedule state machine under an optimistic version, so both take the
      // same `onRequest` defense.
      app.post(`/api/v1/schedule/occurrences/:id/${target}`, {
        onRequest: requireCsrfProtectedAuthentication,
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

  if (options.savingsService) {
    registerSavingsRoutes({
      app,
      service: options.savingsService,
      requireAuthentication,
      requireCsrfProtectedAuthentication,
      requireUserId,
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof KfinServiceError) {
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

/**
 * Shared response contract for the correction, void and schedule mutations.
 *
 * `403` is part of the contract because every one of these routes now runs the
 * Milestone 04 browser state-change defense at `onRequest` (E-4 / Milestone 09)
 * and answers `AUTH_CSRF_FAILED` before the body is parsed.
 */
function correctionResponses(successStatus: 200 | 201, successSchema: unknown) {
  return {
    [successStatus]: successSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
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
