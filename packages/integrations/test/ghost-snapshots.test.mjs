import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ghostReconciliationSnapshot, ghostPublicationHash } from '../dist/index.js';

const base = { title: 'A title', lexical: '{"root":{"type":"root"}}', visibility: 'public', tags: ['one', 'two'] };

test('Ghost snapshots retain legacy serialization defaults and digest', () => {
  const serialized = '{"title":"A title","slug":"","excerpt":"","lexical":"{\\"root\\":{\\"type\\":\\"root\\"}}","visibility":"public","tags":["one","two"],"scheduledAt":"","featureImageAssetId":"","canonicalUrlPolicy":"ghost","canonicalUrl":""}';
  assert.equal(JSON.stringify(ghostReconciliationSnapshot(base)), serialized);
  assert.equal(ghostPublicationHash(base), createHash('sha256').update(serialized).digest('hex'));
  assert.equal(ghostPublicationHash({ ...base, slug: '', canonicalUrlPolicy: '' }), ghostPublicationHash(base));
});

test('Ghost snapshots detach tags and ignore transport and record metadata', () => {
  const source = Object.freeze({ ...base, tags: Object.freeze([...base.tags]), publicationId: 'id', remoteStatus: 'published', updatedAt: 'yesterday' });
  const snapshot = ghostReconciliationSnapshot(source);
  snapshot.tags.push('snapshot-only');
  assert.deepEqual(source.tags, ['one', 'two']);
  assert.equal(ghostPublicationHash(source), ghostPublicationHash(base));
  assert.equal(ghostPublicationHash({ ...source, remoteStatus: 'draft', updatedAt: 'today' }), ghostPublicationHash(base));
  assert.notEqual(ghostPublicationHash({ ...base, tags: [...base.tags].reverse() }), ghostPublicationHash(base));
});

test('every editable Ghost field contributes to the compatible hash and snapshot', () => {
  const changes = { title: 'Changed', slug: 'slug', excerpt: 'Résumé', lexical: 'other content', visibility: 'paid', tags: ['other'], scheduledAt: '2030-01-01', featureImageAssetId: 'asset', canonicalUrlPolicy: 'caller-policy', canonicalUrl: 'https://canonical.example/work' };
  for (const [key, value] of Object.entries(changes)) {
    const changed = { ...base, [key]: value };
    assert.deepEqual(ghostReconciliationSnapshot(changed)[key], value);
    assert.notEqual(ghostPublicationHash(changed), ghostPublicationHash(base), key);
  }
});
