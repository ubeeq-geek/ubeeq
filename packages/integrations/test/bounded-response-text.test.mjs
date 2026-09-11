import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedResponseText as read } from '../dist/index.js';

test('bounded response text counts bytes, preserves split UTF-8 and accepts the exact limit', async () => {
  const bytes = new TextEncoder().encode('A😀B');
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 3)); controller.enqueue(bytes.slice(3)); controller.close();
  } }));
  assert.equal(await read(response, bytes.length), 'A😀B');
  assert.equal(response.body.locked, false);
  assert.equal(await read(new Response(null), 1), '');
  await assert.rejects(read(new Response('😀'), 3), /byte limit/);
});
test('oversized declared or actual bytes cancel the stream without returning partial text', async () => {
  for (const length of [undefined, '1', '100']) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(5)); },
      cancel() { cancelled = true; } }), { headers: length ? { 'content-length': length } : {} });
    await assert.rejects(read(response, 4), /byte limit/);
    assert.equal(cancelled, true); assert.equal(response.body.locked, false);
  }
});
test('invalid budgets and stream failures propagate', async () => {
  for (const limit of [0, -1, 1.5, Infinity, NaN]) await assert.rejects(read(new Response('text'), limit), /positive safe integer/);
  const failure = new Error('read failed');
  const response = new Response(new ReadableStream({ pull(controller) { controller.error(failure); } }));
  await assert.rejects(read(response, 10), error => error === failure);
  assert.equal(response.body.locked, false);
});
