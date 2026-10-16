import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCreatorContentStore, createPublicationCopy, approvePublicationOperation, transitionPublicationOperation, PublicationCopyConflict } from '../dist/index.js';
const draft = (id, slot = id, request = id) => ({ publicationId: id, tenantId: 'tenant', creatorId: 'creator', workId: 'work', destination: 'deviantart',
  copy: { slotId: slot, creationRequestId: request, account: { providerNamespace: 'deviantart.com', remoteAccountId: 'verified-account' }, purpose: 'PUBLIC_PREVIEW' },
  revision: 1, status: 'draft', createdAt: 'now', updatedAt: 'now' });
const setup = async () => { const store = new MemoryCreatorContentStore(); await store.createWork({ tenantId: 'tenant', creatorId: 'creator', workId: 'work', revision: 1, status: 'ready', updatedAt: 'now' }); return store; };
const transition = (store, op, state, binding) => transitionPublicationOperation(store, { tenantId: 'tenant', publicationId: op.publicationId, operationId: op.operationId, expectedVersion: op.version, state, now: 'later', ...(binding ? { binding } : {}) });
const binding = id => ({ providerNamespace: 'deviantart.com', objectType: 'deviation', ownershipBoundary: 'global', remoteId: id });

test('three independent slots and a fourth same-purpose copy reuse one Work; concurrent requests/slots return one identity', async () => {
  const store = await setup();
  const rows = await Promise.all(['preview', 'collection', 'volume', 'fourth'].map(id => createPublicationCopy(store, draft(id))));
  assert.equal(new Set(rows.map(row => row.publication.publicationId)).size, 4); assert.equal(store.works.length, 1);
  const results = await Promise.all(Array.from({ length: 12 }, (_, n) => createPublicationCopy(store, draft(`retry-${n}`, 'preview', 'preview'))));
  assert.ok(results.every(row => !row.created && row.publication.publicationId === 'preview')); assert.equal(store.publications.length, 4);
  const sameSlot = await Promise.all(Array.from({ length: 12 }, (_, n) => createPublicationCopy(store, draft(`slot-${n}`, 'new-slot', `request-${n}`))));
  assert.equal(new Set(sameSlot.map(row => row.publication.publicationId)).size, 1); assert.equal(sameSlot.filter(row => row.created).length, 1);
  assert.equal(store.publications.length, 5);
});

test('request conflict, cross-account/Creator separation, reconnect and later edits', async () => {
  const store = await setup(), p = draft('p');
  await createPublicationCopy(store, p, { displayResolution: 1280 });
  await assert.rejects(createPublicationCopy(store, draft('other', 'another-slot', 'p')), PublicationCopyConflict);
  await assert.rejects(createPublicationCopy(store, p, { displayResolution: 1600 }), PublicationCopyConflict);
  const reconnect = await createPublicationCopy(store, { ...p, publicationId: 'different-allocation', integrationAccountId: 'rotated-credential', title: 'New source title' }, { displayResolution: 1280 });
  assert.equal(reconnect.publication.publicationId, 'p'); assert.equal(reconnect.publication.title, undefined);
  const anotherAccount = { ...draft('q', 'p', 'q'), copy: { ...p.copy, creationRequestId: 'q', account: { ...p.copy.account, remoteAccountId: 'second-account' } } };
  assert.equal((await createPublicationCopy(store, anotherAccount)).created, true);
  await assert.rejects(createPublicationCopy(store, { ...draft('foreign'), creatorId: 'other' }), PublicationCopyConflict);
  const read = reconnect.publication; read.copy.slotId = 'mutated';
  assert.equal((await store.getPublication('tenant', 'p')).copy.slotId, 'p');
  await assert.rejects(store.upsertPublication({ ...p, title: 'legacy overwrite' }), PublicationCopyConflict);
});

