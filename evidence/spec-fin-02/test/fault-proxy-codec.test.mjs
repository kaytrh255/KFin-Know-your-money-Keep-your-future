import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendDecoder, FrontendDecoder } from '../src/fault-proxy.mjs';

function startupFrame() {
  const buffer = Buffer.alloc(8);
  buffer.writeInt32BE(8, 0);
  buffer.writeInt32BE(196608, 4);
  return buffer;
}

function frontendQuery(sql) {
  const payload = Buffer.from(`${sql}\0`, 'utf8');
  const buffer = Buffer.alloc(1 + 4 + payload.length);
  buffer.write('Q', 0);
  buffer.writeInt32BE(4 + payload.length, 1);
  payload.copy(buffer, 5);
  return buffer;
}

function backendFrame(type, payload) {
  const buffer = Buffer.alloc(1 + 4 + payload.length);
  buffer.write(type, 0);
  buffer.writeInt32BE(4 + payload.length, 1);
  payload.copy(buffer, 5);
  return buffer;
}

test('frontend decoder detects COMMIT across arbitrary TCP chunks without retaining credentials', () => {
  const decoder = new FrontendDecoder();
  const stream = Buffer.concat([startupFrame(), frontendQuery('  commit  ')]);
  const first = decoder.push(stream.subarray(0, 7));
  const second = decoder.push(stream.subarray(7, 11));
  const third = decoder.push(stream.subarray(11));
  assert.equal(first.length, 0);
  assert.equal(second[0].type, 'startup');
  assert.equal(third[0].type, 'Q');
  assert.equal(third[0].query, 'COMMIT');
});

test('backend decoder exposes only protocol type and ReadyForQuery status needed by fault oracle', () => {
  const decoder = new BackendDecoder();
  const command = backendFrame('C', Buffer.from('COMMIT\0'));
  const ready = backendFrame('Z', Buffer.from('I'));
  const frames = decoder.push(Buffer.concat([command, ready]));
  assert.deepEqual(frames.map(({ type, status }) => ({ type, status })), [
    { type: 'C', status: null },
    { type: 'Z', status: 'I' },
  ]);
});
