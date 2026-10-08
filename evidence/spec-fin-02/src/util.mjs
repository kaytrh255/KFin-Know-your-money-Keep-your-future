import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delayTimer } from 'node:timers/promises';

export function uuid() {
  return randomUUID();
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function safeToken(prefix = 'corr') {
  return `${prefix}-${randomBytes(9).toString('hex')}`;
}

export function syntheticEmailToken() {
  return `synthetic-${randomBytes(6).toString('hex')}`;
}

export function randomBackoffMs(minimum, maximum) {
  return randomInt(minimum, maximum + 1);
}

export async function delay(milliseconds, options = {}) {
  await delayTimer(milliseconds, undefined, options);
}

export function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function withTimeout(promise, milliseconds, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1);
  return Number(ordered[Math.max(0, index)].toFixed(3));
}

export function monotonicMs() {
  return performance.now();
}

export function elapsedMs(startedAt) {
  return Number((monotonicMs() - startedAt).toFixed(3));
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function invariant(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.name = 'EvidenceAssertionError';
    if (details !== undefined) error.details = details;
    throw error;
  }
}

export function errorSummary(error) {
  return {
    name: error?.name ?? 'Error',
    message: String(error?.message ?? error),
    sqlstate: error?.code ?? null,
  };
}

export function stableStringify(value) {
  return JSON.stringify(sortObject(value), null, 2);
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortObject(child)]),
    );
  }
  return value;
}

export function parseInteger(value, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function sanitizeErrorForArtifact(error) {
  const message = String(error?.message ?? error)
    .replaceAll(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]')
    .replaceAll(/password\s*[=:]\s*[^\s,;]+/gi, 'password=[REDACTED]');
  return {
    name: error?.name ?? 'Error',
    message,
    sqlstate: error?.code ?? null,
  };
}
