import pg from 'pg';
import { proxyClientOptions } from './config.mjs';
import { quoteIdentifier, safeToken } from './util.mjs';

const { Client } = pg;

export async function createProxyLease(config, recorder, host, port, label) {
  const client = new Client(proxyClientOptions(config, host, port));
  const lease = new ProxyLease(client, recorder, label);
  await client.connect();
  await client.query(`SET search_path TO ${quoteIdentifier(config.schema)}, pg_catalog, public`);
  return lease;
}

class ProxyLease {
  constructor(client, recorder, label) {
    this.client = client;
    this.recorder = recorder;
    this.label = label;
    this.released = false;
    this.identity = { handleToken: safeToken('proxy-handle'), backendToken: null };
    this.readyState = { sequence: 0, status: null };
    client.connection?.on('readyForQuery', (message) => {
      this.readyState = {
        sequence: this.readyState.sequence + 1,
        status: message?.status ?? null,
      };
      this.identity.backendToken = client.processID ? `backend-${client.processID}` : null;
      recorder.event('postgres.ready_for_query', { ...this.identity, ...this.readyState, proxied: true });
    });
    client.on('error', (error) => {
      recorder.event('connection.error', {
        ...this.identity,
        proxied: true,
        name: error.name,
        code: error.code ?? null,
      });
    });
  }

  get backendPid() {
    return this.client.processID;
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
    return {
      confirmed: this.readyState.sequence > before
        && this.readyState.status === 'I',
      status: this.readyState.status,
      readySequence: this.readyState.sequence,
    };
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.recorder.event('connection.checkin', { ...this.identity, proxied: true, label: this.label });
    this.client.end().catch(() => {});
  }

  evict(reason = 'proxy-fault') {
    if (this.released) return;
    this.released = true;
    this.recorder.event('connection.evict', { ...this.identity, proxied: true, label: this.label, reason });
    this.client.connection?.stream?.destroy();
    this.client.end().catch(() => {});
  }

  destroySocket(reason = 'proxy-fault') {
    this.recorder.event('connection.socket_destroy', { ...this.identity, proxied: true, label: this.label, reason });
    this.client.connection?.stream?.destroy(new Error(reason));
  }
}
