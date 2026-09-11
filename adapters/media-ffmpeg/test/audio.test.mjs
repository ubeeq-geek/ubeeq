import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FfmpegAudioProcessor, FfmpegVideoToolAdapter } from '../dist/index.js';
const profile = { profile: 'test-audio', maxDurationSeconds: 10, maxChannels: 2, maxSampleRate: 48000, maxStreams: 1,
  allowedContainers: ['wav'], allowedAudioCodecs: ['pcm_s16le'] };
const limits = { maxSourceBytes: 1024 * 1024, maxOutputBytes: 100000 };
const input = () => ({ assetId: 'a', sourceVersionId: 'v1', contentType: 'audio/wav', source: new Uint8Array([1, 2, 3]) });
const metadata = output => ({ format: { duration: '1', format_name: output ? 'mp3' : 'wav' }, streams: [{ index: output ? 0 : 2, codec_type: 'audio', codec_name: output ? 'mp3' : 'pcm_s16le', sample_rate: '44100', channels: 2 }] });
const fake = () => {
  const state = { calls: [], directory: undefined, body: new Uint8Array([73, 68, 51, 1]), output: metadata(true), source: metadata(false) };
  state.probe = async path => { state.calls.push('probe'); state.directory = dirname(path); return path.endsWith('.mp3') ? state.output : state.source; };
  state.encodeAudio = async (source, target, options) => {
    state.calls.push('encode'); assert.equal((await stat(source)).mode & 0o777, 0o600);
    assert.equal(options.streamIndex, 2); assert.equal(options.maxDurationSeconds, 1); assert.equal(options.maxOutputBytes, limits.maxOutputBytes);
    await writeFile(target, state.body);
  };
  return state;
};
test('returns source-bound MP3 bytes and cleans private temporary files', async () => {
  const tools = fake(); const result = await new FfmpegAudioProcessor(tools, profile, limits).process(input());
  assert.equal(result.renditions[0].id, 'audio:v1'); assert.equal(result.renditions[0].sourceVersionId, 'v1');
  assert.equal(result.renditions[0].role, 'preview'); assert.equal(result.renditions[0].contentType, 'audio/mpeg');
  assert.deepEqual(result.renditions[0].body, tools.body); assert.equal(result.metadata.renditionDurationSeconds, 1);
  assert.deepEqual(tools.calls, ['probe', 'encode', 'probe']); await assert.rejects(stat(tools.directory), { code: 'ENOENT' });
});
test('snapshots product policy, byte limits, source bytes and lineage', async () => {
  const tools = fake(), mutableProfile = structuredClone(profile), mutableLimits = { ...limits }, source = input();
  const processor = new FfmpegAudioProcessor(tools, mutableProfile, mutableLimits);
  mutableProfile.allowedContainers.length = 0; mutableLimits.maxOutputBytes = 1;
  const encode = tools.encodeAudio;
  tools.encodeAudio = async (path, ...args) => { assert.deepEqual(new Uint8Array(await readFile(path)), new Uint8Array([1, 2, 3])); return encode(path, ...args); };
  const pending = processor.process(source); source.source.fill(9); source.sourceVersionId = 'changed';
  assert.equal((await pending).renditions[0].sourceVersionId, 'v1');
});
test('rejects invalid sources before tools and cleans failures without returning partial outputs', async () => {
  for (const change of [{ source: new Uint8Array() }, { source: new Uint8Array(limits.maxSourceBytes + 1) }, { contentType: 'video/mp4' }, { sourceVersionId: '' }, { squareCrop: { x: 0, y: 0, size: 1 } }]) {
    const tools = fake(); await assert.rejects(new FfmpegAudioProcessor(tools, profile, limits).process({ ...input(), ...change })); assert.equal(tools.calls.length, 0);
  }
  for (const change of [tools => { tools.source.streams = []; }, tools => { tools.body = new Uint8Array(limits.maxOutputBytes + 1); }, tools => { tools.body = new Uint8Array([1, 2, 3]); }, tools => { tools.output.format.duration = '0.5'; }, tools => { tools.output.streams[0].channels = 1; }, tools => { tools.encodeAudio = async () => { throw new Error('decoder failed'); }; }]) {
    const tools = fake(); change(tools); await assert.rejects(new FfmpegAudioProcessor(tools, profile, limits).process(input()));
    await assert.rejects(stat(tools.directory), { code: 'ENOENT' });
  }
});
test('native WAV conversion produces decodable private MP3 without source tags', { skip: !process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-native-test-'));
  const execute = promisify(execFile);
  try {
    const wav = join(directory, 'source.wav'), mp3 = join(directory, 'result.mp3');
    await execute(process.env.TEST_FFMPEG_PATH, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-metadata', 'title=private-fixture-title', '-c:a', 'pcm_s16le', '-n', wav], { timeout: 5000 });
    const tools = new FfmpegVideoToolAdapter({ ffmpegPath: process.env.TEST_FFMPEG_PATH, ffprobePath: process.env.TEST_FFPROBE_PATH, timeoutMs: 5000 });
    const source = new Uint8Array(await readFile(wav));
    const result = await new FfmpegAudioProcessor(tools, profile, limits).process({ ...input(), source });
    await writeFile(mp3, result.renditions[0].body);
    const decoded = await tools.probe(mp3);
    assert.equal(decoded.streams.length, 1); assert.equal(decoded.streams[0].codec_name, 'mp3');
    assert.equal(decoded.streams[0].channels, 2); assert.equal(decoded.streams[0].sample_rate, '44100');
    assert.ok(!JSON.stringify(decoded).includes('private-fixture-title'));
    await execute(process.env.TEST_FFMPEG_PATH, ['-nostdin', '-v', 'error', '-xerror', '-i', mp3, '-f', 'null', '-'], { timeout: 5000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
