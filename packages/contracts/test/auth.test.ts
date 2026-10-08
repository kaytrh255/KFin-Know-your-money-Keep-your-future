import { describe, expect, it } from 'vitest';
import {
  changePasswordBodySchema,
  csrfHeadersSchema,
  invitationCodeSchema,
  loginBodySchema,
  loginResponseSchema,
  meResponseSchema,
  passwordResetBodySchema,
  registerBodySchema,
  registerResponseSchema,
  securityEventListResponseSchema,
  sessionListResponseSchema,
  verifyEmailBodySchema,
  verifyEmailResponseSchema,
} from '../src/index.js';

const SESSION = {
  id: '00000000-0000-4000-8000-000000000001',
  clientType: 'web',
  createdAt: '2026-10-08T02:00:00.000Z',
  lastSeenAt: '2026-10-08T02:05:00.000Z',
  idleExpiresAt: '2026-11-07T02:00:00.000Z',
  absoluteExpiresAt: '2027-01-06T02:00:00.000Z',
  deviceLabel: null,
  current: true,
};

const validRegistration = {
  email: 'beta.user@example.invalid',
  password: 'correct-horse-battery',
  invitationCode: 'ABCDEFGH-JKMNPQRS-TVWXYZ23-456789AB',
  locale: 'vi-VN',
  timezone: 'Asia/Ho_Chi_Minh',
  baseCurrency: 'VND',
};

describe('trusted beta access request contracts', () => {
  it('accepts a registration carrying an invitation code and profile bounds', () => {
    const parsed = registerBodySchema.parse(validRegistration);
    expect(parsed.invitationCode).toBe('ABCDEFGH-JKMNPQRS-TVWXYZ23-456789AB');
    expect(parsed.baseCurrency).toBe('VND');
  });

  it('normalizes a lower-case invitation code but rejects malformed groups', () => {
    expect(invitationCodeSchema.parse('abcdefgh-jkmnpqrs-tvwxyz23-456789ab')).toBe(
      'ABCDEFGH-JKMNPQRS-TVWXYZ23-456789AB',
    );
    expect(() => invitationCodeSchema.parse('ABCDEFGH-JKMNPQRS-TVWXYZ23')).toThrow();
    expect(() => invitationCodeSchema.parse('ABCDEFGH-JKMNPQRS-TVWXYZ23-IIIIIIII')).toThrow();
  });

  it('rejects unknown, alias, and authority fields in access bodies', () => {
    expect(() => registerBodySchema.parse({ ...validRegistration, userId: 'self' })).toThrow();
    expect(() => registerBodySchema.parse({ ...validRegistration, role: 'admin' })).toThrow();
    expect(() => registerBodySchema.parse({ ...validRegistration, status: 'active' })).toThrow();
    expect(() => loginBodySchema.parse({
      email: 'beta.user@example.invalid',
      password: 'value',
      emailVerified: true,
    })).toThrow();
  });

  it('accepts only the six-digit OTP shape and never a stored presentation alias', () => {
    expect(verifyEmailBodySchema.parse({
      email: 'beta.user@example.invalid',
      oneTimeCode: '012345',
    })).toEqual({ email: 'beta.user@example.invalid', oneTimeCode: '012345' });
    expect(() => verifyEmailBodySchema.parse({
      email: 'beta.user@example.invalid',
      oneTimeCode: '12345',
    })).toThrow();
    expect(() => verifyEmailBodySchema.parse({
      email: 'beta.user@example.invalid',
      oneTimeCode: 'verified',
    })).toThrow();
  });

  it('accepts a high-entropy reset secret and rejects a short guess', () => {
    const secret = 'a'.repeat(43);
    expect(passwordResetBodySchema.parse({
      email: 'beta.user@example.invalid',
      resetSecret: secret,
      newPassword: 'another-good-passphrase',
    }).resetSecret).toBe(secret);
    expect(() => passwordResetBodySchema.parse({
      email: 'beta.user@example.invalid',
      resetSecret: 'short',
      newPassword: 'another-good-passphrase',
    })).toThrow();
  });

  it('keeps the CSRF header open to transport headers while requiring the token', () => {
    expect(csrfHeadersSchema.parse({
      'x-kfin-csrf': 'token-value-0123456789',
      host: 'api.kfin.test',
      'content-type': 'application/json',
    })['x-kfin-csrf']).toBe('token-value-0123456789');
    expect(() => csrfHeadersSchema.parse({ host: 'api.kfin.test' })).toThrow();
  });
});

