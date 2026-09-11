import test from 'node:test';
import assert from 'node:assert/strict';
import { transferVimeoUpload, VimeoApiError } from '../dist/index.js';

test('Vimeo transfer resumes at the authoritative offset and checkpoints each bounded chunk', async () => {
  const events = [], bytes = Buffer.from('0123456789');
  const offset = await transferVimeoUpload({ uploadUrl: 'fixture', chunkBytes: 3,
    source: { sizeBytes: 10, async read(offset, length) { events.push(['read', offset, length]); return bytes.subarray(offset, offset + length); } },
    client: { async uploadOffset() { return 4; }, async uploadChunk(url, offset, chunk) { events.push(['send', offset, chunk.toString()]); return offset + chunk.length; } },
    async onProgress(offset) { events.push(['checkpoint', offset]); }
  });
  assert.equal(offset, 10);
  assert.deepEqual(events, [['read', 4, 3], ['send', 4, '456'], ['checkpoint', 7], ['read', 7, 3], ['send', 7, '789'], ['checkpoint', 10]]);
});

test('Vimeo transfer rejects impossible offsets and short reads before sending bytes', async () => {
  let reads = 0, sends = 0;
  for (const offset of [-1, 5, NaN, 1.5]) await assert.rejects(transferVimeoUpload({ uploadUrl: 'fixture', source: { sizeBytes: 4, async read() { reads++; return new Uint8Array(4); } }, client: { async uploadOffset() { return offset; }, async uploadChunk() { sends++; return 4; } }, async onProgress() {} }), VimeoApiError);
  assert.equal(reads, 0); assert.equal(sends, 0);
  await assert.rejects(transferVimeoUpload({ uploadUrl: 'fixture', source: { sizeBytes: 4, async read() { return new Uint8Array(3); } }, client: { async uploadOffset() { return 0; }, async uploadChunk() { sends++; return 4; } }, async onProgress() {} }), VimeoApiError);
  assert.equal(sends, 0);
});

test('Vimeo transfer stops on checkpoint failure and on non-advancing acknowledgements', async () => {
  for (const checkpointFailure of [true, false]) {
    let sends = 0; const failure = new Error('checkpoint unavailable');
    await assert.rejects(transferVimeoUpload({ uploadUrl: 'fixture', chunkBytes: 2,
      source: { sizeBytes: 4, async read(_offset, length) { return new Uint8Array(length); } },
      client: { async uploadOffset() { return 0; }, async uploadChunk() { sends++; return checkpointFailure ? 2 : 0; } },
      async onProgress() { throw failure; }
    }), error => checkpointFailure ? error === failure : error instanceof VimeoApiError);
    assert.equal(sends, 1);
  }
});
