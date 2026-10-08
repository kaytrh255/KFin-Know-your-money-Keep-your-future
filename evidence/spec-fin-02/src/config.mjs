import path from 'node:path';
import { CASE_IDS, FROZEN_SOURCE_COMMIT, POLICY } from './constants.mjs';
import { parseInteger, safeToken } from './util.mjs';

const ALLOWED_POOL_MODES = new Set(['direct', 'session', 'transaction', 'unknown']);
const ALLOWED_SSL_MODES = new Set(['disable', 'prefer', 'require', 'verify-full']);

export function loadConfig({ env = process.env, argv = [] } = {}) {
  const args = parseArguments(argv);
  const databaseUrl = env.DATABASE_URL || null;
  const parsedEndpoint = databaseUrl ? parseDatabaseUrl(databaseUrl) : null;
  const schema = args.schema || env.KFIN_EVIDENCE_SCHEMA || 'kfin_fin02_evidence';
  if (!/^kfin_fin02_[a-z0-9_]{1,48}$/.test(schema)) {
    throw new Error('Evidence schema must match kfin_fin02_[a-z0-9_]{1,48}');
  }

  const selectedCases = args.cases.length > 0 ? args.cases : [...CASE_IDS];
  for (const caseId of selectedCases) {
    if (!CASE_IDS.includes(caseId)) throw new Error(`Unknown evidence case: ${caseId}`);
  }

  const repetitions = args.repetitions ?? parseInteger(env.KFIN_EVIDENCE_REPETITIONS, 100, {
    minimum: 1,
    maximum: 10_000,
  });
  const poolMax = parseInteger(env.KFIN_EVIDENCE_POOL_MAX, 12, { minimum: 4, maximum: 50 });
  const cleanupReserveMs = parseInteger(
    env.KFIN_EVIDENCE_CLEANUP_RESERVE_MS,
    POLICY.cleanupReserveMs,
    { minimum: 1, maximum: POLICY.databaseBudgetMs - 1 },
  );
  const poolMode = env.KFIN_EVIDENCE_POOL_MODE || inferPoolMode(parsedEndpoint);
  if (!ALLOWED_POOL_MODES.has(poolMode)) {
    throw new Error(`KFIN_EVIDENCE_POOL_MODE must be one of ${[...ALLOWED_POOL_MODES].join(', ')}`);
  }

  const sslMode = env.KFIN_EVIDENCE_SSL_MODE || parsedEndpoint?.sslMode || inferSslMode(parsedEndpoint);
  if (!ALLOWED_SSL_MODES.has(sslMode)) {
    throw new Error(`KFIN_EVIDENCE_SSL_MODE must be one of ${[...ALLOWED_SSL_MODES].join(', ')}`);
  }

  const runToken = args.runToken || safeToken('run');
  const config = {
    sourceCommit: FROZEN_SOURCE_COMMIT,
    schema,
    selectedCases,
    repetitions,
    closureEligibleRepetitions: repetitions >= 100,
    poolMax,
    poolMode,
    sslMode,
    sslRejectUnauthorized: env.KFIN_EVIDENCE_SSL_REJECT_UNAUTHORIZED !== 'false',
    cleanupReserveMs,
    runToken,
    outputRoot: path.resolve(args.output || env.KFIN_EVIDENCE_OUTPUT || '.artifacts/spec-fin-02'),
    command: args.command,
    resetBeforeRun: !args.noReset,
    keepSchema: args.keepSchema,
    endpointMetadata: endpointMetadata(parsedEndpoint, poolMode, sslMode),
    nonProductionConfirmed: env.KFIN_EVIDENCE_TARGET === 'non-production',
  };

  Object.defineProperty(config, 'databaseUrl', {
    value: databaseUrl,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(config, 'parsedEndpoint', {
    value: parsedEndpoint,
    enumerable: false,
    writable: false,
  });
  return Object.freeze(config);
}

export function pgConnectionOptions(config, overrides = {}) {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not configured');
  const url = new URL(config.databaseUrl);
  url.searchParams.delete('sslmode');
  const ssl = config.sslMode === 'disable'
    ? false
    : { rejectUnauthorized: config.sslRejectUnauthorized };
  return {
    connectionString: url.toString(),
    ssl,
    application_name: `kfin-fin02-${config.runToken}`,
    ...overrides,
  };
}

export function proxyClientOptions(config, host, port) {
  if (!config.parsedEndpoint) throw new Error('DATABASE_URL is not configured');
  const endpoint = config.parsedEndpoint;
  return {
    host,
    port,
    user: endpoint.username,
    password: endpoint.password,
    database: endpoint.database,
    ssl: false,
    application_name: `kfin-fin02-proxy-${config.runToken}`,
  };
}

export function parseArguments(argv) {
  const result = {
    command: argv[0] || 'run',
    cases: [],
    repetitions: null,
    schema: null,
    output: null,
    runToken: null,
    noReset: false,
    keepSchema: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--case') result.cases.push(String(argv[++index] || '').toUpperCase());
    else if (arg === '--repetitions') result.repetitions = parseInteger(argv[++index], null, { minimum: 1, maximum: 10_000 });
    else if (arg === '--schema') result.schema = argv[++index];
    else if (arg === '--output') result.output = argv[++index];
    else if (arg === '--run-token') result.runToken = argv[++index];
    else if (arg === '--no-reset') result.noReset = true;
    else if (arg === '--keep-schema') result.keepSchema = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function parseDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  if (!url.hostname || !url.username || !url.pathname.slice(1)) {
    throw new Error('DATABASE_URL must include host, user, and database');
  }
  return Object.freeze({
    hostname: url.hostname,
    port: Number(url.port || 5432),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    sslMode: url.searchParams.get('sslmode'),
    isSupabase: /(?:supabase\.co|supabase\.com|supavisor\.com)$/i.test(url.hostname),
  });
}

function inferPoolMode(endpoint) {
  if (!endpoint) return 'unknown';
  if (/pooler|supavisor/i.test(endpoint.hostname) && endpoint.port === 6543) return 'transaction';
  if (/pooler|supavisor/i.test(endpoint.hostname)) return 'session';
  return 'direct';
}

function inferSslMode(endpoint) {
  if (!endpoint) return 'require';
  if (endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1') return 'disable';
  return 'require';
}

function endpointMetadata(endpoint, poolMode, sslMode) {
  if (!endpoint) {
    return { configured: false, provider: 'unconfigured', port: null, poolMode, sslMode };
  }
  return {
    configured: true,
    provider: endpoint.isSupabase ? 'supabase' : 'postgresql',
    port: endpoint.port,
    poolMode,
    sslMode,
  };
}
