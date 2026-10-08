import { createRequire } from 'node:module';
import pg from 'pg';
import { pgConnectionOptions } from './config.mjs';
import { quoteIdentifier, safeToken } from './util.mjs';

const require = createRequire(import.meta.url);
const pgPackage = require('pg/package.json');
const { Client, Pool } = pg;

export const PG_DRIVER_VERSION = pgPackage.version;

export class TracedPool {
  constructor(config, recorder, overrides = {}) {
    this.config = config;
    this.recorder = recorder;
    this.handles = new WeakMap();
    this.readyState = new WeakMap();
    this.pool = new Pool(pgConnectionOptions(config, {
      max: overrides.max ?? config.poolMax,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    }));
    this.pool.on('connect', (client) => this.#register(client));
    this.pool.on('acquire', (client) => {
      this.recorder?.event('pool.acquire', this.#identity(client));
    });
    this.pool.on('release', (error, client) => {
      this.recorder?.event('pool.release', {
        ...this.#identity(client),
        error: error ? { name: error.name, sqlstate: error.code ?? null } : null,
      });
    });
    this.pool.on('remove', (client) => {
      this.recorder?.event('pool.remove', this.#identity(client));
    });
    this.pool.on('error', (error, client) => {
      this.recorder?.event('pool.error', {
        ...this.#identity(client),
        error: { name: error.name, sqlstate: error.code ?? null, message: error.message },
      });
    });
  }

  async checkout(label = 'unspecified') {
    const client = await this.pool.connect();
    if (!this.handles.has(client)) this.#register(client);
    const identity = this.#identity(client);
    this.recorder?.event('connection.checkout', { ...identity, label });
    try {
      await client.query(`SET search_path TO ${quoteIdentifier(this.config.schema)}, pg_catalog, public`);
      return new TracedLease(this, client, label);
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  state(client) {
    return this.readyState.get(client) || { sequence: 0, status: null };
  }

  identity(client) {
    return this.#identity(client);
  }

  async metadata() {
    const lease = await this.checkout('metadata');
    try {
      const result = await lease.query(
        `SELECT current_setting('server_version') AS server_version,
                current_setting('server_version_num') AS server_version_num,
                current_setting('transaction_isolation') AS default_isolation,
                current_database() AS database_name,
                pg_catalog.pg_backend_pid() AS backend_pid`,
      );
      return {
        serverVersion: result.rows[0].server_version,
        serverVersionNum: result.rows[0].server_version_num,
        defaultIsolation: result.rows[0].default_isolation,
        backendPidObserved: Number.isInteger(result.rows[0].backend_pid),
      };
    } finally {
      lease.release();
    }
  }

  async end() {
    await this.pool.end();
  }

  #register(client) {
    if (this.handles.has(client)) return;
    const handleToken = safeToken('handle');
    this.handles.set(client, handleToken);
    this.readyState.set(client, { sequence: 0, status: null });
    const connection = client.connection;
    if (connection?.on) {
      connection.on('readyForQuery', (message) => {
        const prior = this.readyState.get(client) || { sequence: 0, status: null };
        const status = message?.status ?? message?.transactionStatus ?? null;
        const next = { sequence: prior.sequence + 1, status };
        this.readyState.set(client, next);
        this.recorder?.event('postgres.ready_for_query', {
          ...this.#identity(client),
          status,
          sequence: next.sequence,
        });
      });
    }
    client.on('error', (error) => {
      this.recorder?.event('connection.error', {
        ...this.#identity(client),
        name: error.name,
        sqlstate: error.code ?? null,
        message: error.message,
      });
    });
    this.recorder?.event('pool.connect', this.#identity(client));
  }

  #identity(client) {
    if (!client) return { handleToken: null, backendToken: null };
    return {
      handleToken: this.handles.get(client) || null,
      backendToken: client.processID ? `backend-${client.processID}` : null,
    };
  }
}

export class TracedLease {
  constructor(owner, client, label) {
    this.owner = owner;
    this.client = client;
    this.label = label;
    this.released = false;
    this.identity = owner.identity(client);
  }

  get backendPid() {
    return this.client.processID;
  }

  get readyState() {
    return this.owner.state(this.client);
  }

  query(text, values = undefined) {
    return values === undefined ? this.client.query(text) : this.client.query(text, values);
  }

  async begin() {
    await this.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  }

  async rollback() {
    const before = this.readyState.sequence;
    await this.query('ROLLBACK');
    const after = this.readyState;
    return {
      confirmed: after.sequence > before && after.status === 'I',
      status: after.status,
      readySequence: after.sequence,
    };
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.owner.recorder?.event('connection.checkin', { ...this.identity, label: this.label });
    this.client.release();
  }

  evict(reason = 'unconfirmed-cleanup') {
    if (this.released) return;
    this.released = true;
    this.owner.recorder?.event('connection.evict', { ...this.identity, label: this.label, reason });
    this.client.release(true);
  }

  destroySocket(reason = 'fault-injection') {
    this.owner.recorder?.event('connection.socket_destroy', { ...this.identity, label: this.label, reason });
    this.client.connection?.stream?.destroy(new Error(reason));
  }
}

export async function createDirectClient(config, overrides = {}) {
  const client = new Client(pgConnectionOptions(config, overrides));
  await client.connect();
  await client.query(`SET search_path TO ${quoteIdentifier(config.schema)}, pg_catalog, public`);
  return client;
}
