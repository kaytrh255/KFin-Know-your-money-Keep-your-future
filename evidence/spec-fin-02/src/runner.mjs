import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { CASE_IDS, FROZEN_SOURCE_COMMIT, RESULT_STATUS } from './constants.mjs';
import { PG_DRIVER_VERSION, TracedPool } from './db.mjs';
import { EvidenceRecorder } from './evidence.mjs';
import { FinancialProtocol } from './protocol.mjs';
import {
  dropEvidenceSchema,
  migrationMetadata,
  resetEvidenceSchema,
  verifyEvidenceSchema,
} from './schema.mjs';
import {
  runFinRace01,
  runFinRace02,
  runFinRace03,
  runFinRace04,
  runFinRace05,
} from './cases/races-01-05.mjs';
import { runFinRace06 } from './cases/fin-race-06.mjs';
import { runFinRace07 } from './cases/fin-race-07.mjs';
import { runFinRace08 } from './cases/fin-race-08.mjs';

const AUTHORITATIVE_DOCS = [
  'docs/architecture/SPEC-FIN-02-SNAPSHOT-CONCURRENCY.md',
  'docs/architecture/DATABASE.md',
  'docs/testing/TEST-STRATEGY.md',
  'docs/architecture/ADR/ADR-009-per-account-financial-serialization.md',
  'docs/governance/APPROVAL-AND-EVIDENCE-REGISTER.md',
];

const CASE_RUNNERS = new Map([
  ['FIN-RACE-01', runFinRace01],
  ['FIN-RACE-02', runFinRace02],
  ['FIN-RACE-03', runFinRace03],
  ['FIN-RACE-04', runFinRace04],
  ['FIN-RACE-05', runFinRace05],
  ['FIN-RACE-06', runFinRace06],
  ['FIN-RACE-07', runFinRace07],
  ['FIN-RACE-08', runFinRace08],
]);

export async function runEvidence(config) {
  verifyFrozenAuthoritativeDocs();
  const migration = await migrationMetadata();
  const harnessCommit = gitHarnessCommit();
  const recorder = new EvidenceRecorder({
    sourceCommit: FROZEN_SOURCE_COMMIT,
    harnessCommit,
    migrationVersion: migration.version,
    migrationSha256: migration.sha256,
    nodeVersion: process.version,
    testRunnerVersion: `node:test/${process.version}`,
    driverName: 'pg',
    driverVersion: PG_DRIVER_VERSION,
    endpoint: config.endpointMetadata,
    pool: { max: config.poolMax, idleTimeoutMs: 10_000, connectionTimeoutMs: 10_000 },
    schema: config.schema,
    repetitionsPerOrder: config.repetitions,
    cleanupReserveMs: config.cleanupReserveMs,
    startedAt: new Date().toISOString(),
  }, {
    redactLiterals: [config.parsedEndpoint?.hostname]
      .filter((value) => typeof value === 'string' && value.length >= 4),
    redactUsernames: [config.parsedEndpoint?.username].filter(Boolean),
  });

  for (const caseId of CASE_IDS) {
    if (!config.selectedCases.includes(caseId)) recorder.notRunCase(caseId, 'Not selected by this run.');
  }

  if (!config.databaseUrl) {
    for (const caseId of config.selectedCases) {
      recorder.blockCase(caseId, 'DATABASE_URL is absent; no PostgreSQL behavior was executed.');
    }
    const artifact = await recorder.write(config.outputRoot, config.runToken);
    return { ...artifact, exitCode: 2 };
  }
  if (!config.nonProductionConfirmed) {
    for (const caseId of config.selectedCases) {
      recorder.blockCase(
        caseId,
        'KFIN_EVIDENCE_TARGET=non-production is required before any database connection.',
      );
    }
    const artifact = await recorder.write(config.outputRoot, config.runToken);
    return { ...artifact, exitCode: 2 };
  }

  let pool;
  let schemaCreated = false;
  try {
    if (config.resetBeforeRun) {
      await resetEvidenceSchema(config, recorder);
      schemaCreated = true;
    } else {
      await verifyEvidenceSchema(config);
      schemaCreated = true;
    }
    pool = new TracedPool(config, recorder);
    const metadata = await pool.metadata();
    recorder.metadata.postgresqlVersion = metadata.serverVersion;
    recorder.metadata.postgresqlVersionNum = metadata.serverVersionNum;
    recorder.metadata.defaultIsolation = metadata.defaultIsolation;
    recorder.metadata.backendPidObserved = metadata.backendPidObserved;
    recorder.event('environment.verified', {
      provider: config.endpointMetadata.provider,
      serverVersion: metadata.serverVersion,
      poolMode: config.poolMode,
      schema: config.schema,
    });

    const protocol = new FinancialProtocol({ pool, recorder, config });
    const context = { config, pool, protocol, recorder };
    for (const caseId of config.selectedCases) {
      const runCase = CASE_RUNNERS.get(caseId);
      try {
        await runCase(context);
      } catch (error) {
        recorder.failCase(caseId, error, {
          reproduction: reproductionCommand(caseId, config),
        });
      }
    }
  } catch (error) {
    for (const caseId of config.selectedCases) {
      const result = recorder.results.get(caseId);
      if (!result.executed && result.status !== RESULT_STATUS.BLOCKED) {
        recorder.blockCase(caseId, `Environment/setup failure: ${error.message}`);
      }
    }
    recorder.event('environment.failure', {
      name: error.name,
      message: error.message,
      code: error.code ?? null,
    });
  } finally {
    await pool?.end().catch(() => {});
    if (schemaCreated && !config.keepSchema) {
      await dropEvidenceSchema(config, recorder).catch((error) => {
        recorder.event('schema.cleanup_failure', { name: error.name, message: error.message });
      });
    }
  }

  const artifact = await recorder.write(config.outputRoot, config.runToken);
  return { ...artifact, exitCode: exitCodeFor(artifact.summary.overall) };
}

export async function setupEvidenceSchema(config) {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is absent; schema setup was not executed');
  if (!config.nonProductionConfirmed) {
    throw new Error('KFIN_EVIDENCE_TARGET=non-production is required before schema setup');
  }
  verifyFrozenAuthoritativeDocs();
  return resetEvidenceSchema(config);
}

export async function removeEvidenceSchema(config) {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is absent; schema reset was not executed');
  if (!config.nonProductionConfirmed) {
    throw new Error('KFIN_EVIDENCE_TARGET=non-production is required before schema removal');
  }
  return dropEvidenceSchema(config);
}

export function verifyFrozenAuthoritativeDocs() {
  for (const file of AUTHORITATIVE_DOCS) {
    const frozen = execFileSync('git', ['show', `${FROZEN_SOURCE_COMMIT}:${file}`]);
    const current = fs.readFileSync(file);
    if (!frozen.equals(current)) {
      throw new Error(`Authoritative document differs from frozen commit: ${file}`);
    }
  }
}

function gitHarnessCommit() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  return dirty ? `${head}+dirty` : head;
}

function reproductionCommand(caseId, config) {
  return `corepack pnpm run evidence:case -- --case ${caseId} --repetitions ${config.repetitions}`;
}

function exitCodeFor(overall) {
  if (overall === RESULT_STATUS.PASS) return 0;
  if (overall === RESULT_STATUS.FAIL) return 1;
  return 2;
}
