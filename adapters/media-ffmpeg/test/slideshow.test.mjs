import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FfmpegSlideshowRenderer, FfmpegVideoToolAdapter } from '../dist/index.js';
import { normalizeSlideshowSettings } from '@ubeeq/core';

const ffmpegPath = process.env.TEST_FFMPEG_PATH, ffprobePath = process.env.TEST_FFPROBE_PATH;
const execute = promisify(execFile);
test('slideshow renderer rejects unsupported sources and budgets before executing tools', async () => {
  const renderer = new FfmpegSlideshowRenderer({ ffmpegPath: '/missing', ffprobePath: '/missing', maxSourceBytes: 4 });
  for (const slides of [[], [{ contentType: 'image/png', source: new Uint8Array(5) }], [{ contentType: 'image/svg+xml', source: new Uint8Array(1) }]]) await assert.rejects(renderer.render({ settings: normalizeSlideshowSettings(), slides, music: [] }));
  assert.throws(() => new FfmpegSlideshowRenderer({ ffmpegPath: '', ffprobePath: '/missing' }));
});
for (const [format, transition, withMusic, loopMusic = true, imageCount = 3] of [['landscape', 'crossfade', true], ['portrait', 'cut', false], ['square', 'crossfade', false], ['square', 'cut', true, false], ['landscape', 'crossfade', false, true, 1]]) {
  test(`native ${format} ${transition} slideshow: images=${imageCount} music=${withMusic} loop=${loopMusic} fully decodes`, { skip: !ffmpegPath || !ffprobePath }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'slideshow-test-'));
    try {
      const slides = [];
      for (const [i, color] of (imageCount === 1 ? ['red'] : ['red', 'green', 'blue']).entries()) {
        const path = join(directory, `${i}.png`);
        await execute(ffmpegPath, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=${color}:size=${i ? '24x32' : '32x24'}`, '-frames:v', '1', '-threads', '1', '-n', path]);
        slides.push({ contentType: 'image/png', source: new Uint8Array(await readFile(path)) });
      }
      const music = [];
      if (withMusic) {
        const path = join(directory, 'music.wav');
        await execute(ffmpegPath, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-n', path]);
        const track = { contentType: 'audio/wav', source: new Uint8Array(await readFile(path)) };
        music.push(track, track);
      }
      const settings = normalizeSlideshowSettings({ format, transition, loopMusic, slideDurationSeconds: 0.5, transitionDurationSeconds: 0.1, music: withMusic ? [{ assetId: 'a', startSeconds: 0.1, endSeconds: 0.3 }, { assetId: 'b', startSeconds: 0.2, endSeconds: 0.4 }] : [], musicFadeOutSeconds: 0.2 });
      const renderer = new FfmpegSlideshowRenderer({ ffmpegPath, ffprobePath, timeoutMs: 30000 });
      const pending = renderer.render({ settings, slides, music });
      slides[0].source.fill(0); // Rendering captures caller bytes before asynchronous work.
      const result = await pending, path = join(directory, 'result.mp4');
      await writeFile(path, result.body);
      const probe = await new FfmpegVideoToolAdapter({ ffmpegPath, ffprobePath }).probe(path);
      assert.equal(probe.streams.filter(s => s.codec_type === 'audio').length, Number(withMusic));
      assert.equal(probe.streams[0].codec_name, 'h264');
      assert.equal(probe.streams[0].width, result.width); assert.equal(probe.streams[0].height, result.height);
      assert.ok(Math.abs(Number(probe.format.duration) - (imageCount === 1 ? 0.5 : transition === 'cut' ? 1.5 : 1.3)) < 0.1);
      await execute(ffmpegPath, ['-nostdin', '-v', 'error', '-xerror', '-i', path, '-f', 'null', '-']);
      // Confirm the ordered first and last images survive transitions and letterboxing.
      for (const [time, channel] of imageCount === 1 ? [['0', 0]] : [['0', 0], ['1.2', 2]]) {
        const { stdout } = await execute(ffmpegPath, ['-nostdin', '-v', 'error', '-ss', time, '-i', path, '-vf', 'crop=2:2:iw/2:ih/2,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
        assert.ok(stdout[channel] > 200, `Expected color channel ${channel} at ${time}s`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('native failures and output-budget truncation remove all temporary attempt files', { skip: !ffmpegPath || !ffprobePath }, async () => {
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('collection-slideshow-')));
  const renderer = new FfmpegSlideshowRenderer({ ffmpegPath, ffprobePath, maxOutputBytes: 16 });
  const settings = normalizeSlideshowSettings({ slideDurationSeconds: 0.5 });
  await assert.rejects(renderer.render({ settings, slides: [{ contentType: 'image/png', source: new Uint8Array([1, 2, 3]) }], music: [] }));
  const directory = await mkdtemp(join(tmpdir(), 'slideshow-failure-test-'));
  try {
    const path = join(directory, 'source.png');
    await execute(ffmpegPath, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=red:size=32x32', '-frames:v', '1', '-threads', '1', '-n', path]);
    await assert.rejects(renderer.render({ settings, slides: [{ contentType: 'image/png', source: new Uint8Array(await readFile(path)) }], music: [] }), /budget|validation/);
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('collection-slideshow-') && !before.has(name)), []);
});
