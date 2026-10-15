import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planRedditPublication, publishRedditPlan, publishToReddit, RedditApiError } = require('../dist/index.js');

test('plans announcements as either text or link posts', () => {
  assert.deepEqual(planRedditPublication({ type: 'announcement', subreddit: 'art', title: 'Studio news', text: 'A new release is coming.' }), [
    { submission: { kind: 'self', subreddit: 'art', title: 'Studio news', text: 'A new release is coming.' } }
  ]);
  assert.equal(planRedditPublication({ type: 'announcement', subreddit: 'art', title: 'Studio news', publicUrl: 'https://creator.example/news' })[0].submission.kind, 'link');
  assert.throws(() => planRedditPublication({ type: 'announcement', subreddit: 'art', title: 'News', text: 'body', publicUrl: 'https://creator.example/news' }), RedditApiError);
});

test('plans one stable link per work and one link for a collection', () => {
  const works = planRedditPublication({ type: 'works', subreddit: 'art', works: [
    { workId: 'w1', title: 'First', publicUrl: 'https://creator.example/works/1' },
    { workId: 'w2', title: 'Second', publicUrl: 'https://creator.example/works/2', nsfw: true }
  ] });
  assert.deepEqual(works.map(row => row.source), [{ type: 'work', id: 'w1' }, { type: 'work', id: 'w2' }]);
  assert.equal(works[1].submission.nsfw, true);
  const collection = planRedditPublication({ type: 'collection', subreddit: 'art', collection: { collectionId: 'c1', title: 'Collected works', publicUrl: 'https://creator.example/collections/1' } });
  assert.deepEqual(collection[0].source, { type: 'collection', id: 'c1' });
});

test('rejects empty or duplicate work batches and unsafe public URLs', () => {
  assert.throws(() => planRedditPublication({ type: 'works', subreddit: 'art', works: [] }), RedditApiError);
  assert.throws(() => planRedditPublication({ type: 'works', subreddit: 'art', works: [
    { workId: 'same', title: 'One', publicUrl: 'https://creator.example/1' },
    { workId: 'same', title: 'Two', publicUrl: 'https://creator.example/2' }
  ] }), RedditApiError);
  assert.throws(() => planRedditPublication({ type: 'collection', subreddit: 'art', collection: { collectionId: 'c1', title: 'Private', publicUrl: 'http://localhost/private' } }), RedditApiError);
});

test('publishes batches in order and exposes partial receipts without retrying later items', async () => {
  const called = [];
  const client = { async submit(_token, submission) {
    called.push(submission.title);
    if (called.length === 2) throw new RedditApiError('rate limited', 429, 60);
    return { id: 't3_one', url: 'https://www.reddit.com/r/art/comments/one/' };
  } };
  const plan = planRedditPublication({ type: 'works', subreddit: 'art', works: [
    { workId: 'w1', title: 'One', publicUrl: 'https://creator.example/1' },
    { workId: 'w2', title: 'Two', publicUrl: 'https://creator.example/2' },
    { workId: 'w3', title: 'Three', publicUrl: 'https://creator.example/3' }
  ] });
  const result = await publishRedditPlan(client, 'token', plan);
  assert.equal(result.status, 'partially_published');
  assert.equal(result.failedIndex, 1);
  assert.deepEqual(called, ['One', 'Two']);
  assert.deepEqual(result.receipts[0].source, { type: 'work', id: 'w1' });
  assert.equal(result.error.retryAfterSeconds, 60);
});

test('convenience publisher returns collection receipts', async () => {
  const result = await publishToReddit({ async submit() { return { id: 't3_collection', url: 'https://reddit.com/r/art/comments/collection/' }; } }, 'token', {
    type: 'collection', subreddit: 'art', collection: { collectionId: 'c1', title: 'Collection', publicUrl: 'https://creator.example/c/1' }
  });
  assert.equal(result.status, 'published');
  assert.equal(result.receipts[0].remoteId, 't3_collection');
});
