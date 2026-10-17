import { describe, expect, it } from 'vitest';
import {
  formatMinor,
  isCategoryCode,
  isLocalDate,
  isPositiveVersion,
  isUuid,
  localDateToday,
  localYearMonth,
  minorUnitDigits,
  parseAmountToMinor,
} from '../src/money.js';

/**
 * Money parsing. A wrong amount is a real money defect, so every ambiguous input
 * must be rejected rather than guessed, and formatting must never round a stored
 * value into a different one.
 */

describe('minor-unit parsing', () => {
  it('reads the currency exponent from the runtime instead of assuming two digits', () => {
    expect(minorUnitDigits('VND')).toBe(0);
    expect(minorUnitDigits('JPY')).toBe(0);
    expect(minorUnitDigits('USD')).toBe(2);
    expect(minorUnitDigits('NOT-A-CURRENCY')).toBe(2);
  });

  it('accepts plain and grouped digits for a zero-decimal currency', () => {
    expect(parseAmountToMinor('1250000', 'VND')).toEqual({ ok: true, minor: '1250000' });
    expect(parseAmountToMinor('1,250,000', 'VND')).toEqual({ ok: true, minor: '1250000' });
    expect(parseAmountToMinor('1 250 000', 'VND')).toEqual({ ok: true, minor: '1250000' });
  });

  it('refuses decimals a zero-decimal currency does not have', () => {
    expect(parseAmountToMinor('1250000.5', 'VND')).toMatchObject({ ok: false });
  });

  it('scales a two-decimal currency and keeps exact digits', () => {
    expect(parseAmountToMinor('1,250.5', 'USD')).toEqual({ ok: true, minor: '125050' });
    expect(parseAmountToMinor('0.01', 'USD')).toEqual({ ok: true, minor: '1' });
    expect(parseAmountToMinor('10', 'USD')).toEqual({ ok: true, minor: '1000' });
  });

  it('permits only amounts the contract can store (up to 19 minor digits)', () => {
    expect(parseAmountToMinor('9999999999999999999', 'VND')).toEqual({ ok: true, minor: '9999999999999999999' });
    expect(parseAmountToMinor('99999999999999999999', 'VND')).toMatchObject({ ok: false });
  });

  it('rejects empty, malformed and ambiguous input', () => {
    for (const input of ['', '   ', 'abc', '1.2.3', '1,23', '1e5', '12,3456']) {
      expect(parseAmountToMinor(input, 'VND')).toMatchObject({ ok: false });
    }
  });

  it('keeps an explicit negative sign for signed amounts and refuses negative zero', () => {
    expect(parseAmountToMinor('-250', 'VND')).toEqual({ ok: true, minor: '-250' });
    expect(parseAmountToMinor('-0', 'VND')).toMatchObject({ ok: false });
  });
});

describe('display formatting', () => {
  it('renders VND without invented decimals', () => {
    const rendered = formatMinor('2500000', 'VND');
    expect(rendered).toContain('2.500.000');
  });

  it('renders a negative amount with its sign intact in both the default and an explicit locale', () => {
    // The default locale is vi-VN, where the decimal separator is a comma.
    expect(formatMinor('-150', 'USD')).toMatch(/^-.*1[.,]50/);
    expect(formatMinor('-150', 'USD', 'en-US')).toBe('-$1.50');
  });

  it('falls back to the raw value when the amount is not an integer string', () => {
    expect(formatMinor('not-a-number', 'VND')).toBe('not-a-number VND');
  });

  it('renders zero exactly', () => {
    expect(formatMinor('0', 'VND')).toContain('0');
  });
});

describe('contract-shaped validation used by forms', () => {
  it('checks local dates, versions, categories and uuids the way the contracts do', () => {
    expect(isLocalDate('2026-10-12')).toBe(true);
    expect(isLocalDate('0000-01-01')).toBe(false);
    expect(isLocalDate('2026-1-1')).toBe(false);
    expect(isPositiveVersion('1')).toBe(true);
    expect(isPositiveVersion('0')).toBe(false);
    expect(isCategoryCode('daily_food')).toBe(true);
    expect(isCategoryCode('Daily')).toBe(false);
    expect(isCategoryCode('a')).toBe(false);
    expect(isUuid('8f14e45f-ceea-467f-a1b2-c0ffee123456')).toBe(true);
    expect(isUuid('nope')).toBe(false);
  });

  it('derives today and the current month from the local clock, not from UTC', () => {
    const moment = new Date(2026, 9, 12, 23, 30);
    expect(localDateToday(moment)).toBe('2026-10-12');
    expect(localYearMonth(moment)).toBe('2026-10');
  });
});
