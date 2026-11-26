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
        const write = entry.Put || entry.Delete || entry.ConditionCheck, key = write.Item?.pk || write.Key.pk;
        const revision = write.ExpressionAttributeValues?.[':revision'];
        const failed = (write.ConditionExpression === 'attribute_not_exists(pk)' && rows.has(key)) ||
          (revision !== undefined && rows.get(key)?.revision !== revision);
        return { Code: failed ? 'ConditionalCheckFailed' : 'None' };
      });
      if (reasons.some(reason => reason.Code !== 'None')) throw Object.assign(Error('conflict'), { name: 'TransactionCanceledException', CancellationReasons: reasons });
      for (const entry of input.TransactItems) {
        if(entry.ConditionCheck)continue;
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

test('absence guards condition the accepting commit, coalesce, and map a late insertion to revision-zero conflict',async()=>{
  const f=fixture(),repository=f.repositories.federationActors;
  await f.repositories.transaction(async transaction=>{
    await repository.checkAbsent('role',{transaction});await repository.checkAbsent('role',{transaction});
    await repository.create({id:'accepted'},{transaction});
  });
  const batch=f.commands.find(command=>command.constructor.name==='TransactWriteCommand');
  assert.equal(batch.input.TransactItems.filter(item=>item.ConditionCheck).length,1);
  await assert.rejects(f.repositories.transaction(async transaction=>{
    await repository.checkAbsent('late-role',{transaction});await repository.create({id:'rejected'},{transaction});
    f.rows.set('federationActors#late-role',{pk:'federationActors#late-role',sk:'record',revision:1,value:{id:'late-role',revision:1}});
  }),error=>error.name==='OptimisticConcurrencyError'&&error.id==='late-role'&&error.expectedRevision===0);
  assert.equal(f.rows.has('federationActors#rejected'),false);assert.equal(f.rows.has('federationActors#late-role'),true);
});

test('absence/revision contradictions and guard/write conflicts poison caught batches in either order',async()=>{
  for(const order of ['guard-write','write-guard','contradiction']){
    const f=fixture(),repository=f.repositories.federationActors;
    await assert.rejects(f.repositories.transaction(async transaction=>{
      await repository.create({id:'companion'},{transaction});
      if(order==='write-guard'){
        await repository.create({id:'role'},{transaction});
        await assert.rejects(repository.checkAbsent('role',{transaction}),/guard or write/);
      }else{
        await repository.checkAbsent('role',{transaction});
        if(order==='guard-write')await assert.rejects(repository.create({id:'role'},{transaction}),/guarded item/);
        else await assert.rejects(repository.checkRevision('role',1,{transaction}),{name:'OptimisticConcurrencyError'});
      }
    }),/aborted/);
    assert.equal(f.commands.filter(command=>command.constructor.name==='TransactWriteCommand').length,0);
    assert.equal(f.rows.size,0);
  }
});

test('unique absence guards count towards the physical hundred-item limit while duplicate guards do not',async()=>{
  const f=fixture(),repository=f.repositories.federationActors;
  await f.repositories.transaction(async transaction=>{
    for(let i=0;i<100;i++){await repository.checkAbsent('role-'+i,{transaction});await repository.checkAbsent('role-'+i,{transaction});}
  });
  assert.equal(f.commands.at(-1).input.TransactItems.length,100);
  const batches=f.commands.length;
  await assert.rejects(f.repositories.transaction(async transaction=>{for(let i=0;i<101;i++)await repository.checkAbsent('overflow-'+i,{transaction});}),/100 distinct/);
  assert.equal(f.commands.length,batches);
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

test('caught local revision conflicts abort companion writes rather than committing an incomplete operation', async () => {
  for (const missing of [false, true]) {
    const f = fixture();
    await f.repositories.transaction(async () => { await f.repositories.federationActors.create({ id: 'versioned', label: 'original' }); });
    const before = f.commands.filter(command => command.constructor.name === 'TransactWriteCommand').length;
    await assert.rejects(f.repositories.transaction(async () => {
      await f.repositories.federationActors.create({ id: 'companion' });
      await assert.rejects(f.repositories.federationActors.update(missing ? 'missing' : 'versioned', 2, { label: 'bad' }), { name: 'OptimisticConcurrencyError' });
    }), /aborted/);
    assert.equal(f.commands.filter(command => command.constructor.name === 'TransactWriteCommand').length, before);
    assert.equal(f.rows.has('federationActors#companion'), false);
    assert.equal(f.rows.get('federationActors#versioned').value.label, 'original');
  }
});
