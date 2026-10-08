export type FinancialErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'FINANCIAL_RESOURCE_UNAVAILABLE'
  | 'FINANCIAL_VALIDATION_FAILED'
  | 'FINANCIAL_AMOUNT_OUT_OF_RANGE'
  | 'FINANCIAL_STATE_STALE'
  | 'FIN_SNAPSHOT_STALE_STATE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'FINANCIAL_CONCURRENCY_BUSY'
  | 'FINANCIAL_OPERATION_TIMEOUT'
  | 'FINANCIAL_RESULT_UNKNOWN'
  | 'FIN_ACCOUNT_ALREADY_EXISTS'
  | 'FIN_DATABASE_UNAVAILABLE';

export interface FinancialErrorOptions {
  readonly code: FinancialErrorCode;
  readonly statusCode: number;
  readonly safeMessage: string;
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

export class FinancialError extends Error {
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
