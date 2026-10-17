/**
 * Operator-audited invitation provisioning for local development.
 *
 * Milestone 04 deliberately exposes **no HTTP route** that mints or lists
 * invitations: codes reach users through the reviewed operator channel only
 * (DATABASE §4.2, SEC-AUTH-14). This script is that operator channel in its
 * local form. It uses `PostgresInvitationRepository`, the same code path an
 * operator deployment would use, so the code is generated, digested, and stored
 * exactly as a real invitation is; nothing about the production path is
 * simulated.
 *
 * The plaintext code is printed once to the operator's terminal and is never
 * persisted — the database stores only a keyed digest. The database URL, the auth
 * secret, and every other credential are read from the environment and are never
 * echoed by this script.
 *
 * This script uses its own privileged path: `OPERATOR_DATABASE_URL` must connect
 * as `kfin_operator`, which holds INSERT on `beta_invitations` and nothing else.
 * It never uses the API connection, and the API role has no invitation table
 * privilege at all (migration 0009).
 *
 * Usage:
 *   OPERATOR_DATABASE_URL=... AUTH_SECRET=... corepack pnpm run invite:provision
 *   corepack pnpm run invite:provision -- --email beta.user@example.invalid
 */

import { randomUUID } from 'node:crypto';
import { authPolicy } from '@kfin/config';
import {
  PostgresInvitationRepository,
  assertOperatorDatabaseRole,
  createDatabaseRuntime,
} from '@kfin/database';

/** Local operator marker: no operator registry exists, so a stable sentinel is used. */
const DEFAULT_OPERATOR_ID = '00000000-0000-4000-8000-0000000000aa';

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value.`);
  }
  return value;
}

const operatorUrl = process.env.OPERATOR_DATABASE_URL?.trim();
if (!operatorUrl) {
  console.error('OPERATOR_DATABASE_URL is required: an operator-role connection (kfin_operator).');
  process.exit(1);
}
const authSecret = process.env.AUTH_SECRET?.trim();
if (!authSecret || !/^[a-fA-F0-9]{64}$/.test(authSecret)) {
  console.error('AUTH_SECRET must be exactly 32 bytes encoded as 64 hexadecimal characters.');
  process.exit(1);
}
const sslMode = process.env.DATABASE_SSL_MODE === 'disable' ? 'disable' : 'verify-full';
const runtime = createDatabaseRuntime({ url: operatorUrl, sslMode, poolMaximum: 1 });
await assertOperatorDatabaseRole(runtime.pool);
const repository = new PostgresInvitationRepository(runtime.pool, {
  secret: authSecret,
  policy: {
    codeEntropyBytes: authPolicy.invitation.codeEntropyBytes,
    codeGroupLength: authPolicy.invitation.codeGroupLength,
    defaultLifetimeMs: authPolicy.invitation.defaultLifetimeMs,
  },
});

const invitedEmail = option('email');
const operatorId = option('operator') ?? DEFAULT_OPERATOR_ID;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operatorId)) {
  throw new Error('--operator must be a UUID.');
}

try {
  const issued = await repository.issueInvitation({
    ...(invitedEmail === null ? {} : { invitedEmail }),
    createdByOperatorId: operatorId,
    correlationId: randomUUID(),
  });

  // The code below is the only secret this script reveals, by design and once.
  console.log('Invitation issued. Deliver this code through the approved operator channel.');
  console.log(`  invitation id : ${issued.invitationId}`);
  console.log(`  expires at    : ${issued.expiresAt}`);
  console.log(`  invited email : ${invitedEmail ?? '(unbound)'}`);
  console.log(`  code          : ${issued.code}`);
  console.log('');
  console.log('The code is stored only as a digest and cannot be read back.');
} finally {
  await runtime.pool.end();
}
