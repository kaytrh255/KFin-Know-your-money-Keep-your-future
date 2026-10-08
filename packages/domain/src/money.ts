import { FinancialError, validationError } from './errors.js';

export const POSTGRES_BIGINT_MINIMUM = -9_223_372_036_854_775_808n;
export const POSTGRES_BIGINT_MAXIMUM = 9_223_372_036_854_775_807n;

const POSITIVE_MINOR_PATTERN = /^[1-9][0-9]{0,18}$/;
const SIGNED_MINOR_PATTERN = /^(?:0|-?[1-9][0-9]{0,18})$/;

export function parsePositiveMinor(value: string): bigint {
  if (!POSITIVE_MINOR_PATTERN.test(value)) {
    throw validationError('Amount must be a positive integer minor-unit string.');
  }
  return assertMoneyRange(BigInt(value));
}

export function parseSignedMinor(value: string): bigint {
  if (!SIGNED_MINOR_PATTERN.test(value)) {
    throw validationError('Amount must be an integer minor-unit string.');
  }
  return assertMoneyRange(BigInt(value));
}

export function parseDatabaseBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value);
  throw new FinancialError({
    code: 'FIN_DATABASE_UNAVAILABLE',
    statusCode: 503,
    safeMessage: 'Financial data is temporarily unavailable.',
  });
}

export function checkedAdd(left: bigint, right: bigint): bigint {
  return assertMoneyRange(left + right);
}

export function checkedSubtract(left: bigint, right: bigint): bigint {
  return assertMoneyRange(left - right);
}

export function assertMoneyRange(value: bigint): bigint {
  if (value < POSTGRES_BIGINT_MINIMUM || value > POSTGRES_BIGINT_MAXIMUM) {
    throw new FinancialError({
      code: 'FINANCIAL_AMOUNT_OUT_OF_RANGE',
      statusCode: 422,
      safeMessage: 'The financial amount is outside the supported range.',
    });
  }
  return value;
}
