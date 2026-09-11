import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicVideoFramePlan, validateFfprobeOutput, extractValidatedFrames } from '../dist/index.js';

const profile = { profile: 'test-v1', maxDurationSeconds: 900, maxWidth: 7680, maxHeight: 4320,
  allowedContainers: ['mov,mp4,m4a,3gp,3g2,mj2'], allowedVideoCodecs: ['h264'], frameIntervalSeconds: 3 };
const probe = { format: { duration: '10.25', format_name: profile.allowedContainers[0], bit_rate: '5000000' },
  streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, side_data_list: [{ rotation: 90 }] }, { codec_type: 'audio', codec_name: 'aac' }] };

test('sampling preserves compatibility cadence and the final decodable millisecond', () => {
  assert.deepEqual(deterministicVideoFramePlan(10.25, 3), [0, 3000, 6000, 9000, 10249]);
  assert.deepEqual(deterministicVideoFramePlan(0.0001, 3), [0]);
  assert.deepEqual(deterministicVideoFramePlan(0.001, 3), [0]);
  assert.deepEqual(deterministicVideoFramePlan(3.001, 3), [0, 3000]);
  assert.equal(deterministicVideoFramePlan(900, 3).length, 301);
});
test('sampling rejects zero-rounded intervals, unsafe arithmetic and oversized plans before allocation', () => {
  for (const duration of [0, -1, NaN, Infinity, Number.MAX_VALUE]) assert.throws(() => deterministicVideoFramePlan(duration, 3));
  for (const interval of [0, -1, NaN, Infinity, 0.0001, Number.MAX_VALUE]) assert.throws(() => deterministicVideoFramePlan(10, interval));
  assert.throws(() => deterministicVideoFramePlan(900, 0.001), /budget/);
  assert.throws(() => deterministicVideoFramePlan(10.25, 3, 4), /budget/);
  assert.deepEqual(deterministicVideoFramePlan(10.25, 3, 5), [0, 3000, 6000, 9000, 10249]);
});
test('video validation retains metadata and rejects malformed geometry and configured admission failures', () => {
  assert.deepEqual(validateFfprobeOutput(probe, profile), { validationProfile: 'test-v1', durationSeconds: 10.25,
    container: profile.allowedContainers[0], videoCodec: 'h264', width: 1920, height: 1080, bitrate: 5000000,
    rotation: 90, hasAudio: true, audioCodec: 'aac', frameTimestampsMs: [0, 3000, 6000, 9000, 10249] });
  for (const width of [-1, 0, 1.5, NaN, Infinity, 9000]) {
    assert.throws(() => validateFfprobeOutput({ ...probe, streams: [{ ...probe.streams[0], width }] }, profile), /dimensions/);
  }
  assert.throws(() => validateFfprobeOutput(probe, { ...profile, maxDurationSeconds: 1 }), /duration/);
  assert.throws(() => validateFfprobeOutput(probe, { ...profile, allowedContainers: [] }), /container/);
  assert.throws(() => validateFfprobeOutput(probe, { ...profile, allowedVideoCodecs: [] }), /codec/);
  assert.throws(() => validateFfprobeOutput(probe, { ...profile, maxWidth: NaN }), /profile/);
  assert.equal(validateFfprobeOutput({ ...probe, format: { ...probe.format, bit_rate: 'bad' } }, profile).bitrate, undefined);
});
test('file sampler snapshots its inputs and uses final-frame capability without masking failure', async () => {
  const calls = [], mutableProfile = structuredClone(profile);
  const tools = { probe: async () => probe, extractFrame: async (...args) => calls.push(args),
    extractLastFrame: async (...args) => calls.push(['last', ...args]) };
  const input = { inputPath: '/input', outputPath: t => `/attempt/${t}.jpg`, profile: mutableProfile, tools };
  const pending = extractValidatedFrames(input);
  input.inputPath = '/changed'; input.outputPath = () => '/wrong'; mutableProfile.allowedContainers.length = 0;
  input.tools = { probe: async () => { throw new Error('wrong tool'); } };
  const result = await pending;
  assert.deepEqual(calls.slice(0, -1).map(call => call[2]), result.frameTimestampsMs.slice(0, -1));
  assert.deepEqual(calls.at(-1), ['last', '/input', '/attempt/10249.jpg']);
  await assert.rejects(extractValidatedFrames({ inputPath: '/input', outputPath: t => `/attempt/${t}.jpg`, profile,
    tools: { ...tools, extractLastFrame: async () => { throw new Error('final decode failed'); } } }), /final decode failed/);
});
test('extraction executes every frame and rejects without returning a completed plan on partial failure', async () => {
  const calls = [];
  const tools = { probe: async () => probe, extractFrame: async (...args) => { calls.push(args); } };
  const input = { inputPath: '/input', outputPath: t => `/attempt/${t}.jpg`, profile, tools };
  const result = await extractValidatedFrames(input);
  assert.deepEqual(calls.map(call => call[2]), result.frameTimestampsMs);
  assert.deepEqual(calls.at(-1), ['/input', '/attempt/10249.jpg', 10249]);
  let attempts = 0;
  await assert.rejects(extractValidatedFrames({ ...input, tools: { ...tools, extractFrame: async () => { if (++attempts === 2) throw new Error('decoder failed'); } } }), /decoder failed/);
  assert.equal(attempts, 2);
  await assert.rejects(extractValidatedFrames({ ...input, profile: { ...profile, maxFrames: 1 } }), /budget/);
});
