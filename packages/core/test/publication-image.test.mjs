import test from 'node:test';
import assert from 'node:assert/strict';
import { inheritedPublicationImageSelection, resolvePublicationImageSelection, validatePublicationImageSelection,
  publicationImageFingerprint, comparePublicationImage } from '../dist/index.js';

const validateWatermark = value => {
  if (!value || typeof value.text !== 'string' || value.text.length > 100) throw Error('Invalid watermark');
  return { text: value.text };
};
const input = () => ({
  work: { tenantId: 't', creatorId: 'c', workId: 'w', preferences: {} },
  publication: { tenantId: 't', creatorId: 'c', workId: 'w', publicationId: 'p', connectionId: 'connection', destination: 'da' },
  connection: { tenantId: 't', creatorId: 'c', connectionId: 'connection', destination: 'da' },
  creator: { tenantId: 't', creatorId: 'c', preferences: { platforms: { da: 'reduced' }, watermark: { text: 'Creator' } } },
  collections: [], platform: { variant: 'original' }, validateWatermark,
  variants: Object.fromEntries(['original', 'thumbnail', 'reduced', 'share', 'share-alternate', 'watermarked-original'].map(v => [v, { enabled: true, available: true, width: 500, height: 400, recipeFingerprint: v }]))
});
const override = (variant, watermark) => ({ ...inheritedPublicationImageSelection(), variant: { mode: 'override', value: variant },
  ...(watermark ? { watermark: { mode: 'override', value: { text: watermark } } } : {}) });
const collection = (id, preferences = {}) => ({ tenantId: 't', creatorId: 'c', collectionId: id, workIds: ['w'], preferences });

test('legacy inheritance, explicit Original and independent variant/watermark inheritance', async () => {
  const data = input();
  assert.equal((await resolvePublicationImageSelection(data)).variant, 'reduced');
  data.collections = [collection('collection', { default: 'share', watermark: { text: 'Collection' } })];
  data.work.preferences = { default: 'thumbnail', connections: { connection: 'share-alternate' } };
  let r = await resolvePublicationImageSelection(data);
  assert.equal(r.variant, 'share-alternate'); assert.equal(r.provenance.variant.source, 'work');
  data.publication.imageSelection = override('original', 'Volume');
  r = await resolvePublicationImageSelection(data);
  assert.equal(r.variant, 'original'); assert.equal(r.watermark.text, 'Volume'); assert.equal(r.watermarkDormant, true);
  assert.equal(r.provenance.variant.source, 'publication');
  data.publication.imageSelection.variant = { mode: 'inherit' };
  r = await resolvePublicationImageSelection(data);
  assert.equal(r.variant, 'share-alternate'); assert.equal(r.watermark.text, 'Volume'); assert.equal(r.watermarkDormant, false);
  data.publication.imageSelection = inheritedPublicationImageSelection();
  assert.equal((await resolvePublicationImageSelection(data)).watermark.text, 'Collection');
});

test('every existing preference priority is preserved', async () => {
  const data = input();
  data.creator.preferences.connections = { connection: 'watermarked-original' };
  data.collections = [collection('one', { default: 'thumbnail', platforms: { da: 'share' }, connections: { connection: 'share-alternate' } })];
  data.work.preferences = { default: 'original', connections: { connection: 'reduced' } };
  for (const [expected, mutate] of [
    ['reduced', () => delete data.work.preferences.connections], ['original', () => delete data.work.preferences.default],
    ['share-alternate', () => delete data.collections[0].preferences.connections], ['share', () => delete data.collections[0].preferences.platforms],
    ['thumbnail', () => delete data.collections[0].preferences.default], ['watermarked-original', () => delete data.creator.preferences.connections],
    ['reduced', () => { data.creator.preferences = {}; }], ['original', () => {}]
  ]) { assert.equal((await resolvePublicationImageSelection(data)).variant, expected); mutate(); }
});

test('multiple collections never pick the first; explicit missing/foreign context and request mismatch block', async () => {
  const data = input(); data.collections = [collection('one', { default: 'share' }), collection('two', { default: 'original' })];
  assert.equal((await resolvePublicationImageSelection(data)).collectionId, undefined);
  data.publication.imageSelection = { ...override('share'), context: { mode: 'collection', collectionId: 'two' } };
  assert.equal((await resolvePublicationImageSelection(data)).collectionId, 'two');
  data.requestedCollectionId = 'one';
  assert.deepEqual((await resolvePublicationImageSelection(data)).blockers, ['publication_context_unavailable']);
  delete data.requestedCollectionId; data.collections[1].workIds = [];
  assert.deepEqual((await resolvePublicationImageSelection(data)).blockers, ['publication_context_unavailable']);
  data.collections[1].workIds = ['w']; data.collections[1].creatorId = 'foreign';
  assert.deepEqual((await resolvePublicationImageSelection(data)).blockers, ['publication_context_unavailable']);
  data.publication.imageSelection.context = { mode: 'inherit' }; data.work.defaultsCollectionId = 'two';
  assert.deepEqual((await resolvePublicationImageSelection(data)).blockers, ['publication_context_unavailable']);
});

