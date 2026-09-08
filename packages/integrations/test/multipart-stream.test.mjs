import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMultipartStream } from '../dist/index.js';
test('multipart encoding preserves ordered fields and binary bytes without reading before consumption', async () => {
  let reads = 0, destroyed = false;
  const source = { async *[Symbol.asyncIterator]() { reads++; yield Uint8Array.from([0, 255, 1]); }, destroy() { destroyed = true; } };
  const form = createMultipartStream([['track[title]', 'Title'], ['track[sharing]', 'private']], { fieldName: 'track[asset_data]', filename: 'a"\r\nb.bin', contentType: 'application/octet-stream', source }, 'test-boundary');
  assert.equal(reads, 0);
  const chunks = []; for await (const chunk of form.body) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks), text = bytes.toString('latin1');
  assert.ok(text.indexOf('track[title]') < text.indexOf('track[sharing]'));
  assert.ok(text.includes('filename="a___b.bin"')); assert.ok(bytes.includes(Buffer.from([0, 255, 1])));
  assert.ok(text.endsWith('\r\n--test-boundary--\r\n')); assert.equal(destroyed, true);
  assert.equal(form.contentType, 'multipart/form-data; boundary=test-boundary');
});
test('disposing an unconsumed multipart body closes its source, and source failures propagate', async () => {
  const source = Readable.from(['bytes']), form = createMultipartStream([], { fieldName: 'file', filename: 'a', contentType: 'text/plain', source });
  form.dispose(); assert.equal(source.destroyed, true); assert.equal(form.body.destroyed, true);
  const failure = new Error('source failure'); let closed = false;
  const failing = { async *[Symbol.asyncIterator]() { throw failure; }, destroy() { closed = true; } };
  const bad = createMultipartStream([], { fieldName: 'file', filename: 'a', contentType: 'text/plain', source: failing });
  await assert.rejects(async () => { for await (const chunk of bad.body) void chunk; }, error => error === failure);
  assert.equal(closed, true);
});
test('header injection and invalid boundaries are rejected and release supplied sources', () => {
  for (const change of [{ fieldName: 'file"\r\nInjected' }, { contentType: 'text/plain\r\nInjected: yes' }, { boundary: 'bad boundary' }]) {
    const source = Readable.from(['bytes']);
    assert.throws(() => createMultipartStream([], { fieldName: 'file', filename: 'a', contentType: 'text/plain', source, ...change }, change.boundary), /Invalid multipart/);
    assert.equal(source.destroyed, true);
  }
});
