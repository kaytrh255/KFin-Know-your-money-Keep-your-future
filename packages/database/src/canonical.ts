import { createHash } from 'node:crypto';

export function digestSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function digestCanonicalRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
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
