import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FfmpegPosterProcessor } from '../dist/index.js';
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
