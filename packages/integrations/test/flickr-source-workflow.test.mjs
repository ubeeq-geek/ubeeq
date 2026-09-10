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
  await repository.putConnection({ connectionId: 'c', userId: 'u', creatorId: 'creator', accountId: 'account', state: 'CONNECTED', encryptedTokenRef: 'vault-original' });
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

test('raw transfer, scanner and attachment errors never enter saved items or audit events', async () => {
  for (const port of ['transfer', 'scanQuarantine', 'attachCleanSource']) {
    const privateError = new Error('TEMPORARILY_UNAVAILABLE https://private.invalid/original?signature=secret storage/private-key');
    const overrides = { scanQuarantine: async () => 'clean', [port]: async () => { throw privateError; } };
    const { workflow, repository } = await setup(overrides);
    const result = await workflow.run(migration());
    assert.equal(result.items[0].errorCode, 'FLICKR_SOURCE_TRANSFER_FAILED');
    assert.equal(result.items[0].transferStatus, 'FAILED');
    assert.equal(result.items[0].retryCount, 0);
    assert.equal(result.items[0].nextRetryAt, undefined);
    assert.equal(result.auditEvents.at(-1).details.errorCode, 'FLICKR_SOURCE_TRANSFER_FAILED');
    assert.doesNotMatch(JSON.stringify(await repository.getMigration('m')), /signature=secret|storage\/private-key|private\.invalid/);
  }
});

test('credential rotation during transfer or quarantine scanning aborts before attachment and checkpoint', async () => {
  for (const stage of ['transfer', 'scan']) {
    const value = await setup();
    const rotate = async () => {
      const current = await value.repository.getConnection('c');
      await value.repository.putConnection({ ...current, encryptedTokenRef: 'vault-rotated' });
    };
    value.ports.transfer = async () => {
      value.calls.transfer++;
      if (stage === 'transfer') await rotate();
      return { ...source, scanOutcome: stage === 'transfer' ? 'clean' : 'pending' };
    };
    value.ports.scanQuarantine = async () => { await rotate(); return 'clean'; };
    await assert.rejects(value.workflow.run(migration()), FlickrSourceAdmissionError);
    assert.equal(value.calls.transfer, 1); assert.equal(value.calls.attach, 0);
    assert.equal(await value.repository.getMigration('m'), undefined);
  }
});

test('attachment callbacks cannot mutate the expected credential fence to conceal rotation', async () => {
  const value = await setup({ scanQuarantine: async () => 'clean' });
  value.ports.attachCleanSource = async connection => {
    connection.encryptedTokenRef = 'vault-rotated';
    await value.repository.putConnection(connection);
    return false;
  };
  await assert.rejects(value.workflow.run(migration()), FlickrSourceAdmissionError);
  assert.equal(await value.repository.getMigration('m'), undefined);
  // A new batch captures the new reference; cross-batch consent binding is separate.
  value.ports.attachCleanSource = async () => false;
  assert.equal((await value.workflow.run(migration())).status, 'COMPLETE');
});

test('only exact allowlisted codes select unavailable or transient retry outcomes', async () => {
  for (const [message, status, retry] of [
    ['FLICKR_SOURCE_UNAVAILABLE', 'UNAVAILABLE', 0],
    ['FLICKR_SOURCE_TEMPORARILY_UNAVAILABLE', 'FAILED', 1],
    ['TEMPORARILY_UNAVAILABLE', 'FAILED', 1],
    ['FLICKR_SOURCE_TOO_LARGE', 'FAILED', 0],
    ['FLICKR_SOURCE_UNAVAILABLE: private URL', 'FAILED', 0],
    ['UNKNOWN_UNAVAILABLE', 'FAILED', 0]
  ]) {
    const { workflow } = await setup({ transfer: async () => { throw new Error(message); } });
    const result = await workflow.run(migration());
    assert.equal(result.items[0].transferStatus, status, message);
    assert.equal(result.items[0].retryCount, retry, message);
    assert.equal(!!result.items[0].nextRetryAt, retry === 1, message);
    if (message.includes('private') || message.startsWith('UNKNOWN')) assert.equal(result.items[0].errorCode, 'FLICKR_SOURCE_TRANSFER_FAILED');
  }
});

test('large catalogue batches scan photos once and audit only the changed batch without repeated find calls', async () => {
  const { workflow, calls, repository } = await setup({ scanQuarantine: async () => 'clean' });
  const initial = migration();
  const size = 10000; let photoIdReads = 0;
  initial.photos = Array.from({ length: size }, (_, i) => ({ get remoteId() { photoIdReads++; return String(i); }, originalSourceUrl: 'https://example.invalid/source' }));
  initial.items = Array.from({ length: size }, (_, i) => ({ remoteId: String(i), transferStatus: 'QUEUED', retryCount: 0 }));
  initial.sourceCursor = size - 10;
  for (const rows of [initial.photos, initial.items]) Object.defineProperty(rows, 'find', { value: () => { throw Error('repeated full-array search'); } });
  // Avoid counting persistence serialization as workflow catalogue lookup work.
  repository.putMigration = async () => {};
  const result = await workflow.run(initial);
  assert.equal(calls.transfer, 10); assert.equal(calls.attach, 10);
  assert.ok(photoIdReads <= size + 30, `read ${photoIdReads} IDs for ${size} photos`);
  assert.equal(result.auditEvents.length, 10);
  assert.deepEqual(result.auditEvents.map(event => event.remoteId), Array.from({ length: 10 }, (_, i) => String(size - 10 + i)));
  assert.equal(result.items.length, size); assert.equal(result.sourceCursor, 0); assert.equal(result.status, 'REVIEW');
  assert.ok(result.items.slice(0, size - 10).every(item => item.transferStatus === 'QUEUED'));
  assert.ok(initial.items.every(item => item.transferStatus === 'QUEUED'));
});

test('batch photo lookup retains first duplicate match and missing photos remain unavailable', async () => {
  const urls = [];
  const { workflow } = await setup({ transfer: async input => { urls.push(input.sourceUrl); return { ...source, scanOutcome: 'clean' }; } });
  const initial = migration();
  initial.photos.push({ remoteId: 'p', originalSourceUrl: 'https://example.invalid/duplicate' });
  initial.items.push({ remoteId: 'missing', transferStatus: 'QUEUED', retryCount: 0 });
  const result = await workflow.run(initial);
  assert.deepEqual(urls, ['https://example.invalid/original']);
  assert.equal(result.items[1].transferStatus, 'UNAVAILABLE');
  assert.equal(result.items[1].errorCode, 'ORIGINAL_UNAVAILABLE');
  assert.deepEqual(result.auditEvents.map(event => event.action), ['SOURCE_TRANSFERRED', 'SOURCE_UNAVAILABLE']);
});
