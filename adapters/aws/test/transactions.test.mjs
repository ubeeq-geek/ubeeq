import test from 'node:test';
import assert from 'node:assert/strict';
import { createDynamoRepositories } from '../dist/index.js';

const fixture = () => {
  const rows = new Map(), commands = [];
  const dynamo = { send: async command => {
    commands.push(command);
    const input = command.input;
    if (command.constructor.name === 'GetCommand') return { Item: structuredClone(rows.get(input.Key.pk)) };
    if (command.constructor.name === 'TransactWriteCommand') {
      const next = new Map(rows);
      const reasons = input.TransactItems.map(entry => {
        const write = entry.Put || entry.Delete, key = write.Item?.pk || write.Key.pk;
        const revision = write.ExpressionAttributeValues?.[':revision'];
        const failed = (write.ConditionExpression === 'attribute_not_exists(pk)' && rows.has(key)) ||
          (revision !== undefined && rows.get(key)?.revision !== revision);
        return { Code: failed ? 'ConditionalCheckFailed' : 'None' };
      });
      if (reasons.some(reason => reason.Code !== 'None')) throw Object.assign(Error('conflict'), { name: 'TransactionCanceledException', CancellationReasons: reasons });
      for (const entry of input.TransactItems) {
        const write = entry.Put || entry.Delete, key = write.Item?.pk || write.Key.pk;
        if (write.ConditionExpression === 'attribute_not_exists(pk)' && rows.has(key)) throw Object.assign(Error('conflict'), { name: 'TransactionCanceledException' });
        if (entry.Put) next.set(key, write.Item); else next.delete(key);
      }
      rows.clear(); for (const [key, value] of next) rows.set(key, value);
      return {};
    }
    throw Error(`Unexpected nontransactional write: ${command.constructor.name}`);
  } };
  return { rows, commands, repositories: createDynamoRepositories(dynamo, { tableName: 'records', cellId: 'cell' }) };
};

test('repository writes stage until one atomic batch and support reading staged records', async () => {
  const f = fixture();
  await f.repositories.transaction(async transaction => {
    await f.repositories.federationActors.create({ id: 'a' }, { transaction });
    assert.equal((await f.repositories.federationActors.get('a', { transaction })).id, 'a');
    await f.repositories.federationActors.create({ id: 'b' }, { transaction });
    assert.equal(f.rows.size, 0);
  });
  assert.equal(f.rows.size, 2);
  const batches = f.commands.filter(command => command.constructor.name === 'TransactWriteCommand');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].input.TransactItems.length, 2);
  assert.ok(batches[0].input.ClientRequestToken);
});

test('callback failure and commit conflict leave every staged write uncommitted', async () => {
  const f = fixture();
  await assert.rejects(f.repositories.transaction(async () => { await f.repositories.federationActors.create({ id: 'a' }); throw Error('abort'); }), /abort/);
  assert.equal(f.rows.size, 0);
  f.rows.set('federationActors#existing', { pk: 'federationActors#existing', value: { id: 'existing' } });
  await assert.rejects(f.repositories.transaction(async () => {
    await f.repositories.federationActors.create({ id: 'new' });
    await f.repositories.federationActors.create({ id: 'existing' });
  }), { name: 'TransactionCanceledException' });
  assert.equal(f.rows.size, 1);
});

test('caught unsupported operations poison the batch rather than partially committing', async () => {
  const f = fixture();
  await assert.rejects(f.repositories.transaction(async () => {
    await f.repositories.federationActors.create({ id: 'a' });
    await assert.rejects(f.repositories.federationActors.list({ limit: 10 }), /point reads/);
  }), /aborted/);
  assert.equal(f.commands.length, 0);
  await assert.rejects(f.repositories.transaction(async () => {
    await f.repositories.federationActors.create({ id: 'a' });
    await f.repositories.federationActors.create({ id: 'a' });
  }), /same item/);
  assert.equal(f.rows.size, 0);
});

test('independent callback contexts produce separate atomic batches', async () => {
  const f = fixture();
  await Promise.all(['a', 'b'].map(id => f.repositories.transaction(async () => {
    await f.repositories.federationActors.create({ id });
    await Promise.resolve();
    assert.equal((await f.repositories.federationActors.get(id)).id, id);
  })));
  const batches = f.commands.filter(command => command.constructor.name === 'TransactWriteCommand');
  assert.equal(batches.length, 2);
  assert.notEqual(batches[0].input.ClientRequestToken, batches[1].input.ClientRequestToken);
});

test('expired or foreign transaction handles cannot escape into standalone writes', async () => {
  const f = fixture(); let ended;
  await f.repositories.transaction(async transaction => { ended = transaction; });
  await assert.rejects(f.repositories.federationActors.create({ id: 'late' }, { transaction: ended }), /not active/);
  await assert.rejects(f.repositories.transaction(async () => {
    await f.repositories.federationActors.create({ id: 'foreign' }, { transaction: ended });
  }), /not active/);
  assert.equal(f.commands.length, 0);
});

test('oversized batches reject before any write is sent', async () => {
  const f = fixture();
  await assert.rejects(f.repositories.transaction(async () => {
    for (let index = 0; index <= 100; index++) await f.repositories.federationActors.create({ id: `item-${index}` });
  }), /100 distinct/);
  assert.equal(f.commands.length, 0);
});

test('revision failures at commit map to shared conflicts and roll back companion writes', async () => {
  for (const operation of ['update', 'remove']) {
    const f = fixture();
    await f.repositories.transaction(async () => { await f.repositories.federationActors.create({ id: 'versioned', label: 'original' }); });
    await assert.rejects(f.repositories.transaction(async transaction => {
      await f.repositories.federationActors.create({ id: 'companion' }, { transaction });
      if (operation === 'update') await f.repositories.federationActors.update('versioned', 1, { label: 'loser' }, { transaction });
      else await f.repositories.federationActors.remove('versioned', 1, { transaction });
      const previous = f.rows.get('federationActors#versioned');
      f.rows.set('federationActors#versioned', { ...previous, revision: 2, value: { ...previous.value, revision: 2, label: 'winner' } });
    }), error => error.name === 'OptimisticConcurrencyError' && error.id === 'versioned' && error.expectedRevision === 1);
    assert.equal(f.rows.has('federationActors#companion'), false);
    assert.equal(f.rows.get('federationActors#versioned').value.label, 'winner');
  }
});

test('loaded revision mismatch rejects before staging and all point reads request strong consistency', async () => {
  const f = fixture();
  await f.repositories.transaction(async () => { await f.repositories.federationActors.create({ id: 'versioned' }); });
  const before = f.commands.filter(command => command.constructor.name === 'TransactWriteCommand').length;
  await assert.rejects(f.repositories.transaction(async () => { await f.repositories.federationActors.update('versioned', 2, {}); }), { name: 'OptimisticConcurrencyError' });
  await f.repositories.federationActors.get('versioned');
  assert.ok(f.commands.filter(command => command.constructor.name === 'GetCommand').every(command => command.input.ConsistentRead === true));
  assert.equal(f.commands.filter(command => command.constructor.name === 'TransactWriteCommand').length, before);
});
