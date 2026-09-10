import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveYouTubeEmbedUrl } from '../dist/index.js';
test('normalizes supported stored video links without passing through remote query controls', () => {
  for (const url of ['https://youtu.be/AbCdEf_123-', 'https://www.youtube.com/watch?v=AbCdEf_123-', 'http://m.youtube.com/watch?v=AbCdEf_123-', 'https://youtube-nocookie.com/embed/AbCdEf_123-']) {
    const result = resolveYouTubeEmbedUrl(`${url}${url.includes('?') ? '&' : '?'}autoplay=1&origin=https://evil.invalid`);
    const parsed = new URL(result.src);
    assert.equal(parsed.origin, 'https://www.youtube-nocookie.com'); assert.equal(parsed.pathname, '/embed/AbCdEf_123-');
    assert.equal(parsed.searchParams.get('autoplay'), null); assert.equal(parsed.searchParams.get('origin'), null);
    assert.equal(parsed.searchParams.get('mute'), '1'); assert.equal(result.isShort, false);
  }
  const short = resolveYouTubeEmbedUrl('https://youtube.com/shorts/AbCdEf_123-', { autoplay: true, muted: false, origin: 'http://localhost:5174' });
  assert.equal(short.isShort, true);
  const parsed = new URL(short.src);
  assert.equal(parsed.searchParams.get('autoplay'), '1'); assert.equal(parsed.searchParams.get('mute'), '0');
  assert.equal(parsed.searchParams.get('origin'), 'http://localhost:5174');
});
test('rejects malformed, credentialed, non-web and deceptive source URLs and invalid origins', () => {
  for (const url of ['', 'not a URL', 'https://youtube.com.evil.invalid/watch?v=abcdef', 'ftp://youtube.com/watch?v=abcdef',
    'https://user:secret@youtube.com/watch?v=abcdef', 'https://youtube.com:444/watch?v=abcdef', 'https://youtu.be/abc',
    'https://youtu.be/abc%2Fdef', 'https://youtu.be/' + 'a'.repeat(8192)]) assert.equal(resolveYouTubeEmbedUrl(url), null);
  for (const origin of ['null', 'file:///tmp', 'https://user@site.test', 'https://site.test/path', 'https://site.test/?query', 'https://site.test/#fragment']) {
    assert.equal(resolveYouTubeEmbedUrl('https://youtu.be/abcdef', { origin }), null);
  }
});
