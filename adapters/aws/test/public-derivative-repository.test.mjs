import test from 'node:test';
import assert from 'node:assert/strict';
import { createDynamoPublicDerivativeRepository } from '../dist/index.js';

const publication = { id: 'receipt', recordType: 'PUBLIC_DERIVATIVE_PUBLICATION', product: 'fixture', environment: 'test',
  dataHomeRegion: 'region-a', assetId: 'asset', mediaVersionId: 'version', scanGroupId: 'scan',
  sourceBucket: 'private', sourceObjectKey: 'source', destinationBucket: 'public', destinationObjectKey: 'owned/key',
  contentHash: 'a'.repeat(64), contentType: 'image/webp', state: 'PUBLISHING', createdAt: '2026-01-01T00:00:00Z' };
const fixture = () => {
  const commands = [];
  const client = { send: async command => { commands.push(command); return {}; } };
  return { commands, client, repository: createDynamoPublicDerivativeRepository({ client, metadataTableName: 'metadata', auditTableName: 'audit' }) };
};
const checkScope = condition => {
  for (const field of ['#product', '#environment', 'dataHomeRegion', 'canonicalRegion', 'processingBillingState',
    'publicDeliveryState', 'currentScanGroupId', 'currentMediaVersionId']) assert.ok(condition.ConditionExpression.includes(field));
  assert.equal(condition.ExpressionAttributeValues[':product'], 'fixture');
  assert.equal(condition.ExpressionAttributeValues[':region'], 'region-a');
  assert.equal(condition.ExpressionAttributeValues[':scanGroupId'], 'scan');
  assert.equal(condition.ExpressionAttributeValues[':mediaVersionId'], 'version');
};
test('completion recovery transactionally matches receipt and current asset without writes', async () => {
  const f = fixture(); const commands = [];
  const receipt = { ...publication, state: 'PUBLISHED', publishedAt: '2026-01-02T00:00:00Z' };
  const asset = { product: 'fixture', environment: 'test', dataHomeRegion: 'region-a', canonicalRegion: 'region-a',
    currentMediaVersionId: 'version', currentScanGroupId: 'scan', publicDeliveryState: 'PUBLISHED',
    publicDerivativeKey: 'owned/key', processingBillingState: 'CONSUMED' };
  let responses = [{ Item: receipt }, { Item: asset }];
  f.client.send = async command => { commands.push(command); return { Responses: responses }; };
  assert.deepEqual(await f.repository.completedReceipt({ ...publication, createdAt: 'new-attempt-time' }),
    { createdAt: receipt.createdAt, publishedAt: receipt.publishedAt });
  assert.deepEqual(commands[0].input.TransactItems, [
    { Get: { TableName: 'audit', Key: { PK: 'PUBLICATION#receipt' } } },
    { Get: { TableName: 'metadata', Key: { PK: 'ASSET#asset' } } }
  ]);
  for (const field of ['id', 'product', 'environment', 'dataHomeRegion', 'assetId', 'mediaVersionId', 'scanGroupId',
    'sourceBucket', 'sourceObjectKey', 'destinationBucket', 'destinationObjectKey', 'contentHash', 'contentType', 'recordType']) {
    responses = [{ Item: { ...receipt, [field]: 'different' } }, { Item: asset }];
    assert.equal(await f.repository.completedReceipt(publication), undefined, field);
  }
  for (const field of Object.keys(asset)) {
    responses = [{ Item: receipt }, { Item: { ...asset, [field]: 'different' } }];
    assert.equal(await f.repository.completedReceipt(publication), undefined, field);
  }
  for (const invalid of [[], [{ Item: receipt }], [{}, { Item: asset }],
    [{ Item: { ...receipt, state: 'FAILED' } }, { Item: asset }],
    [{ Item: { ...receipt, publishedAt: undefined } }, { Item: asset }]]) {
    responses = invalid; assert.equal(await f.repository.completedReceipt(publication), undefined);
  }
  assert.ok(commands.every(command => command.constructor.name === 'TransactGetCommand'));
  const error = new Error('read unavailable'); f.client.send = async () => { throw error; };
  await assert.rejects(f.repository.completedReceipt(publication), value => value === error);
});
test('begin retains legacy keys and atomically claims an eligible scoped version', async () => {
  const f = fixture(); await f.repository.begin(publication);
  const command = f.commands[0]; assert.equal(command.constructor.name, 'TransactWriteCommand');
  assert.equal(command.input.TransactItems.length, 2);
  const [check, put] = command.input.TransactItems;
  assert.deepEqual(check.ConditionCheck.Key, { PK: 'ASSET#asset' });
  checkScope(check.ConditionCheck);
  assert.equal(check.ConditionCheck.TableName, 'metadata');
  assert.deepEqual(put.Put.Item, { ...publication, PK: 'PUBLICATION#receipt' });
  assert.equal(put.Put.TableName, 'audit');
  assert.equal(put.Put.ConditionExpression, 'attribute_not_exists(PK)');
});
test('completion fences receipt and asset while persisting the exact delivery key and audit', async () => {
  const f = fixture(); await f.repository.complete({ ...publication, state: 'PUBLISHED', publishedAt: publication.createdAt });
  const [receipt, asset, audit] = f.commands[0].input.TransactItems;
  assert.equal(f.commands[0].input.TransactItems.length, 3);
  assert.equal(receipt.Update.ConditionExpression, '#state = :publishing AND scanGroupId = :scanGroupId AND contentHash = :contentHash');
  assert.equal(receipt.Update.ExpressionAttributeValues[':contentHash'], publication.contentHash);
  assert.deepEqual(receipt.Update.Key, { PK: 'PUBLICATION#receipt' });
  checkScope(asset.Update);
  assert.equal(asset.Update.ExpressionAttributeValues[':key'], 'owned/key');
  assert.equal(audit.Put.Item.publicationId, 'receipt');
  assert.equal(audit.Put.Item.product, 'fixture');
  assert.equal(audit.Put.Item.scanGroupId, 'scan');
  assert.match(audit.Put.Item.PK, /^AUDIT#/);
  await assert.rejects(f.repository.complete(publication), /completed publication/);
  assert.equal(f.commands.length, 1);
});
test('failure is conditional and storage-service errors propagate without hidden retries', async () => {
  const f = fixture(); await f.repository.fail(publication, 'CopyFailed');
  assert.equal(f.commands[0].constructor.name, 'UpdateCommand');
  assert.equal(f.commands[0].input.ConditionExpression, '#state = :publishing');
  assert.deepEqual(f.commands[0].input.Key, { PK: 'PUBLICATION#receipt' });
  assert.equal(f.commands[0].input.ExpressionAttributeValues[':reason'], 'CopyFailed');
  const failure = new Error('ambiguous response'); let calls = 0;
  f.client.send = async () => { calls++; throw failure; };
  for (const operation of [() => f.repository.begin(publication),
    () => f.repository.complete({ ...publication, state: 'PUBLISHED', publishedAt: publication.createdAt }),
    () => f.repository.fail(publication, 'CopyFailed')]) await assert.rejects(operation(), error => error === failure);
  assert.equal(calls, 3);
});
