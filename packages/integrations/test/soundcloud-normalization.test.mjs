import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSoundCloudTrack as track, normalizeSoundCloudComment as comment, normalizeSoundCloudActivity as activity } from '../dist/index.js';
test('track normalization preserves external metadata, quoted tags and blocked state without an audio source', () => {
  const input = { urn: 'soundcloud:tracks:1', id: 2, title: ' Track ', tag_list: 'one "two words"', access: 'blocked', created_at: 1700000000, playback_count: '12', download_url: 'https://example.test/private-audio' };
  const result = track(input);
  assert.equal(result.externalContentId, input.urn); assert.equal(result.title, 'Track');
  assert.deepEqual(result.tags, ['one', 'two words']); assert.equal(result.remoteState, 'restricted');
  assert.equal(result.assetType, 'audio'); assert.equal(result.content, undefined); assert.equal(result.metrics.views, 12);
  assert.equal(result.publishedAt, new Date(1700000000000).toISOString()); assert.deepEqual(result.rawMetadata, input);
  assert.equal(track({ id: 0 }).externalContentId, '0');
  for (const input of [null, [], {}, { id: -1 }, { id: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(track(input), null);
});
test('timed comment normalization retains author, parent and position identities', () => {
  const result = comment({ id: 7, user: { id: 8, username: ' Author ' }, parent_id: 6, timestamp: '1200', body: ' Text ', created_at: '2026-01-01T00:00:00Z' });
  assert.equal(result.externalCommentId, '7'); assert.equal(result.authorId, '8'); assert.equal(result.authorName, 'Author');
  assert.equal(result.parentExternalCommentId, '6'); assert.equal(result.positionMilliseconds, 1200); assert.equal(result.body, 'Text');
  assert.equal(comment({}), null);
});
test('activity normalization retains provider IDs and deterministic fallback identity', () => {
  const input = { type: 'track-like', origin: { track: { id: 2, title: 'Track' }, user: { id: 3, username: 'User' } }, created_at: 1700000000 };
  const first = activity(input); assert.deepEqual(activity(input), first);
  assert.equal(first.type, 'favourite'); assert.equal(first.externalContentId, '2'); assert.equal(first.actorId, '3');
  assert.equal(first.remoteActivityId, 'soundcloud:track-like:3:2:2023-11-14T22:13:20.000Z');
  assert.equal(activity({ ...input, urn: 'event:1' }).sourceMessageId, 'event:1');
});
