import { describe, expect, it } from 'vitest';
import {
  abuseWindowStart,
  clampIdleExpiry,
  constantTimeEqual,
  eventVisibility,
  generateInvitationCode,
  generateNumericOtp,
  generateUrlToken,
  isUserVisibleEvent,
  isWellFormedInvitationCode,
  normalizeEmail,
  normalizeInvitationCode,
  normalizePassword,
  summarizeDeviceLabel,
  validatePassword,
} from '../src/index.js';

const BOUNDS = { minimumLength: 12, maximumLength: 128 };

describe('email normalization', () => {
  it('preserves presentation and produces one comparison form', () => {
    const normalized = normalizeEmail('  Beta.User@Example.INVALID ');
    expect(normalized).toMatchObject({
      email: 'Beta.User@Example.INVALID',
      emailNormalized: 'beta.user@example.invalid',
      localPart: 'beta.user',
    });
  });

  it('rejects malformed and oversized addresses', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail(`${'a'.repeat(320)}@example.invalid`)).toBeNull();
  });
});

describe('password policy', () => {
  it('accepts a long passphrase and normalizes without truncating', () => {
    const password = 'correct horse battery staple '.repeat(2);
    expect(normalizePassword(password).length).toBe(password.length);
    expect(validatePassword(password, BOUNDS)).toEqual([]);
  });

  it('reports short, oversized, common, and email-similar passwords', () => {
    expect(validatePassword('short', BOUNDS)).toContain('password_too_short');
    expect(validatePassword('a'.repeat(129), BOUNDS)).toContain('password_too_long');
    expect(validatePassword('password1234', BOUNDS)).toContain('password_too_common');
    const email = normalizeEmail('beta.user@example.invalid');
    expect(validatePassword('Beta.user-2026!', BOUNDS, email!)).toContain('password_similar_to_email');
  });

  it('never reports success for an empty password', () => {
    expect(validatePassword('', BOUNDS)).toEqual(['password_required']);
  });
});

describe('secret generation', () => {
  it('generates fixed-width numeric OTPs', () => {
    for (let index = 0; index < 25; index += 1) {
      expect(generateNumericOtp(6)).toMatch(/^[0-9]{6}$/);
    }
  });

  it('generates high-entropy URL tokens and invitation codes', () => {
    const token = generateUrlToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(generateUrlToken(32));
    const code = generateInvitationCode(20, 8);
    expect(code.split('-')).toHaveLength(4);
    expect(isWellFormedInvitationCode(code, 8)).toBe(true);
    expect(code).not.toBe(generateInvitationCode(20, 8));
  });

  it('normalizes invitation code case and whitespace without remapping characters', () => {
    expect(normalizeInvitationCode(' abcdefgh-jkmnpqrs ')).toBe('ABCDEFGH-JKMNPQRS');
    expect(isWellFormedInvitationCode('ABCDEFGH', 8)).toBe(false);
  });

  it('rejects entropy below the 128-bit minimum', () => {
    expect(() => generateUrlToken(8)).toThrow(RangeError);
    expect(() => generateInvitationCode(8, 8)).toThrow(RangeError);
  });
});

describe('security-history visibility', () => {
  it('hides operator-only challenge delivery events from the user', () => {
    expect(eventVisibility('verification_challenge_issued')).toBe('operator');
    expect(isUserVisibleEvent('verification_challenge_issued')).toBe(false);
    expect(isUserVisibleEvent('login_succeeded')).toBe(true);
    expect(eventVisibility('password_reset_completed')).toBe('user');
  });
});

describe('abuse controls', () => {
  it('buckets attempts into fixed windows so counters cannot grow unbounded', () => {
    const windowMs = 15 * 60 * 1_000;
    expect(abuseWindowStart(0, windowMs)).toBe(0);
    expect(abuseWindowStart(windowMs - 1, windowMs)).toBe(0);
    expect(abuseWindowStart(windowMs, windowMs)).toBe(windowMs);
  });
});

describe('session lifetime clamping', () => {
  const HOUR = 60 * 60 * 1_000;
  const now = Date.UTC(2026, 9, 8, 2, 0, 0);

  it('renews the idle window normally while it stays inside the absolute expiry', () => {
    expect(clampIdleExpiry(now, 30 * 24 * HOUR, now + 90 * 24 * HOUR)).toBe(now + 30 * 24 * HOUR);
  });

  it('never renews the idle window past the absolute expiry', () => {
    const absolute = now + 5 * HOUR;
    expect(clampIdleExpiry(now, 30 * 24 * HOUR, absolute)).toBe(absolute);
    // A renewal at the very end of the absolute window still cannot extend it.
    expect(clampIdleExpiry(absolute - 1, 30 * 24 * HOUR, absolute)).toBe(absolute);
  });

  it('accepts the absolute expiry as a Date or as an epoch value', () => {
    const absolute = new Date(now + 2 * HOUR);
    expect(clampIdleExpiry(now, 24 * HOUR, absolute)).toBe(absolute.getTime());
    expect(clampIdleExpiry(now, 24 * HOUR, absolute.getTime())).toBe(absolute.getTime());
  });

  it('does not move the absolute expiry backwards when it has already passed', () => {
    const absolute = now - HOUR;
    expect(clampIdleExpiry(now, 24 * HOUR, absolute)).toBe(absolute);
  });
});

describe('safe presentation helpers', () => {
  it('summarizes a device without storing a whole agent string', () => {
    const label = summarizeDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605.1');
    expect(label).toBe('Mozilla iPhone; CPU iPhone OS 17_0');
    expect(summarizeDeviceLabel('   ')).toBeNull();
    expect(summarizeDeviceLabel(undefined)).toBeNull();
  });

  it('compares secrets without leaking length early', () => {
    expect(constantTimeEqual('value-123', 'value-123')).toBe(true);
    expect(constantTimeEqual('value-123', 'value-124')).toBe(false);
    expect(constantTimeEqual('short', 'value-123')).toBe(false);
  });
});
