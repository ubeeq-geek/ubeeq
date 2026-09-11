import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateAudioFfprobeOutput } from '../dist/index.js';
const profile = { profile: 'audio-test', maxDurationSeconds: 600, maxChannels: 2, maxSampleRate: 48000, maxStreams: 2,
  allowedContainers: ['mp3', 'wav'], allowedAudioCodecs: ['mp3', 'pcm_s16le'] };
const probe = () => ({ format: { duration: '12.5', format_name: 'mp3', tags: { private: 'omit' } }, streams: [{ index: 3, codec_type: 'audio', codec_name: 'mp3', sample_rate: '48000', channels: 2 }] });
test('returns only bounded admission metadata and an explicit audio stream index', () => {
  assert.deepEqual(validateAudioFfprobeOutput(probe(), profile), { validationProfile: 'audio-test', durationSeconds: 12.5, container: 'mp3', audioCodec: 'mp3', streamIndex: 3, channels: 2, sampleRate: 48000, hasAttachedPicture: false });
});
test('limits both durations and rejects coercible malformed values', () => {
  for (const value of ['', ' ', '0', '-1', 'Infinity', 'NaN', '0x10', '1e2', 12, null, '601']) {
    const input = probe(); input.format.duration = value; assert.throws(() => validateAudioFfprobeOutput(input, profile));
  }
  const input = probe(); input.streams[0].duration = '601';
  assert.throws(() => validateAudioFfprobeOutput(input, profile), /duration exceeds/);
  input.streams[0].duration = '20'; assert.equal(validateAudioFfprobeOutput(input, profile).durationSeconds, 20);
  input.streams[0].duration = 'N/A'; assert.equal(validateAudioFfprobeOutput(input, profile).durationSeconds, 12.5);
});
test('requires exact codec/container admission and bounded sampling geometry', () => {
  for (const [field, value] of [['codec_name', 'aac'], ['channels', 3], ['channels', 0], ['channels', 1.5], ['channels', '2'], ['sample_rate', '48001'], ['sample_rate', '1.5'], ['sample_rate', 'N/A']]) {
    const input = probe(); input.streams[0][field] = value; assert.throws(() => validateAudioFfprobeOutput(input, profile));
  }
  const input = probe(); input.format.format_name = 'mp3,unknown'; assert.throws(() => validateAudioFfprobeOutput(input, profile), /container/);
});
test('rejects ambiguous audio, moving video, unknown streams and invalid indexes', () => {
  for (const stream of [{ index: 4, codec_type: 'audio' }, { index: 4, codec_type: 'video' }, { index: 4, codec_type: 'subtitle' }, null]) {
    const input = probe(); input.streams.push(stream); assert.throws(() => validateAudioFfprobeOutput(input, { ...profile, allowAttachedPicture: true }));
  }
  for (const index of [undefined, -1, 0.5]) { const input = probe(); input.streams[0].index = index; assert.throws(() => validateAudioFfprobeOutput(input, profile)); }
});
test('attached artwork requires explicit policy without changing selected audio', () => {
  const input = probe(); input.streams.unshift({ index: 0, codec_type: 'video', disposition: { attached_pic: 1 } });
  assert.throws(() => validateAudioFfprobeOutput(input, profile));
  const result = validateAudioFfprobeOutput(input, { ...profile, allowAttachedPicture: true });
  assert.equal(result.hasAttachedPicture, true); assert.equal(result.streamIndex, 3);
  input.streams[0].index = 3; assert.throws(() => validateAudioFfprobeOutput(input, { ...profile, allowAttachedPicture: true }), /unique/);
});
test('validates product budgets and rejects oversized stream sets', () => {
  for (const change of [{ maxStreams: 0 }, { maxChannels: NaN }, { maxSampleRate: -1 }, { maxDurationSeconds: Infinity }, { allowedContainers: [] }, { allowedAudioCodecs: [''] }, { allowAttachedPicture: 'true' }]) {
    assert.throws(() => validateAudioFfprobeOutput(probe(), { ...profile, ...change }), /profile/);
  }
  const input = probe(); input.streams.push({}, {}); assert.throws(() => validateAudioFfprobeOutput(input, profile), /stream set/);
});
test('admits real FFprobe metadata for a generated PCM WAV fixture', { skip: !process.env.TEST_FFPROBE_PATH }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ubeeq-audio-probe-'));
  try {
    const bytes = Buffer.alloc(44 + 9600);
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(9600, 40);
    const source = join(directory, 'fixture.wav'); await writeFile(source, bytes, { flag: 'wx', mode: 0o600 });
    const { stdout } = await promisify(execFile)(process.env.TEST_FFPROBE_PATH, ['-v', 'error', '-protocol_whitelist', 'file', '-show_format', '-show_streams', '-of', 'json', source], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const result = validateAudioFfprobeOutput(JSON.parse(stdout), profile);
    assert.equal(result.durationSeconds, 0.1); assert.equal(result.channels, 1); assert.equal(result.sampleRate, 48000); assert.equal(result.audioCodec, 'pcm_s16le'); assert.equal(result.streamIndex, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
