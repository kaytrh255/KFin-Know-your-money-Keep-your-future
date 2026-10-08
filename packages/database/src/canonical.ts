import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function digestSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
