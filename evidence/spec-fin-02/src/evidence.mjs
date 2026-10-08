import fs from 'node:fs/promises';
import path from 'node:path';
import { CASE_IDS, POLICY_ID, RESULT_STATUS, SCHEMA_VERSION } from './constants.mjs';
import { errorSummary, sha256, stableStringify } from './util.mjs';

const SECRET_KEY = /(password|secret|databaseurl|connectionstring|rawkey|credential|username|hostname)/i;
const SENSITIVE_VALUE = /postgres(?:ql)?:\/\//i;

export class EvidenceRecorder {
  constructor(metadata, { redactLiterals = [], redactUsernames = [] } = {}) {
    this.redaction = {
      literals: redactLiterals.filter((value) => typeof value === 'string' && value.length > 0),
      usernames: redactUsernames.filter((value) => typeof value === 'string' && value.length > 0),
    };
    this.metadata = sanitize(metadata, '', this.redaction);
    this.events = [];
    this.results = new Map(
      CASE_IDS.map((caseId) => [caseId, {
        caseId,
        status: RESULT_STATUS.NOT_RUN,
        executed: false,
        assertions: 0,
        failures: [],
        notes: [],
        durationMs: null,
      }]),
    );
    this.caseStarts = new Map();
  }

  event(type, details = {}) {
    this.events.push(sanitize({
      sequence: this.events.length + 1,
      timestamp: new Date().toISOString(),
      type,
      ...details,
    }, '', this.redaction));
  }

  startCase(caseId, details = {}) {
    const result = this.#case(caseId);
    result.executed = true;
    result.status = RESULT_STATUS.FAIL;
    this.caseStarts.set(caseId, performance.now());
    this.event('case.started', { caseId, ...details });
  }

  assertion(caseId, name, passed, details = {}) {
    const result = this.#case(caseId);
    result.assertions += 1;
    const safeDetails = sanitize(details, '', this.redaction);
    this.event('assertion', { caseId, name, passed: Boolean(passed), ...safeDetails });
    if (!passed) {
      result.failures.push({ name, details: safeDetails });
      result.status = RESULT_STATUS.FAIL;
    }
  }

  note(caseId, note) {
    const result = this.#case(caseId);
    result.notes.push(String(note));
    this.event('case.note', { caseId, note: String(note) });
  }

  passCase(caseId, details = {}) {
    const result = this.#case(caseId);
    if (!result.executed) throw new Error(`Cannot PASS unexecuted case ${caseId}`);
    if (result.failures.length > 0) throw new Error(`Cannot PASS failed case ${caseId}`);
    if (result.assertions === 0) throw new Error(`Cannot PASS case ${caseId} without assertions`);
    result.status = RESULT_STATUS.PASS;
    result.durationMs = this.#duration(caseId);
    this.event('case.finished', { caseId, status: result.status, ...details });
  }

  failCase(caseId, error, details = {}) {
    const result = this.#case(caseId);
    result.executed = true;
    result.status = RESULT_STATUS.FAIL;
    result.durationMs = this.#duration(caseId);
    result.failures.push({
      name: 'case-execution',
      details: sanitize({ ...errorSummary(error), ...details }, '', this.redaction),
    });
    this.event('case.finished', {
      caseId,
      status: result.status,
      error: errorSummary(error),
      ...details,
    });
  }

  blockCase(caseId, reason, details = {}) {
    const result = this.#case(caseId);
    result.status = RESULT_STATUS.BLOCKED;
    result.executed = false;
    result.notes.push(String(reason));
    this.event('case.blocked', { caseId, reason: String(reason), ...details });
  }

  notRunCase(caseId, reason) {
    const result = this.#case(caseId);
    result.status = RESULT_STATUS.NOT_RUN;
    result.executed = false;
    result.notes.push(String(reason));
    this.event('case.not_run', { caseId, reason: String(reason) });
  }

  incompleteCase(caseId, reason) {
    const result = this.#case(caseId);
    result.status = RESULT_STATUS.NOT_RUN;
    result.executed = true;
    result.durationMs = this.#duration(caseId);
    result.notes.push(String(reason));
    this.event('case.finished', { caseId, status: result.status, reason: String(reason) });
  }

