import test from 'node:test';
import assert from 'node:assert/strict';
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createS3PublicDerivativeStore } from '../dist/index.js';

const input = { sourceBucket: 'private-derivatives', sourceObjectKey: 'a folder/é +?#%.webp',
  destinationBucket: 'public-derivatives', destinationObjectKey: 'assets/version/attempt.webp',
  contentType: 'image/webp', contentHash: 'a'.repeat(64) };

test('copy replaces source metadata, encodes source segments and retains destination encryption defaults', async () => {
  const commands = [];
  const store = createS3PublicDerivativeStore({ send: async command => { commands.push(command); return {}; } });
  await store.copy(input);
  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof CopyObjectCommand);
  assert.deepEqual(commands[0].input, {
    Bucket: input.destinationBucket, Key: input.destinationObjectKey,
    CopySource: 'private-derivatives/a%20folder/%C3%A9%20%2B%3F%23%25.webp',
    ContentType: 'image/webp', CacheControl: 'public, max-age=300, s-maxage=300, must-revalidate',
    MetadataDirective: 'REPLACE', Metadata: { sha256: input.contentHash }
  });
  await store.remove({ bucket: input.destinationBucket, objectKey: input.destinationObjectKey });
  assert.equal(commands.length, 2);
  assert.ok(commands[1] instanceof DeleteObjectCommand);
  assert.deepEqual(commands[1].input, { Bucket: input.destinationBucket, Key: input.destinationObjectKey });
});

test('storage failures remain observable without automatic cleanup, retry or changed targets', async () => {
  const commands = [], failure = new Error('ambiguous storage response');
  const store = createS3PublicDerivativeStore({ send: async command => { commands.push(command); throw failure; } });
  await assert.rejects(store.copy(input), error => error === failure);
  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof CopyObjectCommand);
  await assert.rejects(store.remove({ bucket: 'public-derivatives', objectKey: 'exact/owned/key' }), error => error === failure);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1].input, { Bucket: 'public-derivatives', Key: 'exact/owned/key' });
});
