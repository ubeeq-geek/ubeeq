import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, stat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FfmpegPosterProcessor, renderVideoPoster } from '../dist/index.js';
test('buffer poster rendering preserves capture time and cleans failed and successful attempts', async () => {
  let directory, failure, output = new Uint8Array([255, 216, 255, 1]), calls = 0;
  const source = new Uint8Array([1, 2, 3]);
  const tools = { extractFrame: async (input, target, timestamp) => {
    calls++; directory = dirname(input);
    assert.deepEqual(new Uint8Array(await readFile(input)), source);
    assert.equal((await stat(input)).mode & 0o777, 0o600);
    assert.equal(timestamp, 1250);
    if (failure) throw failure;
    await writeFile(target, output);
  } };
  const options = { tools, captureAtMs: 1250, maxOutputBytes: 4 };
  assert.deepEqual(await renderVideoPoster(source, options), output);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  for (const body of [new Uint8Array(5), new Uint8Array(), new Uint8Array([1, 2, 3])]) {
    output = body;
    await assert.rejects(renderVideoPoster(source, options), /budget|JPEG/);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
  failure = new Error('decoder failed');
  await assert.rejects(renderVideoPoster(source, options), /decoder failed/);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  const previous = calls;
  for (const captureAtMs of [-1, 0.5, NaN, Infinity]) await assert.rejects(renderVideoPoster(source, { ...options, captureAtMs }), /timestamp/);
  await assert.rejects(renderVideoPoster(source, { ...options, maxOutputBytes: 0 }), /budget/);
  await assert.rejects(renderVideoPoster(new Uint8Array(), options), /nonempty/);
  assert.equal(calls, previous);
});
const profile = { profile: 'fixture', maxDurationSeconds: 60, maxWidth: 100, maxHeight: 100,
  allowedContainers: ['mp4'], allowedVideoCodecs: ['h264'], frameIntervalSeconds: 3 };
const input = { assetId: 'asset', sourceVersionId: 'version', contentType: 'video/mp4', source: new Uint8Array([1]) };
test('poster preserves lineage, enforces output bounds and cleans attempt files', async () => {
  let directory, calls = 0, body = new Uint8Array([255, 216, 255, 0]);
  const tools = { probe: async path => { directory = dirname(path); return { format: { duration: '2', format_name: 'mp4' },
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 48 }] }; },
    extractFrame: async (_input, output, time) => { calls++; assert.equal(time, 0); await writeFile(output, body); } };
  const processor = new FfmpegPosterProcessor(tools, profile, 8);
  const result = await processor.process(input);
  assert.equal(result.metadata.durationSeconds, 2);
  assert.equal(result.renditions[0].role, 'poster');
  assert.equal(result.renditions[0].sourceVersionId, 'version');
  assert.deepEqual(result.renditions[0].body, body);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  body = new Uint8Array(9);
  await assert.rejects(processor.process(input), /budget/);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  body = new Uint8Array([1, 2, 3]);
  await assert.rejects(processor.process(input), /JPEG/);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  const previousCalls = calls;
  await assert.rejects(new FfmpegPosterProcessor(tools, { ...profile, allowedVideoCodecs: [] }).process(input), /codec/);
  assert.equal(calls, previousCalls);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});
