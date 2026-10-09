import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  archiveSavingsGoalBodySchema,
  createSavingsGoalBodySchema,
  errorResponseSchema,
  idempotencyHeadersSchema,
  savingsAmountChangeListQuerySchema,
  savingsAmountChangeListResponseSchema,
  savingsGoalAmountReceiptSchema,
  savingsGoalListQuerySchema,
  savingsGoalListResponseSchema,
  savingsGoalPathSchema,
  savingsGoalReceiptSchema,
  savingsGoalSchema,
  updateSavingsCurrentAmountBodySchema,
  updateSavingsGoalPlanBodySchema,
} from '@kfin/contracts';
import type {
  ArchiveSavingsGoalInput,
  CreateSavingsGoalInput,
  SavingsAmountChangePage,
  SavingsGoalAmountReceipt,
  SavingsGoalPage,
  SavingsGoalReceipt,
  SavingsGoalView,
  UpdateSavingsCurrentAmountInput,
  UpdateSavingsGoalPlanInput,
} from '@kfin/database';

/** Owner identifiers always come from the authenticated principal, never input. */
export interface SavingsApiService {
  createGoal(
    ownerUserId: string,
    input: CreateSavingsGoalInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<SavingsGoalAmountReceipt>;
  listGoals(
    ownerUserId: string,
    options: {
      readonly status: 'active' | 'archived' | 'all';
      readonly limit: number;
      readonly cursor?: string;
    },
  ): Promise<SavingsGoalPage>;
  getGoal(ownerUserId: string, goalId: string): Promise<SavingsGoalView>;
  updatePlan(
    ownerUserId: string,
    goalId: string,
    input: UpdateSavingsGoalPlanInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<SavingsGoalReceipt>;
  updateCurrentAmount(
    ownerUserId: string,
    goalId: string,
    input: UpdateSavingsCurrentAmountInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<SavingsGoalAmountReceipt>;
  archiveGoal(
    ownerUserId: string,
    goalId: string,
    input: ArchiveSavingsGoalInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<SavingsGoalReceipt>;
  listAmountChanges(
    ownerUserId: string,
    goalId: string,
    options: { readonly limit: number; readonly cursor?: string },
  ): Promise<SavingsAmountChangePage>;
}

type Guard = (request: FastifyRequest) => Promise<void>;

const mutationErrors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  503: errorResponseSchema,
} as const;

const readErrors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  404: errorResponseSchema,
  503: errorResponseSchema,
} as const;

/**
 * Milestone 06 savings-goal routes. Every mutation runs the authentication and
 * browser CSRF defense at `onRequest`, i.e. before the body is parsed, so a
 * cross-site or token-less request is rejected with 401/403 first.
 */
export function registerSavingsRoutes(options: {
  readonly app: FastifyInstance;
  readonly service: SavingsApiService;
  readonly requireAuthentication: Guard;
  readonly requireCsrfProtectedAuthentication: Guard;
  readonly requireUserId: (request: FastifyRequest) => string;
}): void {
  const app = options.app.withTypeProvider<ZodTypeProvider>();
  const { service, requireUserId } = options;

  app.post('/api/v1/savings-goals', {
    onRequest: options.requireCsrfProtectedAuthentication,
    schema: {
      tags: ['savings-goals'],
      headers: idempotencyHeadersSchema,
      body: createSavingsGoalBodySchema,
      response: { 201: savingsGoalAmountReceiptSchema, ...mutationErrors },
    },
  }, async (request, reply) => {
    const body = request.body;
    const result = await service.createGoal(
      requireUserId(request),
      {
        name: body.name,
        targetAmountMinor: body.targetAmountMinor,
        currentAmountMinor: body.currentAmountMinor,
        currentAmountAsOf: body.currentAmountAsOf,
        ...(body.targetDate === undefined ? {} : { targetDate: body.targetDate }),
        ...(body.plannedContributionMinor === undefined
          ? {}
          : { plannedContributionMinor: body.plannedContributionMinor }),
        ...(body.contributionFrequency === undefined
          ? {}
          : { contributionFrequency: body.contributionFrequency }),
      },
      request.headers['idempotency-key'],
      request.id,
    );
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    return reply.code(201).send({
      goalId: result.goalId,
      version: result.version,
      amountChangeId: result.amountChangeId,
    });
  });

  app.get('/api/v1/savings-goals', {
    preHandler: options.requireAuthentication,
    schema: {
      tags: ['savings-goals'],
      querystring: savingsGoalListQuerySchema,
      response: { 200: savingsGoalListResponseSchema, ...readErrors },
    },
  }, async (request) => service.listGoals(requireUserId(request), {
    status: request.query.status,
    limit: request.query.limit,
    ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
  }));

  app.get('/api/v1/savings-goals/:id', {
    preHandler: options.requireAuthentication,
    schema: {
      tags: ['savings-goals'],
      params: savingsGoalPathSchema,
      response: { 200: savingsGoalSchema, ...readErrors },
    },
  }, async (request) => service.getGoal(requireUserId(request), request.params.id));

  app.patch('/api/v1/savings-goals/:id', {
    onRequest: options.requireCsrfProtectedAuthentication,
    schema: {
      tags: ['savings-goals'],
      headers: idempotencyHeadersSchema,
      params: savingsGoalPathSchema,
      body: updateSavingsGoalPlanBodySchema,
      response: { 200: savingsGoalReceiptSchema, ...mutationErrors },
    },
  }, async (request, reply) => {
    const body = request.body;
    const result = await service.updatePlan(
      requireUserId(request),
      request.params.id,
      {
        expectedVersion: body.expectedVersion,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.targetAmountMinor === undefined ? {} : { targetAmountMinor: body.targetAmountMinor }),
        ...(body.targetDate === undefined ? {} : { targetDate: body.targetDate }),
        ...(body.plannedContributionMinor === undefined
          ? {}
          : { plannedContributionMinor: body.plannedContributionMinor }),
        ...(body.contributionFrequency === undefined
          ? {}
          : { contributionFrequency: body.contributionFrequency }),
      },
      request.headers['idempotency-key'],
      request.id,
    );
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    return reply.code(200).send({ goalId: result.goalId, version: result.version });
  });

  app.post('/api/v1/savings-goals/:id/current-amount', {
    onRequest: options.requireCsrfProtectedAuthentication,
    schema: {
      tags: ['savings-goals'],
      headers: idempotencyHeadersSchema,
      params: savingsGoalPathSchema,
      body: updateSavingsCurrentAmountBodySchema,
      response: { 200: savingsGoalAmountReceiptSchema, ...mutationErrors },
    },
  }, async (request, reply) => {
    const body = request.body;
    const result = await service.updateCurrentAmount(
      requireUserId(request),
      request.params.id,
      {
        expectedVersion: body.expectedVersion,
        currentAmountMinor: body.currentAmountMinor,
        asOf: body.asOf,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      },
      request.headers['idempotency-key'],
      request.id,
    );
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    return reply.code(200).send({
      goalId: result.goalId,
      version: result.version,
      amountChangeId: result.amountChangeId,
    });
  });

  app.post('/api/v1/savings-goals/:id/archive', {
    onRequest: options.requireCsrfProtectedAuthentication,
    schema: {
      tags: ['savings-goals'],
      headers: idempotencyHeadersSchema,
      params: savingsGoalPathSchema,
      body: archiveSavingsGoalBodySchema,
      response: { 200: savingsGoalReceiptSchema, ...mutationErrors },
    },
  }, async (request, reply) => {
    const result = await service.archiveGoal(
      requireUserId(request),
      request.params.id,
      { expectedVersion: request.body.expectedVersion },
      request.headers['idempotency-key'],
      request.id,
    );
    if (result.replayed) reply.header('Idempotency-Replayed', 'true');
    return reply.code(200).send({ goalId: result.goalId, version: result.version });
  });

  app.get('/api/v1/savings-goals/:id/amount-changes', {
    preHandler: options.requireAuthentication,
    schema: {
      tags: ['savings-goals'],
      params: savingsGoalPathSchema,
      querystring: savingsAmountChangeListQuerySchema,
      response: { 200: savingsAmountChangeListResponseSchema, ...readErrors },
    },
  }, async (request) => service.listAmountChanges(requireUserId(request), request.params.id, {
    limit: request.query.limit,
    ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
  }));
}
