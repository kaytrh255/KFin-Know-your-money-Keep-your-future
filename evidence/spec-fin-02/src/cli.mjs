#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { sanitize } from './evidence.mjs';
import { sanitizeErrorForArtifact } from './util.mjs';
import { runEvidence, setupEvidenceSchema, removeEvidenceSchema } from './runner.mjs';

let configForRedaction = null;

async function main() {
  const config = loadConfig({ argv: process.argv.slice(2) });
  configForRedaction = config;
  if (config.command === 'run') {
    const result = await runEvidence(config);
    console.log(`SPEC-FIN-02 evidence status: ${result.summary.overall}`);
    console.log(`Sanitized artifacts: ${result.directory}`);
    process.exitCode = result.exitCode;
    return;
  }
  if (config.command === 'setup' || config.command === 'reset') {
    const migration = await setupEvidenceSchema(config);
    console.log(`Evidence schema ${config.schema} is ready at migration ${migration.version}.`);
    return;
  }
  if (config.command === 'drop') {
    await removeEvidenceSchema(config);
    console.log(`Evidence schema ${config.schema} was removed.`);
    return;
  }
  throw new Error(`Unknown command: ${config.command}`);
}

main().catch((error) => {
  const safe = sanitize(sanitizeErrorForArtifact(error), '', {
    literals: [configForRedaction?.parsedEndpoint?.hostname]
      .filter((value) => typeof value === 'string' && value.length >= 4),
    usernames: [configForRedaction?.parsedEndpoint?.username].filter(Boolean),
  });
  console.error(`${safe.name}: ${safe.message}`);
  if (safe.sqlstate) console.error(`SQLSTATE: ${safe.sqlstate}`);
  process.exitCode = 1;
});
