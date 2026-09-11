import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSoundCloudTrack as track, normalizeSoundCloudComment as comment, normalizeSoundCloudActivity as activity } from '../dist/index.js';
import { normalizeSoundCloudAccount as account, normalizeSoundCloudProfile as profile, normalizeSoundCloudPlaylist as playlist,
  normalizeSoundCloudFavouriteUser as favouriteUser } from '../dist/index.js';
test('account and favourite-user normalization retain authoritative IDs with distinct missing-identity behavior', () => {
  const input = Object.freeze({ urn: ' user:1 ', id: 2, username: ' Artist ', avatar_url: ' https://example.test/avatar ' });
  assert.deepEqual(account(input), { externalUserId: 'user:1', externalUsername: 'Artist' });
  assert.deepEqual(favouriteUser(input), { externalUserId: 'user:1', username: 'Artist', avatarUrl: 'https://example.test/avatar', rawPayload: input });
  assert.equal(account({ id: 0, username: 'Zero' }).externalUserId, '0');
  for (const value of [null, [], {}, { id: -1, username: 'Artist' }, { id: Number.MAX_SAFE_INTEGER + 1, username: 'Artist' }, { id: 1, username: ' ' }]) {
    assert.throws(() => account(value), { code: 'invalid_response' });
    assert.equal(favouriteUser(value), null);
  }
});
test('profile normalization retains optional fields and existing metric coercion without inventing identity', () => {
  const input = Object.freeze({ permalink_url: ' https://example.test/artist ', avatar_url: 'avatar', full_name: ' Name ', country: ' CA ',
    website: 'website', description: ' Bio ', followers_count: '12', followings_count: 0, track_count: 'bad', public_favorites_count: 5, comments_count: null });
  const result = profile(input);
  assert.deepEqual(result, { profileUrl: 'https://example.test/artist', avatarUrl: 'avatar', realName: 'Name', country: 'CA', website: 'website', bio: 'Bio',
    stats: { watchers: 12, friends: 0, deviations: undefined, favourites: 5, comments: 0 }, rawPayload: input });
  assert.equal(result.rawPayload, input);
  assert.equal(profile(null).profileUrl, undefined);
  assert.equal(profile({}).stats.watchers, undefined);
});
test('playlist normalization preserves IDs, fallback title, size and raw metadata without loading tracks', () => {
  const input = Object.freeze({ urn: 'playlist:1', id: 2, title: ' List ', description: ' Description ', track_count: '3', tracks: [{ id: 7 }] });
  assert.deepEqual(playlist(input), { externalCollectionId: 'playlist:1', name: 'List', description: 'Description', size: 3, rawMetadata: input });
  assert.equal(playlist({ id: 0 }).name, 'Untitled SoundCloud playlist');
  for (const value of [null, [], {}, { id: -1 }, { id: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(playlist(value), null);
});
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

test('incomplete activity identity fails the page instead of generating colliding type-only IDs', () => {
  const complete = { type: 'track-like', user: { id: 3 }, track: { id: 2 }, created_at: '2026-01-01T00:00:00Z' };
  for (const input of [null, {}, { type: 'track-like' }, { ...complete, type: undefined }, { ...complete, user: undefined },
    { ...complete, track: undefined }, { ...complete, created_at: undefined }, { ...complete, created_at: 'invalid' }]) {
    assert.throws(() => activity(input), { name: 'ExternalProviderError', code: 'invalid_response' });
  }
  // An authoritative provider identifier remains usable without inferred fields.
  assert.equal(activity({ id: 7 }).sourceMessageId, '7');
  assert.equal(activity({ urn: 'event:7' }).sourceMessageId, 'event:7');
});
