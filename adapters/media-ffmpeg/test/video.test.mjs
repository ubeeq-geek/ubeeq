import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FfmpegVideoProcessor, FfmpegVideoToolAdapter } from '../dist/index.js';

const profile = { profile: 'fixture', maxDurationSeconds: 10, maxWidth: 1920, maxHeight: 1080,
  allowedContainers: ['mov,mp4,m4a,3gp,3g2,mj2'], allowedVideoCodecs: ['h264'], frameIntervalSeconds: 1, maxFrames: 20,
  allowedAudioCodecs: ['aac'], maxAudioChannels: 2, maxAudioSampleRate: 48000 };
const limits = { maxSourceBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, maxWidth: 320, maxHeight: 240 };
const metadata = () => ({ format: { duration: '1', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 48 }] });
const input = () => ({ source: new Uint8Array([1, 2, 3]), contentType: 'video/mp4', sourceVersionId: 'v1' });
const fake = () => {
  const tools = { source: metadata(), output: metadata(), calls: [], directory: undefined,
    bytes: Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]),
    probe: async path => { tools.directory = dirname(path); tools.calls.push('probe'); return structuredClone(path.endsWith('video.mp4') ? tools.output : tools.source); },
    encodeVideo: async (path, output, options) => { tools.calls.push('encode'); tools.options = options; await writeFile(output, tools.bytes); } };
  return tools;
};
test('returns source-bound MP4 only after output validation and cleans temporary files', async () => {
  const tools = fake(), result = await new FfmpegVideoProcessor(tools, profile, limits).process(input());
  assert.equal(result.renditions[0].id, 'video:v1'); assert.equal(result.renditions[0].contentType, 'video/mp4');
  assert.equal(result.renditions[0].role, 'preview'); assert.equal(result.metadata.renditionWidth, 64);
  assert.deepEqual(tools.calls, ['probe', 'encode', 'probe']); assert.equal(tools.options.hasAudio, false);
  await assert.rejects(stat(tools.directory), { code: 'ENOENT' });
});
test('captures source bytes, version, profile and byte limits before asynchronous work', async () => {
  const tools = fake(), mutableProfile = structuredClone(profile), mutableLimits = { ...limits }, source = input();
  const processor = new FfmpegVideoProcessor(tools, mutableProfile, mutableLimits);
  mutableProfile.allowedVideoCodecs.length = 0; mutableLimits.maxOutputBytes = 1;
  const encode = tools.encodeVideo;
  tools.encodeVideo = async (path, ...args) => { assert.deepEqual([...await readFile(path)], [1, 2, 3]); await encode(path, ...args); };
  const result = processor.process(source); source.source.fill(9); source.sourceVersionId = 'changed';
  assert.equal((await result).renditions[0].sourceVersionId, 'v1');
});
test('rejects oversized/invalid sources, unsupported streams and invalid outputs without partial results', async () => {
  for (const change of [{ source: new Uint8Array() }, { source: new Uint8Array(limits.maxSourceBytes + 1) }, { sourceVersionId: '' },
    { contentType: 'audio/mp3' }, { squareCrop: { x: 0, y: 0, size: 1 } }]) {
    const tools = fake(); await assert.rejects(new FfmpegVideoProcessor(tools, profile, limits).process({ ...input(), ...change }));
    assert.equal(tools.calls.length, 0);
  }
  for (const change of [tools => tools.source.streams.push({ codec_type: 'subtitle' }),
    tools => tools.source.streams.push({ codec_type: 'audio', codec_name: 'bad', channels: 2, sample_rate: '48000' }),
    tools => { tools.bytes = Buffer.alloc(limits.maxOutputBytes + 1); }, tools => { tools.bytes.fill(0); },
    tools => { tools.output.format.duration = '0.2'; }, tools => { tools.output.streams[0].width = 1000; },
    tools => { tools.output.streams[0].codec_name = 'vp9'; }, tools => { tools.encodeVideo = async () => { throw new Error('encode failed'); }; }]) {
    const tools = fake(); change(tools);
    await assert.rejects(new FfmpegVideoProcessor(tools, profile, limits).process(input()));
    await assert.rejects(stat(tools.directory), { code: 'ENOENT' });
  }
});
for (const audio of [false, true]) test(`native MP4 transcoding retains audio=${audio}, respects dimensions and fully decodes`,
  { skip: !process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-native-test-')), execute = promisify(execFile);
    try {
      const sourcePath = join(directory, 'source.mp4'), outputPath = join(directory, 'output.mp4');
      await execute(process.env.TEST_FFMPEG_PATH, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=30:duration=1',
        ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac'] : ['-an']),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'title=private-fixture-title', '-n', sourcePath], { timeout: 10000 });
      const tools = new FfmpegVideoToolAdapter({ ffmpegPath: process.env.TEST_FFMPEG_PATH, ffprobePath: process.env.TEST_FFPROBE_PATH, timeoutMs: 10000 });
      const result = await new FfmpegVideoProcessor(tools, profile, { ...limits, maxWidth: 64, maxHeight: 64 })
        .process({ ...input(), source: new Uint8Array(await readFile(sourcePath)) });
      await writeFile(outputPath, result.renditions[0].body);
      const output = await tools.probe(outputPath);
      assert.equal(output.streams[0].width, 64); assert.equal(output.streams[0].height, 48);
      assert.equal(output.streams.filter(stream => stream.codec_type === 'audio').length, Number(audio));
      assert.equal(JSON.stringify(output).includes('private-fixture-title'), false);
      await execute(process.env.TEST_FFMPEG_PATH, ['-nostdin', '-v', 'error', '-xerror', '-i', outputPath, '-f', 'null', '-'], { timeout: 10000 });
      await assert.rejects(tools.encodeVideo(sourcePath, outputPath, { maxDurationSeconds: 1, maxOutputBytes: limits.maxOutputBytes, maxWidth: 64, maxHeight: 64, hasAudio: audio }));
      assert.deepEqual(new Uint8Array(await readFile(outputPath)), result.renditions[0].body);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
