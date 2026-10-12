/**
 * Minor-unit money helpers.
 *
 * The API stores every amount as a string of minor units (`packages/contracts/src/common.ts`),
 * so the client never does floating-point money math: amounts are parsed to
 * integer strings with `BigInt` and only divided for display.
 */

export interface MoneyParseOk {
  readonly ok: true;
  readonly minor: string;
}
export interface MoneyParseFailure {
  readonly ok: false;
  readonly reason: string;
}
export type MoneyParseResult = MoneyParseOk | MoneyParseFailure;

const DEFAULT_MINOR_UNITS = 2;

/** ISO 4217 minor-unit exponent, taken from the runtime's own currency data. */
export function minorUnitDigits(currency: string): number {
  try {
    const formatted = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions();
    const digits = formatted.maximumFractionDigits;
    return typeof digits === 'number' && digits >= 0 && digits <= 6 ? digits : DEFAULT_MINOR_UNITS;
  } catch {
    return DEFAULT_MINOR_UNITS;
  }
}

/**
 * Parses what a person types ("1 250 000", "1,250,000.50", "1250000") into the
 * exact minor-unit string the API expects. Rejects anything ambiguous instead of
 * guessing, because a wrong amount is a real money defect.
 */
export function parseAmountToMinor(input: string, currency: string): MoneyParseResult {
  const cleaned = input.trim().replace(/[\s\u00a0_]/g, '');
  if (cleaned.length === 0) return { ok: false, reason: 'Enter an amount.' };
  const digits = minorUnitDigits(currency);

  const grouped = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
  const plain = /^[+-]?\d+(?:\.\d+)?$/;
  let normalized: string;
  if (grouped.test(cleaned)) {
    normalized = cleaned.replace(/,/g, '');
  } else if (plain.test(cleaned)) {
    normalized = cleaned;
  } else {
    return { ok: false, reason: 'Use digits with an optional decimal point, for example 1250000 or 1250000.50.' };
  }

  const negative = normalized.startsWith('-');
  const unsigned = normalized.replace(/^[+-]/, '');
  const [wholePart = '0', fractionPart = ''] = unsigned.split('.');
  if (fractionPart.length > digits) {
    return { ok: false, reason: `This currency uses ${digits} decimal place${digits === 1 ? '' : 's'}.` };
  }
  const paddedFraction = fractionPart.padEnd(digits, '0');
  const minor = `${wholePart}${paddedFraction}`.replace(/^0+(?=\d)/, '');
  if (minor.length > 19) return { ok: false, reason: 'That amount is too large.' };
  if (minor === '0' && negative) return { ok: false, reason: 'Zero does not need a sign.' };
  return { ok: true, minor: negative ? `-${minor}` : minor };
}

/** Renders minor units for display without losing the exact stored value. */
export function formatMinor(minor: string, currency: string, locale = 'vi-VN'): string {
  const digits = minorUnitDigits(currency);
  let exact: bigint;
  try {
    exact = BigInt(minor);
  } catch {
    return `${minor} ${currency}`;
  }
  const negative = exact < 0n;
  const absolute = negative ? -exact : exact;
  const scale = 10n ** BigInt(digits);
  const major = absolute / scale;
  const fraction = absolute % scale;
  const status = `${negative ? '-' : ''}${major.toString()}${digits === 0 ? '' : `.${fraction.toString().padStart(digits, '0')}`}`;
  const parsed = Number(status);
  if (Number.isFinite(parsed)) {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(parsed);
  }
  return `${status} ${currency}`;
}

/** `2026-10-12T00:00:00.000Z`-independent today; local date for form defaults. */
export function localDateToday(now = new Date()): string {
  const year = now.getFullYear().toString().padStart(4, '0');
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Local `YYYY-MM` for the month pickers. */
export function localYearMonth(now = new Date()): string {
  return localDateToday(now).slice(0, 7);
}

/** The API requires offset-bearing instants (`instantSchema`). */
export function instantNow(now = new Date()): string {
  return now.toISOString();
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isPositiveVersion(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

/** Contract category codes: `^[a-z][a-z0-9_]{1,62}$`. */
export function isCategoryCode(value: string): boolean {
  return /^[a-z][a-z0-9_]{1,62}$/.test(value);
}

/** Contract local dates: `^\d{4}-\d{2}-\d{2}$`, year 0000 excluded. */
export function isLocalDate(value: string): boolean {
  return /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value);
}
