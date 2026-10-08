import { hash, verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id` from `@node-rs/argon2`. The package publishes an ambient
 * const enum, which cannot be read as a value under `verbatimModuleSyntax`. The
 * numeric value is pinned here and the encoded record is re-checked against the
 * `$argon2id$` prefix on every read (`ENCODED_PARAMETERS`).
 */
const ARGON2ID: Algorithm = 2;

/**
 * Argon2id password hashing (SEC-AUTH-01).
 *
 * Parameters are candidate OWASP-aligned values supplied by `authPolicy`; they
 * are not approved policy until `SPEC-AUTH-02` records a benchmark on production
 * hardware. Rehashing on login is supported when a stored record predates the
 * current policy version.
 */

export interface Argon2Parameters {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export interface PasswordHashPolicy extends Argon2Parameters {
  readonly hashPolicyVersion: number;
}

export interface PasswordVerification {
  readonly valid: boolean;
  readonly needsRehash: boolean;
  readonly parameters: Argon2Parameters | null;
}

const ENCODED_PARAMETERS = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/;

export async function hashPassword(password: string, policy: PasswordHashPolicy): Promise<string> {
  return hash(password, {
    algorithm: ARGON2ID,
    memoryCost: policy.memoryCost,
    timeCost: policy.timeCost,
    parallelism: policy.parallelism,
  });
}

export async function verifyPassword(
  encoded: string,
  password: string,
  policy: PasswordHashPolicy,
): Promise<PasswordVerification> {
  let valid = false;
  try {
    valid = await verify(encoded, password, { algorithm: ARGON2ID });
  } catch {
    // A malformed or unsupported stored record is a failed verification, never a
    // thrown provider error: the caller must not learn why verification failed.
    valid = false;
  }
  const parameters = readParameters(encoded);
  return {
    valid,
    needsRehash: valid && !matchesPolicy(parameters, policy),
    parameters,
  };
}

/**
 * Constant-ish work for unknown accounts. Login performs the same Argon2id
 * verification against a decoy record so a missing account is not distinguishable
 * by response time (SEC-AUTH-04).
 */
export async function decoyVerification(password: string, policy: PasswordHashPolicy): Promise<void> {
  await verifyPassword(await decoyHash(policy), password, policy);
}

export function readParameters(encoded: string): Argon2Parameters | null {
  const match = ENCODED_PARAMETERS.exec(encoded);
  if (!match) return null;
  return {
    memoryCost: Number(match[1]),
    timeCost: Number(match[2]),
    parallelism: Number(match[3]),
  };
}

export function matchesPolicy(
  parameters: Argon2Parameters | null,
  policy: PasswordHashPolicy,
): boolean {
  if (!parameters) return false;
  return (
    parameters.memoryCost === policy.memoryCost
    && parameters.timeCost === policy.timeCost
    && parameters.parallelism === policy.parallelism
  );
}

let decoy: Promise<string> | null = null;

function decoyHash(policy: PasswordHashPolicy): Promise<string> {
  decoy ??= hashPassword('kfin-decoy-credential-not-a-user-password', policy);
  return decoy;
}
