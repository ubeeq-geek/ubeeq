import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVimeoAccount, normalizeVimeoVideo, normalizeVimeoVideoPage } from '../dist/index.js';

test('Vimeo account projection retains identity and quota without credentials', () => {
  assert.deepEqual(normalizeVimeoAccount({ uri: '/users/42', name: 'Creator', account: 'pro', access_token: 'private', upload_quota: { space: { free: 100 }, periodic: { reset_date: 'tomorrow' } } }),
    { id: '42', uri: '/users/42', name: 'Creator', accountType: 'pro', uploadQuota: { freeBytes: 100, resetsAt: 'tomorrow' } });
});

test('Vimeo video projection is metadata-only, detached, and preserves zero values', () => {
  const input = { uri: '/videos/7', name: 'Film', duration: 0, privacy: { view: 'unlisted' }, embed: { domains: ['example.test', 1] }, stats: { plays: 0, finishes: 2 }, metadata: { connections: { likes: { total: 3 } } }, download: ['private-original'], files: ['private-original'], upload: { upload_link: 'private' } };
  const result = normalizeVimeoVideo(input);
  assert.equal(result.id, '7'); assert.equal(result.durationSeconds, 0);
  assert.deepEqual(result.stats, { plays: 0, finishes: 2, likes: 3 });
  assert.deepEqual(result.embedDomains, ['example.test']);
  result.embedDomains.push('other.test'); assert.equal(input.embed.domains.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-original|upload_link/);
  assert.equal(normalizeVimeoVideo({ uri: '/videos/8', duration: Infinity }).durationSeconds, undefined);
});

test('Vimeo pages distinguish valid empty results from malformed or partial collections', () => {
  assert.deepEqual(normalizeVimeoVideoPage({ data: [] }, 1), { videos: [], nextPage: undefined });
  assert.equal(normalizeVimeoVideoPage({ data: [{ uri: '/videos/1' }], paging: { next: '/me/videos?page=3' } }, 2).nextPage, 3);
  for (const data of [undefined, null, {}, 'bad', [{ uri: '/videos/1' }, {}]]) assert.throws(() => normalizeVimeoVideoPage({ data }, 1), /Invalid Vimeo/);
  for (const page of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => normalizeVimeoVideoPage({ data: [] }, page));
  for (const uri of ['', '/users/1', '/videos/1/extra', 'https://example.test/videos/1']) assert.throws(() => normalizeVimeoVideo({ uri }));
  assert.throws(() => normalizeVimeoAccount({ uri: '/videos/1' }));
});
