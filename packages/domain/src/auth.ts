/**
 * Trusted Private Beta access — pure domain rules.
 *
 * Trace: PRD-AUTH-01..09, SEC-AUTH-01..17, SEC-SES-01..10, SEC-ABUSE-01..09,
 * ADR-002, ADR-004, ADR-008, DATABASE §§4.2-4.7.
 *
 * This module contains no persistence and no policy constants of its own; every
 * bound is supplied by the caller so candidate values stay visible in
 * `packages/config`. Values are not approved policy: `SPEC-AUTH-01`,
 * `SPEC-AUTH-02`, and `SPEC-SEC-02` remain OPEN.
 */

import { randomBytes, randomInt } from 'node:crypto';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MINIMUM_EMAIL_LENGTH = 3;
const MAXIMUM_EMAIL_LENGTH = 320;

// Crockford base32 without the ambiguous I/L/O/U characters. Codes are displayed
// in groups so a human can read them once from the operator channel.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE32_CROCKFORD_PATTERN = /^[0-9A-HJKMNP-TV-Z]+$/;

export interface NormalizedEmail {
  /** Presentation form preserved as trimmed user input. */
  readonly email: string;
  /** Comparison form: lowercase, Unicode NFKC, dot/plus policy free. */
  readonly emailNormalized: string;
  /** Local part of the normalized address, used for password similarity checks. */
  readonly localPart: string;
}

export function normalizeEmail(value: string): NormalizedEmail | null {
  const email = value.trim();
  if (email.length < MINIMUM_EMAIL_LENGTH || email.length > MAXIMUM_EMAIL_LENGTH) return null;
  if (!EMAIL_PATTERN.test(email)) return null;
  const emailNormalized = email.toLocaleLowerCase('en-US').normalize('NFKC');
  if (!EMAIL_PATTERN.test(emailNormalized)) return null;
  const at = emailNormalized.lastIndexOf('@');
  const localPart = emailNormalized.slice(0, at);
  return { email, emailNormalized, localPart };
}

export function isValidEmail(value: string): boolean {
  return normalizeEmail(value) !== null;
}

/**
 * Passwords are normalized, never silently truncated: a password longer than the
 * approved maximum is rejected so the stored credential always matches what the
 * user typed (SEC-AUTH-03). NFKC keeps composed/equivalent input comparable while
 * preserving the submitted characters.
 */
export function normalizePassword(value: string): string {
  return value.normalize('NFKC');
}

export type PasswordPolicyViolation =
  | 'password_required'
  | 'password_too_short'
  | 'password_too_long'
  | 'password_too_common'
  | 'password_similar_to_email';

export interface PasswordPolicyBounds {
  readonly minimumLength: number;
  readonly maximumLength: number;
}

/**
 * Offline, privacy-preserving common-password rejection. No third party, no
 * k-anonymity query, no transmission of a candidate password: privacy review of
 * an external breach service is still an OPEN item, so the MVP candidate uses a
 * small built-in denylist plus email-similarity checks.
 */
const COMMON_PASSWORDS: readonly string[] = [
  '123456789012',
  '1234567890123',
  'password1234',
  'password12345',
  'matkhau123456',
  'matkhau1234567',
  'kfin12345678',
  'qwerty123456',
  'qwertyuiop123',
  'iloveyou12345',
  'letmein123456',
  'admin12345678',
  'welcome123456',
  'abc123456789',
  '111111111111',
  '000000000000',
  'aaaaaaaaaaaa',
  'changeme12345',
  'trustno112345',
  'monkey1234567',
  'dragon1234567',
  'sunshine12345',
  'princess12345',
  'football12345',
  'baseball12345',
  'whatever12345',
  'starwars12345',
  'hanoi12345678',
  'vietnam123456',
  'hochiminh1234',
  '123456789a123',
  'passw0rd12345',
];

export function validatePassword(
  value: string,
  bounds: PasswordPolicyBounds,
  email?: NormalizedEmail,
): readonly PasswordPolicyViolation[] {
  const password = normalizePassword(value);
  if (password.length === 0) return ['password_required'];
  const violations: PasswordPolicyViolation[] = [];
  if (password.length < bounds.minimumLength) violations.push('password_too_short');
  if (password.length > bounds.maximumLength) violations.push('password_too_long');
  const candidate = password.toLocaleLowerCase('en-US');
  if (COMMON_PASSWORDS.some((common) => candidate === common)) {
    violations.push('password_too_common');
  }
  if (email) {
    const localPart = email.localPart;
    if (
      localPart.length >= 4
      && (candidate.includes(localPart) || candidate.includes(email.emailNormalized))
    ) {
      violations.push('password_similar_to_email');
    }
  }
  return violations;
}

export function generateNumericOtp(digits: number): string {
  if (digits < 4 || digits > 10) throw new RangeError('OTP digit count is outside the supported range.');
  const maximum = 10 ** digits;
  return String(randomInt(0, maximum)).padStart(digits, '0');
}