test('optional unavailable variant blocks without enabling it or substituting Original', async () => {
  const data = input(); data.publication.imageSelection = override('share-alternate'); data.variants['share-alternate'].enabled = false;
  const r = await resolvePublicationImageSelection(data);
  assert.equal(r.variant, 'share-alternate'); assert.deepEqual(r.blockers, ['publication_image_unavailable']);
  assert.equal(data.variants['share-alternate'].enabled, false);
});

test('adapter watermark policy is retained without marking an explicit Original', async () => {
  const data = input(); data.publication.imageSelection = override('reduced'); data.variants.reduced.watermarkEnabled = true;
  assert.equal((await resolvePublicationImageSelection(data)).watermarkDormant, false);
  data.publication.imageSelection = override('share'); data.variants.share.watermarkEnabled = false;
  assert.equal((await resolvePublicationImageSelection(data)).watermarkDormant, true);
  data.publication.imageSelection = override('original'); data.variants.original.watermarkEnabled = true;
  assert.equal((await resolvePublicationImageSelection(data)).watermarkDormant, true);
});

test('only effective dependencies change inherited image fingerprints; config revision has its own approval fingerprint', async () => {
  const data = input(); data.publication.imageSelection = override('original', 'Volume');
  const before = await resolvePublicationImageSelection(data);
  data.creator.preferences = { default: 'share', watermark: { text: 'Changed' } };
  assert.equal((await resolvePublicationImageSelection(data)).dependencyFingerprint, before.dependencyFingerprint);
  data.publication.imageSelection.watermark.value.text = 'Dormant edit'; data.publication.configurationRevision = 1;
  const after = await resolvePublicationImageSelection(data);
  assert.equal(after.imageFingerprint, before.imageFingerprint); assert.notEqual(after.dependencyFingerprint, before.dependencyFingerprint);
  data.variants.original.recipeFingerprint = 'size-change';
  assert.notEqual((await resolvePublicationImageSelection(data)).imageFingerprint, before.imageFingerprint);
});

test('safe read projection, tenant boundaries and strict settings validation', async () => {
  const data = input(); data.publication.providerData = { secret: 'private-key' }; data.connection.credentials = 'private-key';
  assert.equal(JSON.stringify(await resolvePublicationImageSelection(data)).includes('private-key'), false);
  data.connection.creatorId = 'other'; await assert.rejects(resolvePublicationImageSelection(data), { code: 'publication_not_found' });
  for (const bad of [null, {}, { ...override('original'), url: 'https://example.com' }, { ...override('original'), variant: { mode: 'inherit', value: 'original' } },
    { ...override('original'), context: { mode: 'collection', collectionId: '  ' } }, override('unknown')]) assert.throws(() => validatePublicationImageSelection(bad, validateWatermark));
  assert.throws(() => validatePublicationImageSelection(override('share', 'x'.repeat(101)), validateWatermark), /Invalid watermark/);
});

test('drift distinguishes unknown, source, variant, recipe and watermark; keep expires only for relevant changes', async () => {
  const data = input(); data.publication.imageSelection = override('share');
  const resolution = await resolvePublicationImageSelection(data);
  const current = { resolution, sourceAssetId: 'asset', sourceChecksum: 'source', recipeFingerprint: 'recipe', watermarkFingerprint: 'watermark' };
  assert.deepEqual((await comparePublicationImage(current)).reasons, ['unknown_delivery']);
  const confirmed = { operationId: 'op', imageFingerprint: resolution.imageFingerprint, sourceAssetId: 'asset', sourceChecksum: 'source',
    variant: 'original', recipeFingerprint: 'recipe', watermarkFingerprint: 'watermark', width: 500, height: 400 };
  const change = await comparePublicationImage({ ...current, confirmed });
  assert.deepEqual(change.reasons, ['variant_changed']);
  assert.equal((await comparePublicationImage({ ...current, confirmed, acceptedDifferenceFingerprint: change.fingerprint })).accepted, true);
  assert.equal((await comparePublicationImage({ ...current, confirmed, sourceChecksum: 'changed', acceptedDifferenceFingerprint: change.fingerprint })).accepted, false);
  assert.deepEqual((await comparePublicationImage({ ...current, confirmed, sourceChecksum: 'changed', recipeFingerprint: 'new', watermarkFingerprint: 'new' })).reasons,
    ['source_changed', 'variant_changed', 'recipe_changed', 'watermark_changed']);
  assert.equal(await publicationImageFingerprint({ a: 1, b: 2 }), await publicationImageFingerprint({ b: 2, a: 1 }));
});
