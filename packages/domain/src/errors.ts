export type FinancialErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'FINANCIAL_RESOURCE_UNAVAILABLE'
  | 'FINANCIAL_VALIDATION_FAILED'
  | 'FINANCIAL_AMOUNT_OUT_OF_RANGE'
  | 'FINANCIAL_STATE_STALE'
  | 'FIN_SNAPSHOT_STALE_STATE'
  | 'FIN_CORRECTION_STALE_STATE'
  | 'FIN_CORRECTION_CROSS_SEGMENT_UNSUPPORTED'
  | 'FIN_CORRECTION_EFFECT_CHANGE_UNSUPPORTED'
  | 'FIN_CORRECTION_INVALID_TRANSITION'
  | 'FIN_CORRECTION_LINKED_DOMAIN_REQUIRED'
  | 'FIN_TRANSACTION_DOMAIN_LINK_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'FINANCIAL_CONCURRENCY_BUSY'
  | 'FINANCIAL_OPERATION_TIMEOUT'
  | 'FINANCIAL_RESULT_UNKNOWN'
  | 'FIN_ACCOUNT_ALREADY_EXISTS'
  | 'FIN_OPENING_BALANCE_INVALID'
  | 'FIN_DATABASE_UNAVAILABLE'
  | 'SAVINGS_GOAL_INVALID'
  | 'SAVINGS_GOAL_VERSION_CONFLICT'
  | 'SAVINGS_GOAL_ARCHIVED';

export interface FinancialErrorOptions {
  readonly code: FinancialErrorCode;
  readonly statusCode: number;
  readonly safeMessage: string;
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

/**
 * Common shape for every safe, bounded API failure. The API error handler maps
 * any subclass to one stable envelope; nothing outside this hierarchy may reach
 * a client with a code and status.
 */
export abstract class KfinServiceError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;
  abstract readonly safeMessage: string;
  abstract readonly retryAfterSeconds: number | undefined;
}

export class FinancialError extends KfinServiceError {
  readonly code: FinancialErrorCode;
  readonly statusCode: number;
  readonly safeMessage: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(options: FinancialErrorOptions) {
    super(options.safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FinancialError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.safeMessage = options.safeMessage;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function validationError(message = 'The financial request is invalid.'): FinancialError {
  return new FinancialError({
    code: 'FINANCIAL_VALIDATION_FAILED',
    statusCode: 400,
    safeMessage: message,
  });
}

export function unavailableError(): FinancialError {
  return new FinancialError({
    code: 'FINANCIAL_RESOURCE_UNAVAILABLE',
    statusCode: 404,
    safeMessage: 'The requested financial resource is unavailable.',
  });
}
