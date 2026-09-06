import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedBytes } from '../dist/index.js';

test('bounded byte collection preserves exact-budget data and reused chunk buffers', async () => {
  async function* source() {
    const chunk = new Uint8Array([1, 2]);
    yield chunk; chunk.set([3, 4]); yield chunk; yield new Uint8Array();
  }
  assert.deepEqual(await readBoundedBytes(source(), 4), new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(await readBoundedBytes((async function* () {})(), 1), new Uint8Array());
  async function* tinyChunks() { for (let i = 0; i < 8193; i++) yield new Uint8Array([i % 256]); }
  const many = await readBoundedBytes(tinyChunks(), 8193);
  assert.equal(many.byteLength, 8193);
  for (let i = 0; i < many.length; i++) assert.equal(many[i], i % 256);
});

test('overflow closes the iterator before consuming later chunks', async () => {
  for (const sizes of [[5], [2, 3]]) {
    let closed = false, advanced = false;
    async function* source() {
      try { for (const size of sizes) yield new Uint8Array(size); advanced = true; yield new Uint8Array([9]); }
      finally { closed = true; }
    }
    await assert.rejects(readBoundedBytes(source(), 4), /budget/);
    assert.equal(closed, true); assert.equal(advanced, false);
  }
});

test('invalid budgets do not read and invalid chunks and source failures propagate', async () => {
  let read = false;
  async function* source() { read = true; yield new Uint8Array([1]); }
  for (const max of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(readBoundedBytes(source(), max), /budget/);
  assert.equal(read, false);
  await assert.rejects(readBoundedBytes((async function* () { yield 'not bytes'; })(), 4), /non-byte/);
  await assert.rejects(readBoundedBytes((async function* () { yield new Uint8Array([1]); throw new Error('transport failed'); })(), 4), /transport failed/);
});