  summary() {
    const cases = CASE_IDS.map((caseId) => sanitize(this.#case(caseId), '', this.redaction));
    const statuses = cases.map(({ status }) => status);
    let overall = RESULT_STATUS.PASS;
    if (statuses.includes(RESULT_STATUS.FAIL)) overall = RESULT_STATUS.FAIL;
    else if (statuses.includes(RESULT_STATUS.BLOCKED)) overall = RESULT_STATUS.BLOCKED;
    else if (statuses.includes(RESULT_STATUS.NOT_RUN)) overall = RESULT_STATUS.NOT_RUN;
    return {
      policy: POLICY_ID,
      schemaVersion: SCHEMA_VERSION,
      overall,
      metadata: this.metadata,
      cases,
      eventCount: this.events.length,
    };
  }

  async write(outputRoot, runToken) {
    const directory = path.join(outputRoot, runToken);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const document = sanitize({
      ...this.summary(),
      generatedAt: new Date().toISOString(),
      events: this.events,
    }, '', this.redaction);
    const json = `${stableStringify(document)}\n`;
    const markdown = renderMarkdown(document);
    await fs.writeFile(path.join(directory, 'evidence.json'), json, { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'summary.md'), markdown, { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'evidence.sha256'), `${sha256(json)}  evidence.json\n`, { mode: 0o600 });
    return { directory, digest: sha256(json), summary: document };
  }

  #case(caseId) {
    const result = this.results.get(caseId);
    if (!result) throw new Error(`Unknown case ${caseId}`);
    return result;
  }

  #duration(caseId) {
    const startedAt = this.caseStarts.get(caseId);
    return startedAt === undefined ? null : Number((performance.now() - startedAt).toFixed(3));
  }
}

export function sanitize(value, key = '', redaction = { literals: [], usernames: [] }) {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.test(value)) return '[REDACTED_DATABASE_URL]';
    let output = value.replaceAll(/password\s*[=:]\s*[^\s,;]+/gi, 'password=[REDACTED]');
    for (const literal of redaction.literals || []) {
      output = output.replaceAll(literal, '[REDACTED_ENDPOINT]');
    }
    for (const username of redaction.usernames || []) {
      output = output
        .replaceAll(`"${username}"`, '"[REDACTED_USERNAME]"')
        .replaceAll(`'${username}'`, "'[REDACTED_USERNAME]'");
    }
    return output;
  }
  if (Array.isArray(value)) return value.map((child) => sanitize(child, '', redaction));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = sanitize(childValue, childKey, redaction);
    }
    return output;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function renderMarkdown(document) {
  const lines = [
    '# SPEC-FIN-02 PostgreSQL Evidence Summary',
    '',
    `- Overall: **${document.overall}**`,
    `- Frozen source commit: \`${document.metadata.sourceCommit}\``,
    `- Harness commit: \`${document.metadata.harnessCommit}\``,
    `- Schema migration: \`${document.schemaVersion}\``,
    `- Generated: ${document.generatedAt}`,
    `- PostgreSQL: ${document.metadata.postgresqlVersion || 'NOT OBSERVED'}`,
    `- Driver: ${document.metadata.driverVersion || 'NOT OBSERVED'}`,
    `- Pool mode: ${document.metadata.endpoint?.poolMode || 'unknown'}`,
    '',
    '| Case | Status | Executed | Assertions | Failures |',
    '|---|---|---:|---:|---:|',
  ];
  for (const result of document.cases) {
    lines.push(`| ${result.caseId} | **${result.status}** | ${result.executed ? 'yes' : 'no'} | ${result.assertions} | ${result.failures.length} |`);
  }
  lines.push('', '## Notes and failures', '');
  for (const result of document.cases) {
    if (result.notes.length === 0 && result.failures.length === 0) continue;
    lines.push(`### ${result.caseId}`, '');
    for (const note of result.notes) lines.push(`- ${note}`);
    for (const failure of result.failures) lines.push(`- FAIL \`${failure.name}\`: ${JSON.stringify(failure.details)}`);
    lines.push('');
  }
  lines.push(
    '## Governance',
    '',
    'Harness execution alone does not approve SPEC-FIN-02, accept ADR-009, close Issue #3, or open the Implementation Gate.',
    '',
  );
  return `${lines.join('\n')}\n`;
}
