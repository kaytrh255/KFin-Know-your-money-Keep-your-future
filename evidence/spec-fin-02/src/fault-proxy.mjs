import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { withTimeout } from './util.mjs';

const SSL_REQUEST_CODE = 80877103;

export class PostgreSqlFaultProxy {
  constructor({ config, recorder, caseId, mode }) {
    this.config = config;
    this.recorder = recorder;
    this.caseId = caseId;
    this.mode = mode;
    this.server = null;
    this.downstream = null;
    this.upstream = null;
    this.suppressCommitResponse = false;
    this.sawCommitCommandComplete = false;
    this.fault = new Promise((resolve) => { this.resolveFault = resolve; });
    this.faultResolved = false;
    this.closedSides = new Set();
    this.connectionsClosed = new Promise((resolve) => { this.resolveConnectionsClosed = resolve; });
  }

  async start() {
    if (!this.config.parsedEndpoint) throw new Error('DATABASE_URL is required for fault proxy');
    this.server = net.createServer((socket) => {
      this.#accept(socket).catch((error) => {
        this.recorder.event('fault_proxy.error', {
          caseId: this.caseId,
          phase: 'accept',
          name: error.name,
          message: error.message,
        });
        socket.destroy();
        this.#resolve({ triggered: false, error: error.message });
      });
    });
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    this.recorder.event('fault_proxy.started', {
      caseId: this.caseId,
      mode: this.mode,
      listenAddress: 'loopback',
      listenPort: address.port,
      upstreamProvider: this.config.endpointMetadata.provider,
      upstreamPort: this.config.endpointMetadata.port,
      upstreamTls: this.config.sslMode !== 'disable',
    });
    return { host: '127.0.0.1', port: address.port };
  }

  async waitForFault(timeoutMs = 10_000) {
    return withTimeout(this.fault, timeoutMs, `fault proxy ${this.mode}`);
  }

  async waitForConnectionsClosed(timeoutMs = 10_000) {
    return withTimeout(this.connectionsClosed, timeoutMs, `fault proxy ${this.mode} connection close`);
  }

  closeAfterAcknowledgedCommit() {
    this.recorder.event('fault_proxy.drop_after_commit_ack', { caseId: this.caseId });
    this.#resolve({
      triggered: true,
      mode: 'drop-after-commit-ack',
      commitForwarded: true,
      commitAcknowledgementForwarded: true,
    });
    this.#destroySockets();
  }

  async stop() {
    this.#destroySockets();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(resolve));
    }
    this.recorder.event('fault_proxy.stopped', { caseId: this.caseId, mode: this.mode });
  }

  async #accept(downstream) {
    if (this.downstream) {
      downstream.destroy(new Error('Evidence proxy accepts one connection only'));
      return;
    }
    this.downstream = downstream;
    downstream.setNoDelay(true);
    downstream.pause();
    this.upstream = await connectUpstream(this.config);
    this.upstream.setNoDelay(true);
    const frontend = new FrontendDecoder();
    const backend = new BackendDecoder();

    downstream.on('data', (chunk) => {
      try {
        for (const frame of frontend.push(chunk)) this.#frontendFrame(frame);
      } catch (error) {
        this.#proxyStreamError('frontend', error);
      }
    });
    this.upstream.on('data', (chunk) => {
      try {
        for (const frame of backend.push(chunk)) this.#backendFrame(frame);
      } catch (error) {
        this.#proxyStreamError('backend', error);
      }
    });
    downstream.on('error', (error) => this.#socketError('downstream', error));
    this.upstream.on('error', (error) => this.#socketError('upstream', error));
    downstream.on('close', () => {
      this.#markClosed('downstream');
      this.upstream?.destroy();
    });
    this.upstream.on('close', () => {
      this.#markClosed('upstream');
      this.downstream?.destroy();
    });
    downstream.resume();
  }

  #frontendFrame(frame) {
    const isCommit = frame.type === 'Q' && frame.query === 'COMMIT';
    if (!isCommit) {
      this.upstream.write(frame.buffer);
      return;
    }
    this.recorder.event('fault_proxy.commit_observed', {
      caseId: this.caseId,
      mode: this.mode,
    });
    if (this.mode === 'drop-commit-before-upstream') {
      this.#resolve({
        triggered: true,
        mode: this.mode,
        commitForwarded: false,
        commitAcknowledgementForwarded: false,
      });
      this.#destroySockets();
      return;
    }
    this.upstream.write(frame.buffer);
    if (this.mode === 'drop-commit-ack-after-upstream') {
      this.suppressCommitResponse = true;
    }
  }

  #backendFrame(frame) {
    if (!this.suppressCommitResponse) {
      this.downstream.write(frame.buffer);
      return;
    }
    if (frame.type === 'C') this.sawCommitCommandComplete = true;
    if (frame.type === 'Z') {
      const idle = frame.status === 'I';
      this.recorder.event('fault_proxy.commit_response_suppressed', {
        caseId: this.caseId,
        commandComplete: this.sawCommitCommandComplete,
        readyForQueryStatus: frame.status,
      });
      this.#resolve({
        triggered: true,
        mode: this.mode,
        commitForwarded: true,
        commitAcknowledgementForwarded: false,
        commandCompleteObservedUpstream: this.sawCommitCommandComplete,
        readyForQueryStatus: frame.status,
        committed: this.sawCommitCommandComplete && idle,
      });
      this.#destroySockets();
    }
  }

  #proxyStreamError(side, error) {
    this.recorder.event('fault_proxy.parse_error', {
      caseId: this.caseId,
      side,
      name: error.name,
      message: error.message,
    });
    this.#resolve({ triggered: false, parseError: true });
    this.#destroySockets();
  }

  #socketError(side, error) {
    this.recorder.event('fault_proxy.socket_error', {
      caseId: this.caseId,
      side,
      name: error.name,
      code: error.code ?? null,
    });
  }

  #markClosed(side) {
    this.closedSides.add(side);
    if (this.closedSides.size !== 2) return;
    const result = { downstreamClosed: true, upstreamClosed: true };
    this.recorder.event('fault_proxy.connections_closed', {
      caseId: this.caseId,
      mode: this.mode,
      ...result,
    });
    this.resolveConnectionsClosed(result);
  }

  #resolve(value) {
    if (this.faultResolved) return;
    this.faultResolved = true;
    this.resolveFault(value);
  }

  #destroySockets() {
    this.downstream?.destroy();
    this.upstream?.destroy();
  }
}

