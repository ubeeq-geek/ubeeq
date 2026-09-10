import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FfmpegFrameProcessor, FfmpegVideoToolAdapter } from '../dist/index.js';

const profile = { profile: 'sample-v1', maxDurationSeconds: 10, maxWidth: 100, maxHeight: 100,
  allowedContainers: ['mp4'], allowedVideoCodecs: ['h264'], frameIntervalSeconds: 1, maxFrames: 3 };
const limits = { maxSourceBytes: 3, maxFrameBytes: 4, maxTotalBytes: 12 };
const input = () => ({ assetId: 'asset', sourceVersionId: 'v1', contentType: 'video/mp4', source: new Uint8Array([1, 2, 3]) });
const probe = { format: { duration: '2', format_name: 'mp4' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 48 }] };

test('native sampling decodes every planned JPEG including the final sample', { skip: !process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frames-native-test-')), execute = promisify(execFile);
  try {
    const video = join(directory, 'source.mp4');
    await execute(process.env.TEST_FFMPEG_PATH, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-n', video], { timeout: 10000 });
    const tools = new FfmpegVideoToolAdapter({ ffmpegPath: process.env.TEST_FFMPEG_PATH, ffprobePath: process.env.TEST_FFPROBE_PATH, timeoutMs: 10000 });
    const result = await new FfmpegFrameProcessor(tools, { ...profile, allowedContainers: ['mov,mp4,m4a,3gp,3g2,mj2'] },
      { maxSourceBytes: 100000, maxFrameBytes: 10000, maxTotalBytes: 30000 }).process({ ...input(), source: new Uint8Array(await readFile(video)) });
    assert.equal(result.renditions.length, 3);
    for (const frame of result.renditions) {
      const path = join(directory, 'decoded.jpg'); await writeFile(path, frame.body);
      await execute(process.env.TEST_FFMPEG_PATH, ['-nostdin', '-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], { timeout: 10000 });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sampled frames preserve deterministic ordering, snapshot inputs, and clean attempts', async () => {
  let directory;
  const times = [], policy = structuredClone(profile), budgets = { ...limits }, source = input();
  const extractFrame = async (_path, output, time) => {
    await assert.rejects(stat(output), { code: 'ENOENT' });
    times.push(time); await writeFile(output, new Uint8Array([255, 216, 255, times.length]));
  };
  const processor = new FfmpegFrameProcessor({ probe: async path => {
    directory = dirname(path);
    assert.deepEqual(new Uint8Array(await readFile(path)), new Uint8Array([1, 2, 3]));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    return probe;
  }, extractFrame, extractLastFrame: (path, output) => extractFrame(path, output, 1999) }, policy, budgets);
  const pending = processor.process(source);
  source.source.fill(9); source.sourceVersionId = 'changed'; source.contentType = 'audio/wav';
  policy.allowedContainers.length = 0; policy.maxFrames = 1; budgets.maxTotalBytes = 1;
  const result = await pending;
  assert.deepEqual(times, [0, 1000, 1999]);
  assert.deepEqual(result.renditions.map(frame => frame.id), ['frame:v1:0', 'frame:v1:1000', 'frame:v1:1999']);
  for (const frame of result.renditions) {
    assert.equal(frame.sourceVersionId, 'v1'); assert.equal(frame.role, 'preview'); assert.equal(frame.byteLength, 4);
  }
  assert.equal(result.metadata.frameBytes, 12); assert.equal(result.metadata.contentType, 'video/mp4');
  assert.equal(result.measuredUnits, 3);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('frame failures, malformed output, and all byte/count limits reject without partial results', async () => {
  for (const scenario of ['source', 'crop', 'count', 'per-frame', 'aggregate', 'exact-aggregate', 'jpeg', 'decoder', 'probe']) {
    let directory, calls = 0;
    const tools = { probe: async path => { directory = dirname(path); if (scenario === 'probe') throw new Error('probe failed'); return probe; },
      extractFrame: async (_path, output) => {
        calls++;
        if (scenario === 'decoder' && calls === 2) throw new Error('decoder failed');
        await writeFile(output, scenario === 'jpeg' ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([255, 216, 255, 1]));
      } };
    tools.extractLastFrame = tools.extractFrame;
    const processor = new FfmpegFrameProcessor(tools, { ...profile, maxFrames: scenario === 'count' ? 2 : 3 },
      { ...limits, maxFrameBytes: scenario === 'per-frame' ? 3 : 4, maxTotalBytes: scenario === 'aggregate' ? 7 : scenario === 'exact-aggregate' ? 4 : 12 });
    const source = input();
    if (scenario === 'source') source.source = new Uint8Array(4);
    if (scenario === 'crop') source.squareCrop = {};
    await assert.rejects(processor.process(source), /budget|source|JPEG|failed/);
    if (['source', 'crop', 'count', 'probe'].includes(scenario)) assert.equal(calls, 0);
    if (scenario === 'exact-aggregate') assert.equal(calls, 1);
    if (scenario === 'aggregate' || scenario === 'decoder') assert.equal(calls, 2);
    if (directory) await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    for (const key of Object.keys(limits)) assert.throws(() => new FfmpegFrameProcessor({}, profile, { ...limits, [key]: value }), /budgets/);
    assert.throws(() => new FfmpegFrameProcessor({}, { ...profile, maxFrames: value }, limits), /count/);
  }
});
