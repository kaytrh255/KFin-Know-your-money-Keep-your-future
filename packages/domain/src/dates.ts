import { validationError } from './errors.js';

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertLocalDate(value: string): string {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) throw validationError('Date must use YYYY-MM-DD format.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (
    instant.getUTCFullYear() !== year
    || instant.getUTCMonth() !== month - 1
    || instant.getUTCDate() !== day
  ) {
    throw validationError('Date is not a valid calendar date.');
  }
  return value;
}

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function localDateAt(instant: Date, timezone: string): string {
  if (!isIanaTimezone(timezone)) throw validationError('Timezone is invalid.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}
