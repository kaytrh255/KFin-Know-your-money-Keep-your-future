import { validationError } from './errors.js';

const localDatePattern = /^(?!0000)(\d{4})-(\d{2})-(\d{2})$/;
const yearMonthPattern = /^(?!0000)(\d{4})-(\d{2})$/;

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function assertIanaTimezone(value: string): string {
  if (!isIanaTimezone(value)) {
    throw validationError('Timezone must be a valid IANA timezone identifier.');
  }
  return value;
}

export function localDateAt(instant: Date, timezone: string): string {
  assertIanaTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function assertLocalDate(value: string): string {
  const match = localDatePattern.exec(value);
  if (!match) throw validationError('Date must be a real calendar date in YYYY-MM-DD form.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(0);
  instant.setUTCHours(0, 0, 0, 0);
  instant.setUTCFullYear(year, month - 1, day);
  if (
    instant.getUTCFullYear() !== year
    || instant.getUTCMonth() !== month - 1
    || instant.getUTCDate() !== day
  ) {
    throw validationError('Date must be a real calendar date in YYYY-MM-DD form.');
  }
  return value;
}

export function monthBounds(value: string): { readonly start: string; readonly end: string } {
  const match = yearMonthPattern.exec(value);
  if (!match) throw validationError('Month must use YYYY-MM format and a supported calendar year.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw validationError('Month must use YYYY-MM format and a supported calendar year.');
  }
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`,
    end: `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`,
  };
}
