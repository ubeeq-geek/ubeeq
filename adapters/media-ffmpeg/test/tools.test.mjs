import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FfmpegVideoToolAdapter } from '../dist/index.js';
const execute = promisify(execFile);

test('tool adapter uses bounded shell-free local commands and propagates failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-tools-'));
  try {
    const binary = join(root, 'fake-tool.cjs');
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('-show_format')) {
  const mode = fs.readFileSync(args.at(-1), 'utf8');
  if (mode === 'wait') setTimeout(() => {}, 10000);
  else if (mode === 'invalid') process.stdout.write('invalid JSON');
  else if (mode === 'fail') process.exit(2);
  else process.stdout.write(JSON.stringify({ format: { duration: '1' }, args }));
} else fs.writeFileSync(args.at(-1), JSON.stringify(args));
`, { mode: 0o700 });
    const tools = new FfmpegVideoToolAdapter({ ffmpegPath: binary, ffprobePath: binary, timeoutMs: 500 });
    const input = join(root, 'input ; literal.mp4'), output = join(root, 'output ; literal.jpg');
    await writeFile(input, 'ok');
    const probed = await tools.probe(input);
    assert.deepEqual(probed.args.slice(0, 4), ['-v', 'error', '-protocol_whitelist', 'file']);
    assert.equal(probed.args.at(-1), input);
    await tools.extractFrame(input, output, 10249);
    const args = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(args[args.indexOf('-ss') + 1], '10.249');
    assert.equal(args[args.indexOf('-i') + 1], input);
    assert.equal(args[args.indexOf('-vf') + 1], 'scale=min(1920\\,iw):-2');
    await assert.rejects(tools.probe('https://example.test/input'), /absolute local/);
    await assert.rejects(tools.extractFrame(input, output, -1), /timestamp/);
    for (const mode of ['invalid', 'fail', 'wait']) {
      await writeFile(input, mode);
      await assert.rejects(tools.probe(input));
    }
    assert.throws(() => new FfmpegVideoToolAdapter({ ffmpegPath: binary, ffprobePath: binary, timeoutMs: 0 }), /timeout/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed native tools decode a generated video into a JPEG frame', { skip: !process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-video-'));
  try {
    const input = join(root, 'clip.mp4'), output = join(root, 'frame.jpg');
    await execute(process.env.TEST_FFMPEG_PATH, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=10', '-t', '1', '-c:v', 'mpeg4', input], { timeout: 10000 });
    const tools = new FfmpegVideoToolAdapter({ ffmpegPath: process.env.TEST_FFMPEG_PATH, ffprobePath: process.env.TEST_FFPROBE_PATH });
    const probe = await tools.probe(input);
    assert.equal(probe.streams[0].width, 64);
    await tools.extractFrame(input, output, 0);
    const jpeg = await readFile(output);
    assert.deepEqual([...jpeg.subarray(0, 3)], [255, 216, 255]);
    const frame = await tools.probe(output);
    assert.equal(frame.streams[0].width, 64);
    assert.equal(frame.streams[0].height, 48);
  } finally { await rm(root, { recursive: true, force: true }); }
});
