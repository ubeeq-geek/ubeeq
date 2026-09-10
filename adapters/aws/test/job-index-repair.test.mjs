import assert from 'node:assert/strict';
import test from 'node:test';
import { repairJobIndexAttributes, jobDiscoveryAttributes } from '../dist/index.js';
const target = { tableName: 'records', cellId: 'cell', jobId: 'job', expectedRevision: 1 };
const row = state => ({ pk: 'durableJobs#job', sk: 'record', repository: 'durableJobs', id: 'job', revision: 1,
  value: { id: 'job', revision: 1, cellId: 'cell', type: 'image', state, availableAt: '1970-01-01T00:00:00Z', leaseExpiresAt: '1970-01-01T00:01:00Z', payload: { secret: 'preserve' }, attempt: 1 }, extra: 'preserve' });
const fake = initial => {
  const state = { item: structuredClone(initial), calls: [], beforeUpdate: undefined };
  state.send = async command => {
    state.calls.push(command);
    const input = command.input;
    if (command.constructor.name === 'GetCommand') {
      assert.equal(input.ConsistentRead, true);
      assert.ok(!input.ProjectionExpression.includes('payload'));
      return { Item: structuredClone(state.item) };
    }
    assert.equal(command.constructor.name, 'UpdateCommand');
    state.beforeUpdate?.();
    const path = expression => expression.split('.').map(name => input.ExpressionAttributeNames[name]);
    const read = expression => path(expression).reduce((value, name) => value?.[name], state.item);
    for (const condition of input.ConditionExpression.split(' AND ')) {
      const absent = condition.match(/^attribute_not_exists\((.+)\)$/);
      const [field, , value] = condition.split(' ');
      if (absent ? read(absent[1]) !== undefined : !Object.is(read(field), input.ExpressionAttributeValues[value])) {
        throw Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
      }
    }
    if (input.UpdateExpression.startsWith('SET ')) {
      for (const assignment of input.UpdateExpression.slice(4).split(', ')) {
        const [field, , value] = assignment.split(' ');
        assert.equal(path(field).length, 1);
        state.item[path(field)[0]] = input.ExpressionAttributeValues[value];
      }
    } else {
      assert.ok(input.UpdateExpression.startsWith('REMOVE '));
      for (const field of input.UpdateExpression.slice(7).split(', ')) delete state.item[path(field)[0]];
    }
    return {};
  };
  return state;
};

test('dry run is default; explicit apply repairs attributes only and is repeatable', async () => {
  for (const state of ['queued', 'retry_scheduled', 'leased', 'completed', 'cancelled', 'dead_lettered']) {
    const original = row(state);
    const client = fake({ ...original, jobCell: 'wrong' });
    assert.deepEqual(await repairJobIndexAttributes(client, target), { status: 'would_repair' });
    assert.equal(client.calls.length, 1);
    assert.deepEqual(await repairJobIndexAttributes(client, { ...target, apply: true }), { status: 'repaired' });
    assert.deepEqual(client.item, { ...original, ...jobDiscoveryAttributes(original.value) });
    assert.deepEqual(await repairJobIndexAttributes(client, { ...target, apply: true }), { status: 'unchanged' });
    assert.equal(client.calls.filter(call => call.constructor.name === 'UpdateCommand').length, 1);
  }
});

test('stale revision, missing, malformed and foreign-cell targets never write', async () => {
  assert.deepEqual(await repairJobIndexAttributes(fake(undefined), target), { status: 'missing' });
  const stale = row('queued'); stale.revision = stale.value.revision = 2;
  assert.deepEqual(await repairJobIndexAttributes(fake(stale), { ...target, apply: true }), { status: 'conflict' });
  for (const change of [item => { item.value.cellId = 'foreign'; }, item => { item.value.state = 'unknown'; }, item => { item.value.availableAt = 'bad'; }, item => { item.value.revision = 2; }]) {
    const item = row('queued'); change(item); const client = fake(item);
    await assert.rejects(repairJobIndexAttributes(client, { ...target, apply: true }));
    assert.equal(client.calls.length, 1);
  }
});

test('changes after strong read fence repairs, including expiry and discovery changes', async () => {
  for (const change of [item => { item.revision++; item.value.revision++; }, item => { item.value.state = 'completed'; }, item => { item.value.leaseExpiresAt = '1970-01-02T00:00:00Z'; }, item => { item.value.cellId = 'foreign'; }, item => { item.jobDue = 42; }]) {
    const client = fake(row('leased')); client.beforeUpdate = () => change(client.item);
    assert.deepEqual(await repairJobIndexAttributes(client, { ...target, apply: true }), { status: 'conflict' });
    assert.equal(client.item.jobCell, undefined);
  }
});

test('invalid requests reject before reads and uncertain write failures propagate', async () => {
  for (const change of [{ apply: 'true' }, { expectedRevision: 0 }, { jobId: '' }, { tableName: '' }, { cellId: '' }]) {
    await assert.rejects(repairJobIndexAttributes({ send: async () => assert.fail('no access') }, { ...target, ...change }));
  }
  const failure = new Error('timeout');
  await assert.rejects(repairJobIndexAttributes({ send: async command => {
    if (command.constructor.name === 'GetCommand') return { Item: row('queued') };
    throw failure;
  } }, { ...target, apply: true }), error => error === failure);
});

test('a lost success response can be reconciled without a second write', async () => {
  const client = fake(row('queued'));
  const send = client.send;
  const timeout = new Error('response lost');
  client.send = async command => {
    const result = await send(command);
    if (command.constructor.name === 'UpdateCommand') throw timeout;
    return result;
  };
  await assert.rejects(repairJobIndexAttributes(client, { ...target, apply: true }), error => error === timeout);
  assert.deepEqual(await repairJobIndexAttributes(client, { ...target, apply: true }), { status: 'unchanged' });
  assert.equal(client.calls.filter(command => command.constructor.name === 'UpdateCommand').length, 1);
});
