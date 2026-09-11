import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { LocalSqliteDatabase, LocalFilesystemStorage } from '../dist/index.js';
import { transferVerifiedObject } from '@ubeeq/storage';

test('verified transfer persists private bytes between local cells across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-transfer-'));
  const configuration = cellId => ({ databasePath: join(directory, `${cellId}.sqlite`), dataDirectory: join(directory, cellId), cellId, publicBaseUrl: 'http://localhost' });
  const sourceDb = new LocalSqliteDatabase(configuration('source'));
  let destinationDb = new LocalSqliteDatabase(configuration('destination'));
  try {
    const source = new LocalFilesystemStorage(sourceDb);
    const destination = new LocalFilesystemStorage(destinationDb);
    const body = new TextEncoder().encode('retained original bytes');
    const reference = await source.writePrivateVersion({ object: { bucket: 'source', key: 'cells/source/creators/owner/assets/original',
      contentType: 'application/octet-stream', byteLength: body.length, checksum: createHash('sha256').update(body).digest('hex'), scope: 'private' }, body });
    let admissions = 0;
    const result = await transferVerifiedObject({ source, destination, writeDestination: destination.writePrivateVersion.bind(destination),
      admit: async ({ source: admitted, destination: target }) => {
        admissions++; assert.deepEqual(admitted, reference); assert.equal(target.bucket, 'destination');
      } }, { source: reference, sourcePrefix: 'cells/source/creators/owner', destinationBucket: 'destination', destinationPrefix: 'cells/destination/creators/target/assets' });
    assert.equal(admissions, 3); assert.notEqual(result.versionId, reference.versionId);
    assert.equal(result.scope, 'private');
    destinationDb.database.close(); destinationDb = new LocalSqliteDatabase(configuration('destination'));
    const restored = await new LocalFilesystemStorage(destinationDb).get(result);
    assert.deepEqual(restored.object, result); assert.deepEqual(Uint8Array.from(restored.body), body);
    assert.deepEqual(Uint8Array.from((await source.get(reference)).body), body);
    for (const change of [{ scope: 'public' }, { bucket: '../escape' }, { key: 'cells/source/creators/owner/../other/file' },
      { key: 'cells/destination/creators/owner/file' }, { checksum: '0'.repeat(64) }, { byteLength: 1 }]) {
      await assert.rejects(source.writePrivateVersion({ object: { ...reference, ...change }, body }));
    }
  } finally {
    sourceDb.database.close(); destinationDb.database.close(); rmSync(directory, { recursive: true, force: true });
  }
});
