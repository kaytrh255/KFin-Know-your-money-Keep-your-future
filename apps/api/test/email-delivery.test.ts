import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileEmailAdapter,
  RecordingEmailAdapter,
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
