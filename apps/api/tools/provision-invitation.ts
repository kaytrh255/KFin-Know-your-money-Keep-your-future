/**
 * Operator-audited invitation provisioning for local development.
 *
 * Milestone 04 deliberately exposes **no HTTP route** that mints or lists
 * invitations: codes reach users through the reviewed operator channel only
 * (DATABASE §4.2, SEC-AUTH-14). This script is that operator channel in its
 * local form. It calls the same `PostgresAuthRepository.issueInvitation` the
 * repository uses, so the code is generated, digested, and stored exactly as a
 * real invitation is; nothing about the production path is simulated.
 *
 * The plaintext code is printed once to the operator's terminal and is never
 * persisted — the database stores only a keyed digest. The database URL, the auth
 * secret, and every other credential are read from the environment and are never
 * echoed by this script.
 *
 * Usage:
 *   corepack pnpm run invite:provision
 *   corepack pnpm run invite:provision -- --email beta.user@example.invalid
 */

import { randomUUID } from 'node:crypto';
import { authPolicy, loadApiConfig } from '@kfin/config';
import { PostgresAuthRepository, createDatabaseRuntime } from '@kfin/database';

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

const config = loadApiConfig();
const runtime = createDatabaseRuntime(config.database);
const repository = new PostgresAuthRepository(runtime.pool, {
  secret: config.authSecret,
  policy: authPolicy,
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
