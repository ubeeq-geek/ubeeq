import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { detectWordPressCapabilities, wordPressPostSnapshot, diffWordPressSnapshots } from '../dist/index.js';

test('WordPress capability discovery supports both REST method representations and permission combinations', () => {
  const paths = ['/wp/v2/posts', '/wp/v2/pages', '/wp/v2/media', '/wp/v2/categories', '/wp/v2/tags'];
  for (const representation of ['methods', 'endpoints']) {
    for (const hasRoute of [false, true]) {
      for (const granted of [false, true]) {
        const routes = hasRoute ? Object.fromEntries(paths.map(path => [path, representation === 'methods'
          ? { methods: ['GET', 'POST'] } : { endpoints: [{ methods: ['GET'] }, { methods: ['POST'] }] }])) : {};
        const capabilities = Object.fromEntries(['edit_posts', 'edit_pages', 'upload_files', 'manage_categories', 'publish_posts', 'edit_others_posts'].map(key => [key, granted]));
        assert.deepEqual(detectWordPressCapabilities({ capabilities }, routes), {
          postsRead: hasRoute, postsWrite: hasRoute && granted,
          pagesRead: hasRoute, pagesWrite: hasRoute && granted,
          mediaUpload: hasRoute && granted, categoriesWrite: hasRoute && granted,
          tagsWrite: hasRoute && granted, schedule: granted, authorAssignment: granted,
          featuredMedia: hasRoute, blockFormat: true, classicHtmlFormat: true, webhookAdapter: false
        });
      }
    }
  }
});

test('WordPress missing or malformed discovery does not imply route support', () => {
  const empty = detectWordPressCapabilities(null, null);
  for (const routes of [{}, { '/wp/v2/posts': null }, { '/wp/v2/posts': { methods: 'POST', endpoints: [null, {}, { methods: 'POST' }] } }]) {
    assert.deepEqual(detectWordPressCapabilities({}, routes), empty);
  }
  assert.equal(empty.postsWrite, false);
  assert.equal(empty.mediaUpload, false);
  assert.equal(empty.webhookAdapter, false);
  // These flags describe serializer support, not permission to publish.
  assert.equal(empty.blockFormat, true);
  assert.equal(empty.classicHtmlFormat, true);
});

test('WordPress snapshots retain editable fields, legacy serialization and hashes, not volatile metadata', () => {
  const remote = { id: 8, modified_gmt: 'ignored', link: 'https://site.example/post',
    title: { raw: 'Raw title', rendered: 'Rendered title' }, slug: 'story', excerpt: { rendered: 'Intro' },
    content: { raw: '', rendered: 'Not the raw content' }, status: 'private',
    date_gmt: '2026-01-01T00:00:00', date: 'ignored', author: 12,
    categories: [2, '3', 1.5, 4], tags: [6, null, 7], featured_media: 11 };
  const before = structuredClone(remote);
  const expected = { title: 'Raw title', slug: 'story', excerpt: 'Intro', content: '', status: 'private',
    date: '2026-01-01T00:00:00', author: 12, categories: [2, 4], tags: [6, 7], featuredMediaId: 11 };
  const snapshot = wordPressPostSnapshot(remote);
  assert.deepEqual(snapshot, expected);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(digest(snapshot), digest(expected));
  assert.deepEqual(wordPressPostSnapshot({ ...remote, id: 99, modified_gmt: 'changed', link: 'changed' }), expected);
  snapshot.categories.push(100);
  snapshot.tags.push(100);
  assert.deepEqual(remote, before);
});

test('WordPress snapshot fallbacks preserve empty values and omit invalid numeric fields', () => {
  assert.deepEqual(wordPressPostSnapshot(null), { title: '', slug: '', excerpt: '', content: '', status: '', date: '',
    author: undefined, categories: [], tags: [], featuredMediaId: undefined });
  assert.deepEqual(wordPressPostSnapshot({ title: 'Title', excerpt: { raw: 9, rendered: 'Excerpt' }, content: 42,
    date_gmt: '', date: 'local-date', author: '4', featured_media: 0, categories: 'invalid', tags: {} }), {
    title: 'Title', slug: '', excerpt: 'Excerpt', content: '', status: '', date: 'local-date',
    author: undefined, categories: [], tags: [], featuredMediaId: undefined
  });
});

test('WordPress diffs compare every editable field and preserve ordered taxonomy changes', () => {
  const local = wordPressPostSnapshot(null);
  const remote = { title: 'Title', slug: 'slug', excerpt: 'Intro', content: 'Body', status: 'publish', date: 'date',
    author: 1, categories: [2, 3], tags: [4, 5], featuredMediaId: 6 };
  assert.deepEqual(diffWordPressSnapshots(local, remote), Object.keys(local).map(field => ({ field, local: local[field], remote: remote[field] })));
  assert.deepEqual(diffWordPressSnapshots(remote, structuredClone(remote)), []);
  assert.deepEqual(diffWordPressSnapshots(remote, { ...remote, categories: [3, 2] }), [{ field: 'categories', local: [2, 3], remote: [3, 2] }]);
});
