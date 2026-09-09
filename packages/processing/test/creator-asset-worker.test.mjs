import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CreatorAssetWorker } from '../dist/index.js';

const setup = () => {
  const calls = { reads: 0, decodes: 0, writes: [], commits: [], retries: 0, dead: 0 };
  const source = new Uint8Array([1, 2, 3]);
  const scope = { tenantId: 'tenant', creatorId: 'creator', workId: 'work', assetId: 'asset', sourceVersionId: 'v1' };
  const job = { id: 'job', cellId: 'cell', type: 'creator-asset.process', payload: scope, state: 'leased', attempt: 1, maxAttempts: 3 };
  const asset = { ...scope, status: 'pending', mimeType: 'image/png', sizeBytes: source.length,
    checksumSha256: createHash('sha256').update(source).digest('hex'), storage: { scope: 'private', versionId: 'v1' } };
  const preview = { id: 'preview', sourceVersionId: 'v1', contentType: 'image/jpeg', role: 'preview', byteLength: 2, body: new Uint8Array([4, 5]) };
  const output = { metadata: { width: 1 }, renditions: [preview], measuredUnits: 1 };
  const options = { cellId: 'cell', workerId: 'worker',
    jobs: { lease: async () => ({ job, leaseToken: 'lease' }), get: async () => job,
      retry: async () => { calls.retries++; job.state = 'retry_scheduled'; }, deadLetter: async () => { calls.dead++; job.state = 'dead_lettered'; } },
    assets: { getProcessingAsset: async () => asset, commitAssetProcessing: async value => { calls.commits.push(value); job.state = 'completed'; } },
    storage: { get: async () => { calls.reads++; return { body: source }; }, put: async value => { calls.writes.push(value); }, remove: async () => { throw Error('must not delete'); } },
    processor: { process: async () => { calls.decodes++; return output; } } };
  return { calls, source, scope, job, asset, preview, output, options, run: () => new CreatorAssetWorker(options).runNext() };
};

test('worker stores private attempt-specific objects and commits references only', async () => {
  const first = setup(), second = setup();
  assert.equal((await first.run()).state, 'completed');
  await second.run();
  const object = first.calls.writes[0].object;
  assert.equal(object.scope, 'private');
  assert.notEqual(object.key, second.calls.writes[0].object.key);
  assert.equal(first.calls.commits[0].renditions[0].body, undefined);
  assert.equal(first.calls.commits[0].sourceVersionId, 'v1');
});

test('wrong asset scope and source budgets fail before object reads', async () => {
  for (const change of [{ tenantId: 'foreign' }, { assetId: 'other' }, { sizeBytes: -1 }, { sizeBytes: 60 * 1024 * 1024 }]) {
    const value = setup(); Object.assign(value.asset, change);
    assert.equal((await value.run()).state, 'retry_scheduled');
    assert.equal(value.calls.reads, 0);
  }
  assert.throws(() => new CreatorAssetWorker({ ...setup().options, maxOutputBytes: 0 }), /budgets/);
});

test('integrity failure prevents decoding and writes', async () => {
  const value = setup(); value.asset.checksumSha256 = 'bad';
  await value.run();
  assert.equal(value.calls.decodes, 0);
  assert.equal(value.calls.writes.length, 0);
});

test('all output lineage and total budget validate before any write', async () => {
  for (const mode of ['lineage', 'duplicate', 'empty', 'budget']) {
    const value = setup();
    if (mode === 'lineage') value.output.renditions.push({ ...value.preview, id: 'second', sourceVersionId: 'v2' });
    if (mode === 'duplicate') value.output.renditions.push(value.preview);
    if (mode === 'empty') value.output.renditions = [];
    if (mode === 'budget') value.options.maxOutputBytes = 1;
    assert.equal((await value.run()).state, 'retry_scheduled');
    assert.equal(value.calls.writes.length, 0);
    assert.equal(value.calls.commits.length, 0);
  }
});

test('storage failure retries and exhausted attempts dead-letter without committing', async () => {
  const value = setup(); value.options.storage.put = async () => { throw Error('storage unavailable'); };
  assert.equal((await value.run()).state, 'retry_scheduled');
  value.job.attempt = 3;
  assert.equal((await value.run()).state, 'dead_lettered');
  assert.equal(value.calls.commits.length, 0);
});

test('ambiguous completed commit is observed without retries or object deletion', async () => {
  const value = setup();
  value.options.assets.commitAssetProcessing = async () => { value.job.state = 'completed'; throw Error('response lost'); };
  assert.equal((await value.run()).state, 'completed');
  assert.equal(value.calls.retries, 0);
  assert.equal(value.calls.writes.length, 1);
});

test('lost lease cannot report retry success when the queue rejects its token', async () => {
  const value = setup();
  value.options.assets.commitAssetProcessing = async () => { throw Error('lease replaced'); };
  value.options.jobs.retry = async () => { throw Error('lease token rejected'); };
  await assert.rejects(value.run(), /lease token rejected/);
  assert.equal(value.calls.writes.length, 1);
});

test('crop-enabled workers snapshot the durable request and pass it to processing', async () => {
  const value = setup();
  value.options.allowSquareCrop = true; value.scope.squareCrop = { x: 2, y: 3, size: 4 };
  const get = value.options.assets.getProcessingAsset;
  value.options.assets.getProcessingAsset = async () => { value.scope.squareCrop.x = 99; return get(); };
  value.options.processor.process = async input => { assert.deepEqual(input.squareCrop, { x: 2, y: 3, size: 4 }); return value.output; };
  assert.equal((await value.run()).state, 'completed');
  assert.deepEqual(value.calls.commits[0].squareCrop, { x: 2, y: 3, size: 4 });
});

test('disabled, malformed or non-image crop jobs fail before source reads', async () => {
  for (const kind of ['disabled', 'malformed', 'video']) {
    const value = setup(); value.scope.squareCrop = { x: 0, y: 0, size: 2 };
    value.options.allowSquareCrop = kind !== 'disabled';
    if (kind === 'malformed') value.scope.squareCrop.size = NaN;
    if (kind === 'video') value.asset.mimeType = 'video/mp4';
    assert.equal((await value.run()).state, 'retry_scheduled');
    assert.equal(value.calls.reads, 0); assert.equal(value.calls.writes.length, 0); assert.equal(value.calls.commits.length, 0);
  }
});
