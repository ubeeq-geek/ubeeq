import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsCollectionReleaseCompletion, collectionPlanOwnsAnnouncement,
  createAnnouncementPublication, createPlannedAnnouncementDeliverySnapshot, assertPlannedAnnouncementDeliveryImmutable } from '../dist/index.js';

test('completion support requires explicit revision, placement, audience and representation capabilities', () => {
  const capability = { schemaVersion: 1, exactContentRevision: true, collectionPlacement: true, effectiveAudience: true,
    activeDeploymentRevision: true, requiredContentMessages: true };
  for (const kind of ['native', 'website', 'external_gallery', 'collection_forum', 'adapter']) {
    assert.equal(supportsCollectionReleaseCompletion(capability, { kind }), true);
    for (const flag of ['exactContentRevision', 'collectionPlacement', 'effectiveAudience'])
      assert.equal(supportsCollectionReleaseCompletion({ ...capability, [flag]: false }, { kind }), false);
  }
  assert.equal(supportsCollectionReleaseCompletion({ ...capability, activeDeploymentRevision: false }, { kind: 'website' }), false);
  assert.equal(supportsCollectionReleaseCompletion({ ...capability, requiredContentMessages: false }, { kind: 'collection_forum' }), false);
});
test('ownership suppresses only selected release and announcement destination pairs', () => {
  const ownership = { releaseId: 'release', announcementDestinationKeys: ['account/channel/post-type'] };
  assert.equal(collectionPlanOwnsAnnouncement(ownership, 'release', 'account/channel/post-type'), true);
  assert.equal(collectionPlanOwnsAnnouncement(ownership, 'release', 'another/channel/post-type'), false);
  assert.equal(collectionPlanOwnsAnnouncement(ownership, 'another', 'account/channel/post-type'), false);
  assert.equal(collectionPlanOwnsAnnouncement(ownership, undefined, 'account/channel/post-type'), false);
});
test('planned deliveries preserve legacy hashes and clone/freeze immutable orchestration through guards', () => {
  const input = { provider: 'custom', connectionId: 'connection', targetId: 'target', idempotencyKey: 'stable-step-generation-1', content: { title: 'Release' } };
  const orchestration = { schemaVersion: 1, planId: 'plan', logicalDestinationStepId: 'step', generation: 1, contentRevision: 'revision-1', dueAt: '2026-11-05T12:00:00Z' };
  const planned = createPlannedAnnouncementDeliverySnapshot({ ...input, orchestration });
  const legacy = createAnnouncementPublication({ ...input, idempotencyKey: planned.idempotencyKey });
  assert.equal(legacy.announcementPublicationId, planned.announcementPublicationId);
  orchestration.generation = 2;
  assert.notEqual(createPlannedAnnouncementDeliverySnapshot({ ...input, orchestration }).announcementPublicationId, planned.announcementPublicationId);
  assert.equal(planned.orchestration.generation, 1);
  assert.doesNotThrow(() => assertPlannedAnnouncementDeliveryImmutable(planned, { ...planned, status: 'sent', remoteId: 'remote' }));
  for (const [field, value] of [['generation', 2], ['dueAt', '2026-11-06T12:00:00Z'], ['contentRevision', 'revision-2'], ['planId', 'other'], ['logicalDestinationStepId', 'other']])
    assert.throws(() => assertPlannedAnnouncementDeliveryImmutable(planned, { ...planned, orchestration: { ...planned.orchestration, [field]: value } }), /immutable/);
  assert.throws(() => createPlannedAnnouncementDeliverySnapshot({ ...input, orchestration: { ...orchestration, generation: 0 } }), /generation/);
});
