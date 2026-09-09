import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamoSmugMugRepository } from '../dist/index.js';

const fixture = () => {
  const commands = [];
  const client = { send: async command => { commands.push(command); return client.respond(command); }, respond: async () => ({}) };
  return { client, commands, repository: new DynamoSmugMugRepository(client, 'records') };
};
const connection = { id: 'connection', userId: 'actor', creatorId: 'creator', state: 'CONNECTED', inventoryScopeId: 'scope', inventoryInProgress: true };
const conditional = { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] };

test('inventory metadata chunks retain the exact connection fence and isolated scope', async () => {
  const f = fixture();
  const images = Array.from({ length: 49 }, (_, i) => ({ remoteId: `image-${i}` }));
  await f.repository.mergeInventoryPage(connection, [], images);
  assert.deepEqual(f.commands.map(c => c.input.TransactItems.length), [25, 25, 2]);
  for (const command of f.commands) {
    assert.equal(command.constructor.name, 'TransactWriteCommand');
    const [fence, ...writes] = command.input.TransactItems;
    assert.deepEqual(fence.ConditionCheck.Key, { PK: 'SMUGMUG_CONNECTION#connection', SK: 'PROFILE' });
    assert.deepEqual(fence.ConditionCheck.ExpressionAttributeValues[':expected'], connection);
    assert.equal(fence.ConditionCheck.ConditionExpression, '#value = :expected');
    for (const write of writes) assert.equal(write.Put.Item.PK, 'SMUGMUG_CONNECTION#scope');
  }
  f.client.respond = async () => { throw conditional; };
  await assert.rejects(f.repository.mergeInventoryPage(connection, [], []), { code: 'INVENTORY_WRITE_CONFLICT' });
  const unavailable = { ...conditional, CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'ProvisionedThroughputExceeded' }] };
  f.client.respond = async () => { throw unavailable; };
  await assert.rejects(f.repository.mergeInventoryPage(connection, [], []), error => error === unavailable);
});

test('completion atomically writes the guarded connection, receipt and discovery index', async () => {
  const f = fixture();
  const expected = { ...connection, inventoryPagesComplete: true };
  const completed = { ...expected, state: 'INVENTORY_READY', inventoryInProgress: false, completedInventoryScopeId: 'scope' };
  const migration = { id: 'migration', connectionId: 'connection', userId: 'actor', creatorId: 'creator', inventoryScopeId: 'scope', status: 'REVIEW' };
  assert.equal(await f.repository.completeInventory(completed, expected, migration), true);
  const writes = f.commands[0].input.TransactItems.map(v => v.Put);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map(v => v.Item.PK), ['SMUGMUG_CONNECTION#connection', 'SMUGMUG_MIGRATION#migration', 'SMUGMUG_MIGRATIONS#connection']);
  assert.deepEqual(writes[0].ExpressionAttributeValues[':expected'], expected);
  assert.equal(writes[1].ConditionExpression, 'attribute_not_exists(PK)');
  assert.equal(writes[2].ConditionExpression, 'attribute_not_exists(PK)');
  f.client.respond = async () => { throw conditional; };
  assert.equal(await f.repository.completeInventory(completed, expected, migration), false);
  const unavailable = new Error('unavailable');
  f.client.respond = async () => { throw unavailable; };
  await assert.rejects(f.repository.completeInventory(completed, expected, migration), error => error === unavailable);
  const count = f.commands.length;
  await assert.rejects(f.repository.completeInventory(completed, expected, { ...migration, creatorId: 'other' }), /identity mismatch/);
  assert.equal(f.commands.length, count);
});

test('bounded metadata and item reads validate continuation scope and use strong consistency', async () => {
  for (const [method, prefix, partition] of [
    ['getImagePage', 'IMAGE#', 'SMUGMUG_CONNECTION#scope'],
    ['getCollectionPage', 'COLLECTION#', 'SMUGMUG_CONNECTION#scope'],
    ['getItemPage', 'ITEM#', 'SMUGMUG_MIGRATION#scope']
  ]) {
    const f = fixture();
    f.client.respond = async () => ({ Items: [{ value: { remoteId: 'next' } }], LastEvaluatedKey: { PK: partition, SK: `${prefix}next` } });
    assert.deepEqual(await f.repository[method]('scope', 10, 'previous'), { items: [{ remoteId: 'next' }], nextAfterRemoteId: 'next' });
    const input = f.commands[0].input;
    assert.equal(input.Limit, 10); assert.equal(input.ConsistentRead, true);
    assert.deepEqual(input.ExclusiveStartKey, { PK: partition, SK: `${prefix}previous` });
    f.client.respond = async () => ({ LastEvaluatedKey: { PK: 'foreign', SK: `${prefix}next` } });
    await assert.rejects(f.repository[method]('scope', 10), /continuation/);
    await assert.rejects(f.repository[method]('scope', 101), { code: 'INVALID_ITEM_PAGE' });
    assert.equal(f.commands.length, 2);
  }
});

test('item initialization retains existing progress only after a consistent identity check', async () => {
  const f = fixture();
  const item = { migrationId: 'migration', remoteId: 'image', idempotencyKey: 'key', state: 'PENDING' };
  f.client.respond = async command => {
    if (command.constructor.name === 'PutCommand') throw { name: 'ConditionalCheckFailedException' };
    return { Item: { value: { ...item, state: 'TRANSFERRED' } } };
  };
  await f.repository.putItemIfAbsent('migration', item);
  assert.equal(f.commands[0].input.ConditionExpression, 'attribute_not_exists(PK)');
  assert.equal(f.commands[1].input.ConsistentRead, true);
  assert.equal(f.commands.length, 2);
  f.client.respond = async command => {
    if (command.constructor.name === 'PutCommand') throw { name: 'ConditionalCheckFailedException' };
    return { Item: { value: { ...item, idempotencyKey: 'other' } } };
  };
  await assert.rejects(f.repository.putItemIfAbsent('migration', item), /initialization conflict/);
});
