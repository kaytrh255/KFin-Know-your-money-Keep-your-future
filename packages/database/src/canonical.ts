import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export function digestSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Domain-separated keyed digest.
 *
 * Numeric OTP and reset secrets carry little entropy, so an unsalted fast hash
 * would be offline-guessable. Every stored secret digest is therefore an HMAC
 * under a purpose-specific key derived from the server secret
 * (SEC-AUTH-05, SEC-AUTH-06, SEC-AUTH-14, SEC-ABUSE-08).
 */
export function keyedDigest(secret: string, purpose: string, value: string): Buffer {
  return createHmac('sha256', derivePurposeKey(secret, purpose)).update(value, 'utf8').digest();
}

export function keyedDigestHex(secret: string, purpose: string, value: string): string {
  return keyedDigest(secret, purpose, value).toString('hex');
}

export function derivePurposeKey(secret: string, purpose: string): Buffer {
  const material = Buffer.from(secret, 'hex');
  const derived = Buffer.from(
    hkdfSync('sha256', material, Buffer.from('kfin.auth.v1', 'utf8'), Buffer.from(purpose, 'utf8'), 32),
  );
  return derived;
}

export function constantTimeBufferEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function digestCanonicalRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function signCanonicalPayload(value: unknown, key: string | Buffer): string {
  return createHmac('sha256', key).update(canonicalJson(value), 'utf8').digest('hex');
}

export function verifyCanonicalPayload(
  value: unknown,
  signature: string,
  key: string | Buffer,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signCanonicalPayload(value, key), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalize);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, normalize(record[key])]),
  );
}