describe('trusted beta access response contracts', () => {
  it('returns no secret-bearing field from registration', () => {
    const response = registerResponseSchema.parse({
      accepted: true,
      resendAvailableAt: '2026-10-08T02:01:00.000Z',
    });
    expect(Object.keys(response)).toEqual(['accepted', 'resendAvailableAt']);
  });

  it('exposes the CSRF token once in the body and never the session bearer token', () => {
    const serialized = JSON.stringify(verifyEmailResponseSchema.parse({
      userId: '00000000-0000-4000-8000-000000000002',
      status: 'active',
      session: SESSION,
      csrfToken: 'csrf-token-value-0123456789',
    }));
    expect(serialized).toContain('csrfToken');
    expect(serialized).not.toContain('sessionToken');
    expect(() => verifyEmailResponseSchema.parse({
      userId: '00000000-0000-4000-8000-000000000002',
      status: 'active',
      session: SESSION,
      csrfToken: 'csrf-token-value-0123456789',
      sessionToken: 'bearer-value',
    })).toThrow();
  });

  it('keeps login, session list, and security history free of secrets and financial payloads', () => {
    const login = JSON.stringify(loginResponseSchema.parse({
      userId: '00000000-0000-4000-8000-000000000002',
      session: SESSION,
      csrfToken: 'csrf-token-value-0123456789',
    }));
    expect(login).not.toMatch(/password|oneTimeCode|resetSecret|token_digest/i);

    const sessions = sessionListResponseSchema.parse({ items: [SESSION], nextCursor: null });
    expect(sessions.items[0]?.deviceLabel).toBeNull();

    const events = securityEventListResponseSchema.parse({
      items: [{
        id: '00000000-0000-4000-8000-000000000003',
        eventType: 'login_succeeded',
        outcome: 'success',
        occurredAt: '2026-10-08T02:00:00.000Z',
        sessionId: SESSION.id,
      }],
      nextCursor: null,
    });
    expect(Object.keys(events.items[0] ?? {})).toEqual([
      'id',
      'eventType',
      'outcome',
      'occurredAt',
      'sessionId',
    ]);
  });

  it('never accepts a persistence state alias as a response status', () => {
    expect(() => loginResponseSchema.parse({
      userId: '00000000-0000-4000-8000-000000000002',
      session: SESSION,
      csrfToken: 'csrf-token-value-0123456789',
      status: 'verified',
    })).toThrow();
  });

  it('exposes only profile and session context through the principal view', () => {
    const parsed = meResponseSchema.parse({
      userId: '00000000-0000-4000-8000-000000000002',
      email: 'beta.user@example.invalid',
      status: 'active',
      emailVerifiedAt: '2026-10-08T02:00:00.000Z',
      displayName: null,
      locale: 'vi-VN',
      timezone: 'Asia/Ho_Chi_Minh',
      baseCurrency: 'VND',
      session: SESSION,
    });
    expect(parsed.status).toBe('active');
    expect(Object.keys(parsed)).not.toContain('passwordHash');
  });

  it('requires current and new passwords for a known-password change', () => {
    expect(changePasswordBodySchema.parse({
      currentPassword: 'current-passphrase-value',
      newPassword: 'next-passphrase-value-1',
    }).newPassword).toBe('next-passphrase-value-1');
    expect(() => changePasswordBodySchema.parse({ newPassword: 'next-passphrase-value-1' })).toThrow();
  });
});