async function connectUpstream(config) {
  const endpoint = config.parsedEndpoint;
  const raw = net.createConnection({ host: endpoint.hostname, port: endpoint.port });
  raw.setNoDelay(true);
  await once(raw, 'connect');
  if (config.sslMode === 'disable') return raw;

  const request = Buffer.alloc(8);
  request.writeInt32BE(8, 0);
  request.writeInt32BE(SSL_REQUEST_CODE, 4);
  raw.write(request);
  const [response] = await once(raw, 'data');
  if (response.length !== 1 || response[0] !== 0x53) {
    raw.destroy();
    throw new Error('Upstream PostgreSQL endpoint did not accept SSL negotiation');
  }
  const secure = tls.connect({
    socket: raw,
    servername: endpoint.hostname,
    rejectUnauthorized: config.sslRejectUnauthorized,
  });
  await once(secure, 'secureConnect');
  return secure;
}

export class FrontendDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.startupComplete = false;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (true) {
      if (!this.startupComplete) {
        if (this.buffer.length < 4) break;
        const length = this.buffer.readInt32BE(0);
        if (length < 8 || this.buffer.length < length) break;
        const buffer = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        this.startupComplete = true;
        frames.push({ type: 'startup', buffer });
        continue;
      }
      if (this.buffer.length < 5) break;
      const type = String.fromCharCode(this.buffer[0]);
      const length = this.buffer.readInt32BE(1);
      const total = 1 + length;
      if (length < 4 || this.buffer.length < total) break;
      const buffer = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      let query = null;
      if (type === 'Q') query = buffer.subarray(5, total - 1).toString('utf8').trim().toUpperCase();
      frames.push({ type, query, buffer });
    }
    return frames;
  }
}

export class BackendDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const length = this.buffer.readInt32BE(1);
      const total = 1 + length;
      if (length < 4 || this.buffer.length < total) break;
      const buffer = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      frames.push({
        type,
        status: type === 'Z' ? String.fromCharCode(buffer[5]) : null,
        buffer,
      });
    }
    return frames;
  }
}