test('only one concurrent dispatch wins, ambiguous create cannot restart, remote identity is exclusive', async () => {
  const store = await setup();
  for (const id of ['p', 'sibling']) await createPublicationCopy(store, draft(id));
  let op = await approvePublicationOperation(store, await store.getPublication('tenant', 'p'), { kind: 'CREATE', sourceRevision: 1, now: 'approve' });
  const attempts = await Promise.allSettled([transition(store, op, 'IN_FLIGHT'), transition(store, op, 'IN_FLIGHT')]);
  assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
  op = attempts.find(row => row.status === 'fulfilled').value;
  op = await transition(store, op, 'AMBIGUOUS');
  await assert.rejects(transition(store, op, 'IN_FLIGHT'), PublicationCopyConflict);
  await assert.rejects(approvePublicationOperation(store, await store.getPublication('tenant', 'p'), { kind: 'CREATE', sourceRevision: 1, now: 'retry' }), PublicationCopyConflict);
  await assert.rejects(transition(store, op, 'CONFIRMED'), PublicationCopyConflict);
  op = await transition(store, op, 'CONFIRMED', binding('remote-id'));
  assert.equal((await store.getPublication('tenant', 'p')).remoteId, 'remote-id');
  assert.equal((await store.getPublication('tenant', 'sibling')).status, 'draft');
  let other = await approvePublicationOperation(store, await store.getPublication('tenant', 'sibling'), { kind: 'CREATE', sourceRevision: 1, now: 'approve' });
  other = await transition(store, other, 'IN_FLIGHT');
  await assert.rejects(transition(store, other, 'CONFIRMED', binding('remote-id')), PublicationCopyConflict);
  assert.equal((await store.getPublication('tenant', 'sibling')).remoteId, undefined);
  assert.equal((await store.getPublicationOperation('tenant', other.operationId)).state, 'IN_FLIGHT');
  await assert.rejects(transitionPublicationOperation(store, { tenantId: 'foreign', publicationId: 'p', operationId: op.operationId, expectedVersion: op.version, state: 'CONFIRMED', now: 'x', binding: binding('remote-id') }), PublicationCopyConflict);
});

test('stale approval and source revisions cannot dispatch; cancellation/failure need fresh approval', async () => {
  const store = await setup(); await createPublicationCopy(store, draft('p'));
  const p = await store.getPublication('tenant', 'p');
  let op = await approvePublicationOperation(store, p, { kind: 'CREATE', sourceRevision: 1, now: 'approve' });
  await assert.rejects(approvePublicationOperation(store, p, { kind: 'CREATE', sourceRevision: 1, now: 'stale' }), PublicationCopyConflict);
  await store.commitWorkRevision({ ...store.works[0], revision: 2 }, 1);
  await assert.rejects(transition(store, op, 'IN_FLIGHT'), PublicationCopyConflict);
  op = await transition(store, op, 'CANCELLED');
  op = await approvePublicationOperation(store, await store.getPublication('tenant', 'p'), { kind: 'CREATE', sourceRevision: 2, now: 'fresh' });
  op = await transition(store, op, 'IN_FLIGHT'); op = await transition(store, op, 'FAILED');
  await assert.rejects(transition(store, op, 'IN_FLIGHT'), PublicationCopyConflict);
  assert.equal((await store.getPublication('tenant', 'p')).status, 'draft');
});

test('removed Work rejects allocation and no partial claims survive', async () => {
  const store = await setup(); store.works[0].status = 'deleted';
  await assert.rejects(createPublicationCopy(store, draft('p')), PublicationCopyConflict);
  assert.equal(store.publications.length, 0); assert.equal(store.publicationClaims.length, 0);
});

test('a legacy upsert paused in product validation cannot overwrite a newly allocated copy', async () => {
  let resume, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { resume = resolve; });
  class PausedStore extends MemoryCreatorContentStore { async validatePublication() { entered(); await wait; } }
  const store = new PausedStore();
  await store.createWork({ tenantId: 'tenant', creatorId: 'creator', workId: 'work', revision: 1, status: 'ready', updatedAt: 'now' });
  const write = store.upsertPublication({ ...draft('p'), copy: undefined, revision: undefined });
  await ready;
  await createPublicationCopy(store, draft('p'));
  resume();
  await assert.rejects(write, PublicationCopyConflict);
  assert.equal((await store.getPublication('tenant', 'p')).copy.slotId, 'p');
});
