import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSlideshowSettings, slideshowDurationSeconds, slideshowDimensions } from '../dist/index.js';

test('slideshow defaults are silent, four seconds, crossfade and landscape', () => {
  const settings = normalizeSlideshowSettings();
  assert.deepEqual(settings, { slideDurationSeconds: 4, transition: 'crossfade', transitionDurationSeconds: 0.5, format: 'landscape', music: [], loopMusic: true, musicFadeOutSeconds: 2 });
  assert.equal(slideshowDurationSeconds(3, settings), 11);
  assert.equal(slideshowDurationSeconds(1, settings), 4);
  assert.equal(slideshowDurationSeconds(3, normalizeSlideshowSettings({ transition: 'cut' })), 12);
  assert.deepEqual(slideshowDimensions('portrait'), { width: 1080, height: 1920 });
  assert.deepEqual(slideshowDimensions('square'), { width: 1080, height: 1080 });
});
test('settings capture music order and trim ranges without retaining caller references', () => {
  const input = { music: [{ assetId: 'one', startSeconds: 1, endSeconds: 3 }, { assetId: 'two' }] };
  const settings = normalizeSlideshowSettings(input);
  input.music[0].assetId = 'changed';
  assert.deepEqual(settings.music, [{ assetId: 'one', startSeconds: 1, endSeconds: 3 }, { assetId: 'two', startSeconds: 0 }]);
});
test('invalid settings, excessive overlap, empty/oversized collections and budgets fail closed', () => {
  for (const input of [null, [], { slideDurationSeconds: '4' }, { slideDurationSeconds: NaN }, { slideDurationSeconds: 0 }, { transition: 'wipe' }, { format: 'custom' }, { transitionDurationSeconds: 3 }, { transitionDurationSeconds: 0 }, { loopMusic: 'yes' }, { music: [{}] }, { music: Array(11).fill({ assetId: 'a' }) }, { music: [{ assetId: 'a', startSeconds: 3, endSeconds: 2 }] }, { musicFadeOutSeconds: Infinity }]) assert.throws(() => normalizeSlideshowSettings(input), { code: 'invalid_slideshow' });
  for (const count of [0, -1, 1.5, 101]) assert.throws(() => slideshowDurationSeconds(count, normalizeSlideshowSettings()));
  assert.throws(() => slideshowDurationSeconds(100, normalizeSlideshowSettings({ slideDurationSeconds: 60, transition: 'cut' })));
});
