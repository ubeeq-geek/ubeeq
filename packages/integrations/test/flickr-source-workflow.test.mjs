import test from 'node:test';
import assert from 'node:assert/strict';
import { FlickrSourceWorkflow, FlickrSourceAdmissionError, InMemoryFlickrRepository } from '../dist/index.js';

const migration = () => ({ migrationId: 'm', connectionId: 'c', userId: 'u', mode: 'FULL_CATALOGUE_MIGRATION',
  confirmedAt: 'confirmed', storageConfirmed: true, status: 'CONFIRMED',
  photos: [{ remoteId: 'p', originalSourceUrl: 'https://example.invalid/original' }],
  items: [{ remoteId: 'p', transferStatus: 'QUEUED', retryCount: 0 }], auditEvents: [] });
const source = { objectKey: 'private/source', checksumSha256: 'checksum', mimeType: 'image/jpeg', sizeBytes: 10, scanOutcome: 'pending' };
const setup = async (overrides = {}) => {
  const repository = new InMemoryFlickrRepository();
  await repository.putConnection({ connectionId: 'c', userId: 'u', creatorId: 'creator', accountId: 'account', state: 'CONNECTED' });
  const calls = { transfer: 0, attach: 0 };
  const ports = { canManageCreator: async () => true,
    transfer: async () => { calls.transfer++; return source; },
    scanQuarantine: async () => 'pending',
    attachCleanSource: async () => { calls.attach++; return false; }, ...overrides };
  return { repository, calls, ports, workflow: new FlickrSourceWorkflow(repository, ports) };
};

test('source workflow resumes retained quarantine without downloading again and checkpoints clean attachment', async () => {
  const { workflow, ports, calls, repository } = await setup();
  const quarantined = await workflow.run(migration());
  assert.equal(quarantined.items[0].transferStatus, 'QUARANTINED');
  assert.equal(calls.attach, 0);
  ports.scanQuarantine = async () => 'clean';
  const complete = await workflow.run(quarantined);
  assert.equal(calls.transfer, 1);
  assert.equal(calls.attach, 1);
  assert.equal(complete.status, 'COMPLETE');
  assert.equal(complete.items[0].dedupeStatus, 'UNIQUE');
  assert.equal(complete.auditEvents.at(-1).action, 'SOURCE_TRANSFERRED');
  assert.deepEqual(await repository.getMigration('m'), complete);
  await workflow.run(complete);
  assert.equal(calls.attach, 1);
});

test('source batches persist continuation and never attempt more than the requested item budget', async () => {
  const { workflow, calls, repository } = await setup({ scanQuarantine: async () => 'clean' });
  const initial = migration();
  initial.photos = Array.from({ length: 12 }, (_, i) => ({ remoteId: String(i), originalSourceUrl: 'https://example.invalid/original' }));
  initial.items = initial.photos.map(photo => ({ remoteId: photo.remoteId, transferStatus: 'QUEUED', retryCount: 0 }));
  const first = await workflow.run(initial);
  assert.equal(first.status, 'RUNNING'); assert.equal(first.sourceCursor, 10);
  assert.equal(calls.transfer, 10); assert.equal(calls.attach, 10);
  assert.equal(first.items[10].transferStatus, 'QUEUED');
  const saved = await repository.getMigration('m');
  const complete = await workflow.run(saved);
  assert.equal(complete.status, 'COMPLETE'); assert.equal(complete.sourceCursor, 0);
  assert.equal(calls.transfer, 12); assert.equal(calls.attach, 12);
  assert.equal(complete.auditEvents.length, 12);
  assert.ok(initial.items.every(item => item.transferStatus === 'QUEUED'));
  for (const limit of [0, -1, 1.5, 101]) await assert.rejects(workflow.run(initial, limit), /batch size/);
  await assert.rejects(workflow.run({ ...initial, sourceCursor: 13 }), /source cursor/);
  assert.equal(calls.transfer, 12);
});

test('terminal entries consume the inspection budget and pending scans are revisited after a sweep', async () => {
  const { workflow, ports, calls } = await setup();
  const initial = migration();
  initial.items.unshift({ remoteId: 'done', transferStatus: 'VALIDATED', retryCount: 0 });
  const first = await workflow.run(initial, 1);
  assert.equal(first.sourceCursor, 1); assert.equal(calls.transfer, 0);
  const pending = await workflow.run(first, 1);
  assert.equal(pending.status, 'REVIEW'); assert.equal(pending.sourceCursor, 0);
  assert.equal(calls.transfer, 1);
  ports.scanQuarantine = async () => 'clean';
  const complete = await workflow.run(await workflow.run(pending, 1), 1);
  assert.equal(complete.status, 'COMPLETE'); assert.equal(calls.transfer, 1); assert.equal(calls.attach, 1);
});

test('blocked scan never attaches content; transient failures retain bounded retry scheduling', async () => {
  const blocked = await setup({ scanQuarantine: async () => 'blocked' });
  const result = await blocked.workflow.run(migration());
  assert.equal(result.status, 'REVIEW');
  assert.equal(result.items[0].errorCode, 'QUARANTINE_SCAN_BLOCKED');
  assert.equal(blocked.calls.attach, 0);
  const transient = await setup({ transfer: async () => { throw new Error('TEMPORARILY_UNAVAILABLE'); } });
  const retry = await transient.workflow.run(migration());
  assert.equal(retry.items[0].retryCount, 1);
  assert.ok(retry.items[0].nextRetryAt);
  retry.items[0].retryCount = 2;
  retry.items[0].nextRetryAt = '2000-01-01T00:00:00.000Z';
  const exhausted = await transient.workflow.run(retry);
  assert.equal(exhausted.items[0].retryCount, 3);
  assert.equal(exhausted.items[0].nextRetryAt, undefined);
});

test('revocation after transfer and explicit attachment admission errors abort without checkpointing success', async () => {
  let admitted = true;
  const revoked = await setup({ canManageCreator: async () => admitted,
    transfer: async () => { admitted = false; return { ...source, scanOutcome: 'clean' }; } });
  await assert.rejects(revoked.workflow.run(migration()), FlickrSourceAdmissionError);
  assert.equal(revoked.calls.attach, 0);
  assert.equal(await revoked.repository.getMigration('m'), undefined);
  const collision = await setup({ scanQuarantine: async () => 'clean', attachCleanSource: async () => { throw new FlickrSourceAdmissionError('owner collision'); } });
  await assert.rejects(collision.workflow.run(migration()), /owner collision/);
  assert.equal(await collision.repository.getMigration('m'), undefined);
});