export function generateUrlToken(entropyBytes: number, random: (size: number) => Buffer = defaultRandomBytes): string {
  if (entropyBytes < 16) throw new RangeError('Token entropy is below the 128-bit minimum.');
  return random(entropyBytes).toString('base64url');
}

export function generateInvitationCode(
  entropyBytes: number,
  groupLength: number,
  random: (size: number) => Buffer = defaultRandomBytes,
): string {
  if (entropyBytes < 16) throw new RangeError('Invitation code entropy is below the 128-bit minimum.');
  if (groupLength < 4) throw new RangeError('Invitation code groups are too small to read.');
  const bytes = random(entropyBytes);
  let bits = 0;
  let value = 0;
  let encoded = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += CODE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += CODE_ALPHABET[(value << (5 - bits)) & 31];
  return group(encoded, groupLength);
}

export function isWellFormedInvitationCode(code: string, groupLength: number): boolean {
  const groups = code.trim().toUpperCase().split('-');
  if (groups.length < 2) return false;
  return groups.every((part) => part.length === groupLength && BASE32_CROCKFORD_PATTERN.test(part));
}

export function normalizeInvitationCode(code: string): string {
  // Crockford base32: the alphabet already excludes I/L/O/U, so only case and
  // separator whitespace are normalized. No character is silently remapped.
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

export type AuthEventType =
  | 'registration_requested'
  | 'verification_challenge_issued'
  | 'verification_challenge_failed'
  | 'email_verified'
  | 'login_succeeded'
  | 'login_failed'
  | 'logout'
  | 'logout_all'
  | 'session_revoked'
  | 'password_changed'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'password_reset_failed'
  | 'session_token_rotated'
  | 'session_token_replay_detected'
  | 'session_expired'
  | 'access_denied_unverified';

export type AuthEventVisibility = 'user' | 'operator' | 'both';

/**
 * Candidate visibility classification. `SPEC-SEC-02` must approve the final
 * user/operator/both/none table; this mapping exists so the API can expose only
 * user-visible rows and so no raw metadata ever reaches a client.
 */
const EVENT_VISIBILITY: Record<AuthEventType, AuthEventVisibility> = {
  registration_requested: 'both',
  verification_challenge_issued: 'operator',
  verification_challenge_failed: 'operator',
  email_verified: 'user',
  login_succeeded: 'user',
  login_failed: 'user',
  logout: 'user',
  logout_all: 'user',
  session_revoked: 'user',
  password_changed: 'user',
  password_reset_requested: 'user',
  password_reset_completed: 'user',
  password_reset_failed: 'operator',
  session_token_rotated: 'operator',
  session_token_replay_detected: 'user',
  session_expired: 'operator',
  access_denied_unverified: 'operator',
};

export function eventVisibility(type: AuthEventType): AuthEventVisibility {
  return EVENT_VISIBILITY[type];
}

export function isUserVisibleEvent(type: AuthEventType): boolean {
  return EVENT_VISIBILITY[type] !== 'operator';
}

export type AuthEventOutcome = 'success' | 'failure' | 'blocked';

export type AbuseScopeKind =
  | 'login_target'
  | 'login_ip'
  | 'verification_target'
  | 'verification_ip'
  | 'reset_target'
  | 'reset_ip'
  | 'registration_ip';

export interface AbuseWindow {
  readonly windowMs: number;
  readonly start: number;
}

/** Fixed-window bucketing: counters cannot grow without bound (SEC-ABUSE-08). */
export function abuseWindowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

export function isWithinCooldown(lastIssuedAt: number | null, now: number, cooldownMs: number): boolean {
  if (lastIssuedAt === null) return false;
  return now - lastIssuedAt < cooldownMs;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Bounded, privacy-approved device summary. The whole parsed agent string is
 * never stored and never returned (SEC-SES-10, SEC-LOG-02).
 */
export function summarizeDeviceLabel(userAgent: string | undefined | null): string | null {
  if (!userAgent) return null;
  const trimmed = userAgent.trim();
  if (trimmed.length === 0) return null;
  const family = /^([A-Za-z][A-Za-z0-9_.-]{2,24})/.exec(trimmed)?.[1] ?? null;
  const platform = /\(([^)]{0,80})\)/.exec(trimmed)?.[1] ?? null;
  const label = [family, platform].filter((part): part is string => Boolean(part)).join(' ');
  if (label.length === 0) return null;
  return label.slice(0, 120);
}

export function isSupportedLocale(value: string): boolean {
  try {
    new Intl.Locale(value);
    return value.length <= 35;
  } catch {
    return false;
  }
}

function group(value: string, size: number): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    parts.push(value.slice(index, index + size));
  }
  return parts.join('-');
}

function defaultRandomBytes(size: number): Buffer {
  return randomBytes(size);
}
