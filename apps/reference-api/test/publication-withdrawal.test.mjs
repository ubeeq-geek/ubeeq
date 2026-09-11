import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { PublicationWithdrawalService } from '@ubeeq/api';

test('withdrawal is scoped, admitted, atomic and idempotent across concurrency and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-withdrawal-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let local = createLocalAdapterSet(config);
  const scope = { instanceId: 'tenant', homeCellId: 'cell', dataHomeRegion: 'local', dataHomeAssignedAt: '2026-01-01', routingRevision: 1 };
  const input = { workId: 'work', actorId: 'owner', publicationId: 'publication', expectedRevision: 1 };
  const service = (admit = async () => {}) => new PublicationWithdrawalService(local.repositories, async (id, actor) => {
    if (actor !== 'owner') throw new Error('ownership denied');
    return local.repositories.works.get(id);
  }, admit);
  try {
    const work = await local.repositories.works.create({ id: 'work', ...scope, creatorId: 'creator', title: 'Original', status: 'published' });
    const original = await local.repositories.publications.create({ id: 'publication', ...scope, workId: 'work', destination: 'local', status: 'live' });
    const other = await local.repositories.publications.create({ id: 'other', ...scope, workId: 'work', destination: 'elsewhere', status: 'live' });
    await local.repositories.publications.create({ id: 'foreign', ...scope, workId: 'another-work', destination: 'local', status: 'live' });
    await local.repositories.publications.create({ id: 'queued', ...scope, workId: 'work', destination: 'local', status: 'queued' });
    await assert.rejects(service().withdraw({ ...input, actorId: 'stranger' }), /ownership denied/);
    await assert.rejects(service().withdraw({ ...input, publicationId: 'foreign' }), { code: 'publication_not_found' });
    await assert.rejects(service().withdraw({ ...input, expectedRevision: 0 }), { code: 'invalid_request' });
    await assert.rejects(service().withdraw({ ...input, expectedRevision: 2 }), { name: 'OptimisticConcurrencyError' });
    await assert.rejects(service().withdraw({ ...input, publicationId: 'queued' }), { code: 'publication_not_live' });
    await local.repositories.publications.create({ id: 'racy', ...scope, workId: 'work', destination: 'local', status: 'live' });
    await assert.rejects(service(async () => {
      await local.repositories.publications.update('racy', 1, { destination: 'changed' });
    }).withdraw({ ...input, publicationId: 'racy' }), { name: 'OptimisticConcurrencyError' });
    assert.equal((await local.repositories.publications.get('racy')).status, 'live');
    await assert.rejects(service(async (snapshot, receipt) => {
      snapshot.title = 'Mutated'; receipt.destination = 'Mutated'; throw new Error('withdrawal held');
    }).withdraw(input), /withdrawal held/);
    assert.deepEqual(await local.repositories.works.get('work'), work);
    assert.deepEqual(await local.repositories.publications.get('publication'), original);
    const audit = local.repositories.auditEvents.create;
    local.repositories.auditEvents.create = async () => { throw new Error('audit failure'); };
    await assert.rejects(service().withdraw(input), /audit failure/);
    local.repositories.auditEvents.create = audit;
    assert.deepEqual(await local.repositories.publications.get('publication'), original);
    assert.deepEqual((await local.repositories.auditEvents.list({ limit: 100 })).items, []);
    const results = await Promise.all([service().withdraw(input), service().withdraw(input)]);
    assert.deepEqual(results.map(item => item.idempotent).sort(), [false, true]);
    assert.ok(results.every(item => item.publication.status === 'removed' && item.publication.revision === 2));
    assert.deepEqual(await local.repositories.works.get('work'), work);
    assert.deepEqual(await local.repositories.publications.get('other'), other);
    local.database.database.close(); local = createLocalAdapterSet(config);
    assert.equal((await service().withdraw(input)).idempotent, true);
    await assert.rejects(service().withdraw({ ...input, actorId: 'stranger' }), /ownership denied/);
    await assert.rejects(service(async () => { throw new Error('withdrawal denied'); }).withdraw(input), /withdrawal denied/);
    const events = (await local.repositories.auditEvents.list({ limit: 100 })).items;
    assert.equal(events.length, 1); assert.equal(events[0].action, 'publication.withdrawn');
    assert.equal(events[0].actorId, 'owner'); assert.equal(events[0].payload.publicationId, 'publication');
  } finally { local.database.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
