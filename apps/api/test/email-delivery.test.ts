import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileEmailAdapter,
  RecordingEmailAdapter,
  ResendEmailAdapter,
  UnavailableEmailAdapter,
  createEmailDeliveryAdapter,
} from '../src/email-delivery.js';

/**
 * Local-development email sink.
 *
 * The provider-less default reports `failed` for every message, which is why a
 * local password reset cannot be completed without a synchronous listener for the
 * outbox file: the OTP exists only until the challenge is consumed or expires, and
 * registration no longer sends anything at all (OQ-20).
 * These tests pin the properties that make the sink safe to run on a developer
 * machine — one file per message, restrictive permissions, the secret inside the
 * file only, and a bounded failure when the directory cannot be used.
 */

const created: string[] = [];

async function outbox(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kfin-outbox-test-'));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local-development email sink', () => {
  it('writes one message per send with the one-time secret inside the file', async () => {
    const directory = await outbox();
    const adapter = new FileEmailAdapter({ directory });

    const result = await adapter.send({
      to: 'beta.user@example.invalid',
      template: 'password_reset',
      correlationId: '00000000-0000-4000-8000-00000000000f',
      oneTimeSecret: '123456',
    });

    expect(result.status).toBe('delivered');
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const contents = await readFile(path.join(directory, files[0] as string), 'utf8');
    expect(JSON.parse(contents)).toMatchObject({
      to: 'beta.user@example.invalid',
      template: 'password_reset',
      correlationId: '00000000-0000-4000-8000-00000000000f',
      oneTimeSecret: '123456',
    });
  });

  it('keeps each message in its own file so an operator can read them in order', async () => {
    const directory = await outbox();
    const adapter = new FileEmailAdapter({ directory });

    await adapter.send({ to: 'a@example.invalid', template: 'password_reset', correlationId: 'c1', oneTimeSecret: '111111' });
    await adapter.send({ to: 'b@example.invalid', template: 'password_reset', correlationId: 'c2', oneTimeSecret: 'reset-secret-value-0123456789' });

    expect(await readdir(directory)).toHaveLength(2);
  });

  it('omits the secret key entirely when a template carries no secret', async () => {
    const directory = await outbox();
    const adapter = new FileEmailAdapter({ directory });

    await adapter.send({ to: 'a@example.invalid', template: 'security_notice', correlationId: 'c1' });

    const files = await readdir(directory);
    const contents = await readFile(path.join(directory, files[0] as string), 'utf8');
    expect(contents).not.toContain('oneTimeSecret');
  });

  it('writes the file readable only by its owner', async () => {
    const directory = await outbox();
    const adapter = new FileEmailAdapter({ directory });

    await adapter.send({ to: 'a@example.invalid', template: 'password_reset', correlationId: 'c1', oneTimeSecret: '111111' });

    const files = await readdir(directory);
    const stats = await stat(path.join(directory, files[0] as string));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('creates a directory that does not exist yet', async () => {
    const base = await outbox();
    const nested = path.join(base, 'does', 'not', 'exist');
    const adapter = new FileEmailAdapter({ directory: nested });

    const result = await adapter.send({ to: 'a@example.invalid', template: 'password_reset', correlationId: 'c1', oneTimeSecret: '111111' });

    expect(result.status).toBe('delivered');
    expect(await readdir(nested)).toHaveLength(1);
  });

  it('reports a bounded failure without the path when the directory cannot be used', async () => {
    const base = await outbox();
    const blockingFile = path.join(base, 'blocking-file');
    await readFile(blockingFile, 'utf8').catch(async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(blockingFile, 'not a directory', 'utf8');
    });
    // A regular file where a directory is expected makes `mkdir` fail.
    const adapter = new FileEmailAdapter({ directory: path.join(blockingFile, 'outbox') });

    const result = await adapter.send({ to: 'a@example.invalid', template: 'password_reset', correlationId: 'c1', oneTimeSecret: '111111' });

    expect(result.status).toBe('failed');
    expect(result.reference).toBe('file-outbox-unavailable');
    expect(JSON.stringify(result)).not.toContain(blockingFile);
  });
});

describe('adapter selection', () => {
  it('builds each supported adapter kind', () => {
    expect(createEmailDeliveryAdapter('memory')).toBeInstanceOf(RecordingEmailAdapter);
    expect(createEmailDeliveryAdapter('none')).toBeInstanceOf(UnavailableEmailAdapter);
    expect(createEmailDeliveryAdapter('file', { directory: '/tmp/kfin-outbox' })).toBeInstanceOf(FileEmailAdapter);
  });

  it('refuses the file kind without a directory instead of silently degrading', () => {
    expect(() => createEmailDeliveryAdapter('file')).toThrow(/EMAIL_OUTBOX_DIR/);
  });

  it('keeps the provider-less default reporting failure so callers stay generic', async () => {
    const result = await createEmailDeliveryAdapter('none').send({
      to: 'a@example.invalid',
      template: 'password_reset',
      correlationId: 'c1',
      oneTimeSecret: '111111',
    });
    expect(result.status).toBe('failed');
  });
});

describe('resend provider adapter', () => {
  const KEY = 're_test_key_0123456789';
  const FROM = 'KFin <no-reply@kfin.example>';
  const CODE = '483920';

  interface Captured {
    readonly method: string | undefined;
    readonly url: string | undefined;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly body: string;
  }

  async function provider(
    respond: (body: string) => { status: number; payload?: unknown; delayMs?: number },
  ): Promise<{ url: string; requests: Captured[]; close: () => Promise<void> }> {
    const requests: Captured[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        requests.push({ method: request.method, url: request.url, headers: request.headers, body });
        const answer = respond(body);
        const send = (): void => {
          response.writeHead(answer.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(answer.payload ?? {}));
        };
        if (answer.delayMs) setTimeout(send, answer.delayMs).unref();
        else send();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${address.port}`,
      requests,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    };
  }

  it('posts the provider contract with the secret in the body only', async () => {
    const mock = await provider(() => ({ status: 200, payload: { id: 'msg_abc-123' } }));
    try {
      const adapter = new ResendEmailAdapter({ apiKey: KEY, from: FROM, baseUrl: mock.url });
      const result = await adapter.send({
        to: 'beta.user@example.invalid',
        template: 'password_reset',
        correlationId: '00000000-0000-4000-8000-0000000000aa',
        oneTimeSecret: CODE,
      });

      expect(result).toEqual({ status: 'delivered', reference: 'resend-msg_abc-123' });
      expect(mock.requests).toHaveLength(1);
      const sent = mock.requests[0] as Captured;
      expect(sent.method).toBe('POST');
      expect(sent.url).toBe('/emails');
      expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(sent.headers['content-type']).toBe('application/json');
      const body = JSON.parse(sent.body);
      expect(body).toMatchObject({
        from: FROM,
        to: ['beta.user@example.invalid'],
        subject: expect.stringContaining('KFin'),
      });
      expect(body.text).toContain(CODE);
      expect(body.text).toContain('10 phút');
      expect(JSON.stringify(body)).not.toContain(KEY);
    } finally {
      await mock.close();
    }
  });

  it('sends the reply-to address only when one is configured', async () => {
    const mock = await provider(() => ({ status: 200, payload: { id: 'msg-1' } }));
    try {
      const withReplyTo = new ResendEmailAdapter({
        apiKey: KEY, from: FROM, replyTo: 'support@kfin.example', baseUrl: mock.url,
      });
      await withReplyTo.send({ to: 'a@example.invalid', template: 'security_notice', correlationId: 'c1' });
      expect(JSON.parse((mock.requests[0] as Captured).body).reply_to).toBe('support@kfin.example');

      const withoutReplyTo = new ResendEmailAdapter({ apiKey: KEY, from: FROM, baseUrl: mock.url });
      await withoutReplyTo.send({ to: 'a@example.invalid', template: 'security_notice', correlationId: 'c1' });
      expect(JSON.parse((mock.requests[1] as Captured).body)).not.toHaveProperty('reply_to');
    } finally {
      await mock.close();
    }
  });

  it.each([401, 422, 429, 500])('maps a provider %i to a bounded failure reference', async (status) => {
    const mock = await provider(() => ({ status, payload: { message: 'provider rejected the request' } }));
    try {
      const adapter = new ResendEmailAdapter({ apiKey: KEY, from: FROM, baseUrl: mock.url });
      const result = await adapter.send({
        to: 'beta.user@example.invalid',
        template: 'password_reset',
        correlationId: 'c1',
        oneTimeSecret: CODE,
      });

      expect(result).toEqual({ status: 'failed', reference: `resend-http-${status}` });
      expect(JSON.stringify(result)).not.toContain(CODE);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain('rejected');
    } finally {
      await mock.close();
    }
  });

  it('reports an unreachable provider without throwing', async () => {
    const adapter = new ResendEmailAdapter({
      apiKey: KEY, from: FROM, baseUrl: 'http://127.0.0.1:1', timeoutMs: 500,
    });
    const result = await adapter.send({
      to: 'beta.user@example.invalid',
      template: 'password_reset',
      correlationId: 'c1',
      oneTimeSecret: CODE,
    });
    expect(result).toEqual({ status: 'failed', reference: 'resend-unreachable' });
  });

  it('abandons a provider that does not answer within the timeout', async () => {
    const mock = await provider(() => ({ status: 200, payload: { id: 'late' }, delayMs: 400 }));
    try {
      const adapter = new ResendEmailAdapter({ apiKey: KEY, from: FROM, baseUrl: mock.url, timeoutMs: 30 });
      const started = Date.now();
      const result = await adapter.send({
        to: 'beta.user@example.invalid',
        template: 'password_reset',
        correlationId: 'c1',
        oneTimeSecret: CODE,
      });

      expect(result).toEqual({ status: 'failed', reference: 'resend-unreachable' });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await mock.close();
    }
  });

  it('refuses to send a reset message that has no one-time secret', async () => {
    const mock = await provider(() => ({ status: 200, payload: { id: 'unused' } }));
    try {
      const adapter = new ResendEmailAdapter({ apiKey: KEY, from: FROM, baseUrl: mock.url });
      const result = await adapter.send({
        to: 'beta.user@example.invalid',
        template: 'password_reset',
        correlationId: 'c1',
      });

      expect(result).toEqual({ status: 'failed', reference: 'resend-missing-secret' });
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it('is selected by name and refuses to be built without credentials', () => {
    expect(createEmailDeliveryAdapter('resend', { apiKey: KEY, from: FROM })).toBeInstanceOf(ResendEmailAdapter);
    expect(() => createEmailDeliveryAdapter('resend', { from: FROM })).toThrow(/RESEND_API_KEY/);
    expect(() => createEmailDeliveryAdapter('resend', { apiKey: KEY })).toThrow(/EMAIL_FROM_ADDRESS/);
    expect(() => new ResendEmailAdapter({ apiKey: '', from: FROM })).toThrow(/RESEND_API_KEY/);
  });
});
