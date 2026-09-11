import test from 'node:test';
import assert from 'node:assert/strict';
import { AwsJobQueue, jobDiscoveryAttributes, jobCellTypePartition } from '../dist/index.js';
import { verifyJobQueueContract } from '@ubeeq/jobs';

const indexes = { cellDue: 'jobs-cell-due', cellTypeDue: 'jobs-cell-type-due' };
const conflict = () => Object.assign(new Error('conditional conflict'), { name: 'ConditionalCheckFailedException' });
class IndexedDynamo {
  rows = new Map(); calls = [];
  async send(command) {
    const input = command.input; this.calls.push(command);
    if (command.constructor.name === 'GetCommand') {
      assert.equal(input.ConsistentRead, true);
      return { Item: structuredClone(this.rows.get(input.Key.pk)) };
    }
    if (command.constructor.name === 'QueryCommand') {
      let rows;
      if (input.IndexName === 'repository-id-index') rows = [...this.rows.values()].filter(row => row.repository === input.ExpressionAttributeValues[':repository']);
      else {
        assert.ok(Object.values(indexes).includes(input.IndexName));
        assert.equal(input.FilterExpression, undefined); assert.equal(input.ConsistentRead, undefined);
        assert.equal(input.KeyConditionExpression, '#partition = :partition AND #due <= :due');
        assert.equal(input.ScanIndexForward, true); assert.equal(input.ProjectionExpression, '#pk, #sk');
        rows = [...this.rows.values()].filter(row => row[input.ExpressionAttributeNames['#partition']] === input.ExpressionAttributeValues[':partition'] &&
          typeof row.jobDue === 'number' && row.jobDue <= input.ExpressionAttributeValues[':due']);
      }
      rows.sort((a, b) => (a.jobDue ?? 0) - (b.jobDue ?? 0) || a.id.localeCompare(b.id));
      rows = rows.slice(0, input.Limit);
      return { Items: rows.map(row => input.IndexName === 'repository-id-index' ? structuredClone(row) : { pk: row.pk, sk: row.sk }) };
    }
    if (command.constructor.name === 'PutCommand') {
      const row = this.rows.get(input.Item.pk), values = input.ExpressionAttributeValues;
      if (input.ConditionExpression === 'attribute_not_exists(pk)' && row) throw conflict();
      if (input.ConditionExpression.includes('#revision') && (!row || row.revision !== values[':revision'])) throw conflict();
      if (input.ConditionExpression.includes('#due') && (row.value.cellId !== values[':cell'] || row.value.state !== values[':state'] || row.value[input.ExpressionAttributeNames['#due']] !== values[':due'])) throw conflict();
      if (input.ConditionExpression.includes('#expiry') && (row.value.state !== 'leased' || row.value.correlationId !== values[':owner'] || !(row.value.leaseExpiresAt > values[':now']))) throw conflict();
      this.rows.set(input.Item.pk, structuredClone(input.Item)); return {};
    }
    throw new Error(`Unexpected ${command.constructor.name}`);
  }
}
const makeQueue = (dynamo, extra = {}) => new AwsJobQueue(dynamo, { tableName: 'records', cellId: 'cell', jobDiscoveryIndexes: indexes, ...extra }, { send: async () => ({}) }, 'https://queue.test/jobs');
const enqueue = (queue, key, extra = {}) => queue.enqueue({ cellId: 'cell', type: 'render', payload: {}, idempotencyKey: key, maxAttempts: 3, availableAt: new Date(0).toISOString(), ...extra });
const lease = (queue, extra = {}) => queue.lease({ cellId: 'cell', types: ['render'], workerId: 'worker', leaseDurationSeconds: 60, ...extra });
const rowFor = value => ({ ...jobDiscoveryAttributes(value), pk: `durableJobs#${value.id}`, sk: 'record', repository: 'durableJobs', id: value.id, revision: value.revision, value });

test('indexed discovery satisfies the real shared queue contract and all transitions maintain sparse keys', async () => {
  const memory = new IndexedDynamo(), queue = makeQueue(memory);
  await verifyJobQueueContract(queue, 'indexed-contract');
  for (const row of memory.rows.values()) {
    const actual = Object.fromEntries(Object.entries(row).filter(([key]) => ['jobCell', 'jobCellType', 'jobDue'].includes(key)));
    assert.deepEqual(actual, jobDiscoveryAttributes(row.value));
  }
  const queries = memory.calls.filter(command => command.constructor.name === 'QueryCommand' && command.input.IndexName !== 'repository-id-index');
  assert.ok(queries.length > 0); assert.ok(queries.every(command => command.input.Limit <= 100));
});

test('typed due discovery reaches work behind hundreds of terminal, future, foreign-cell and unrelated-type records', async () => {
  const memory = new IndexedDynamo(), queue = makeQueue(memory);
  const target = await enqueue(queue, 'target');
  for (let i = 0; i < 400; i++) {
    const value = { ...target, id: `aaa-${i}`, ...(i < 100 ? { state: 'completed' } : i < 200 ? { availableAt: '2999-01-01T00:00:00.000Z' }
      : i < 300 ? { cellId: 'foreign' } : { type: 'unrelated' }) };
    const row = rowFor(value); memory.rows.set(row.pk, row);
  }
  memory.calls.length = 0;
  const result = await lease(queue);
  assert.equal(result.job.id, target.id);
  assert.deepEqual(memory.calls.map(command => command.constructor.name), ['QueryCommand', 'GetCommand', 'PutCommand']);
  assert.equal(memory.calls[0].input.IndexName, indexes.cellTypeDue);
  assert.equal(memory.calls[0].input.ExpressionAttributeValues[':partition'], jobCellTypePartition('cell', 'render'));
});

test('stale index rows cannot claim completed, future or wrong-cell/type base records', async () => {
  const memory = new IndexedDynamo(), queue = makeQueue(memory);
  for (const [key, change] of [['complete', { state: 'completed' }], ['future', { availableAt: '2999-01-01T00:00:00.000Z' }],
    ['foreign', { cellId: 'other' }], ['type', { type: 'other' }]]) {
    const job = await enqueue(queue, key);
    Object.assign(memory.rows.get(`durableJobs#${job.id}`).value, change); // Delayed GSI projection.
  }
  memory.calls.length = 0;
  assert.equal(await lease(queue), undefined);
  assert.equal(memory.calls.filter(command => command.constructor.name === 'PutCommand').length, 0);
  assert.equal(memory.calls.filter(command => command.constructor.name === 'GetCommand').length, 4);
});

test('indexed expired leases are reclaimed or exhausted without rediscovering terminal history', async () => {
  const memory = new IndexedDynamo(), queue = makeQueue(memory);
  const job = await enqueue(queue, 'expired', { maxAttempts: 2 });
  const first = await lease(queue);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const row = memory.rows.get(`durableJobs#${job.id}`);
    row.value.leaseExpiresAt = new Date(0).toISOString(); row.jobDue = 0;
    const next = await lease(queue);
    if (attempt === 1) { assert.equal(next.job.attempt, 2); assert.notEqual(next.leaseToken, first.leaseToken); }
    else assert.equal(next, undefined);
  }
  const row = memory.rows.get(`durableJobs#${job.id}`);
  assert.equal(row.value.state, 'dead_lettered'); assert.equal(row.jobDue, undefined); assert.equal(row.jobCellType, undefined);
  await queue.recover({ id: job.id, availableAt: new Date(0).toISOString() });
  assert.equal(memory.rows.get(row.pk).jobDue, 0);
  await queue.cancel({ id: job.id }); assert.equal(memory.rows.get(row.pk).jobDue, undefined);
});

test('index configuration, query fanout and candidate reads are bounded and type snapshots survive awaits', async () => {
  const memory = new IndexedDynamo(), configuration = { ...indexes }, queue = makeQueue(memory, { jobDiscoveryIndexes: configuration });
  configuration.cellTypeDue = 'wrong-index';
  for (const types of ['render', [null], [''], Array(17).fill('render')]) await assert.rejects(lease(queue, { types }));
  assert.equal(memory.calls.length, 0);
  await lease(queue, { types: Array.from({ length: 16 }, (_, i) => `type-${i}`) });
  assert.equal(memory.calls.length, 16);
  assert.ok(memory.calls.every(command => command.input.Limit === 6));
  for (const jobDiscoveryIndexes of [null, {}, { ...indexes, cellDue: 'x' }, { cellDue: 'same', cellTypeDue: 'same' }]) {
    assert.throws(() => makeQueue(memory, { jobDiscoveryIndexes }), /distinct job discovery indexes/);
  }
  memory.calls.length = 0;
  const target = await enqueue(queue, 'snapshot');
  let resume;
  const delayed = makeQueue({ send: async command => {
    if (command.constructor.name === 'QueryCommand') await new Promise(resolve => { resume = resolve; });
    return memory.send(command);
  } });
  const types = ['render'], pending = lease(delayed, { types });
  types[0] = 'other'; resume();
  assert.equal((await pending).job.id, target.id);
});

test('numeric due indexes support offset timestamps and untyped queries without filtering the repository', async () => {
  const memory = new IndexedDynamo(), queue = makeQueue(memory);
  const target = await enqueue(queue, 'offset', { availableAt: '1970-01-01T01:00:00+01:00' });
  assert.equal(memory.rows.get(`durableJobs#${target.id}`).jobDue, 0);
  const leased = await lease(queue, { types: undefined });
  assert.equal(leased.job.id, target.id);
  assert.equal(memory.calls.find(command => command.constructor.name === 'QueryCommand').input.IndexName, indexes.cellDue);
  assert.notEqual(jobCellTypePartition('a:b', 'c'), jobCellTypePartition('a', 'b:c'));
  for (const change of [{ type: '' }, { availableAt: 'invalid' }, { cellId: 'x'.repeat(2049) }]) assert.throws(() => jobDiscoveryAttributes({ ...target, ...change }));
});

test('sixteen populated stale partitions stay within a hundred candidate reads and no stale claims', async () => {
  const memory = new IndexedDynamo(), queue = makeQueue(memory);
  const template = await enqueue(queue, 'template'); memory.rows.clear();
  const types = Array.from({ length: 16 }, (_, i) => `type-${i}`);
  for (const type of types) for (let i = 0; i < 8; i++) {
    const row = rowFor({ ...template, id: `${type}-${i}`, type });
    row.value.state = 'completed'; memory.rows.set(row.pk, row);
  }
  memory.calls.length = 0;
  assert.equal(await lease(queue, { types }), undefined);
  assert.equal(memory.calls.filter(command => command.constructor.name === 'QueryCommand').length, 16);
  assert.equal(memory.calls.filter(command => command.constructor.name === 'GetCommand').length, 96);
  assert.equal(memory.calls.filter(command => command.constructor.name === 'PutCommand').length, 0);
});

test('a base-record change after strong reread still rejects the indexed claim condition', async () => {
  const memory = new IndexedDynamo(), queue = makeQueue(memory), job = await enqueue(queue, 'claim-race');
  const racing = makeQueue({ send: async command => {
    if (command.constructor.name === 'PutCommand' && command.input.ExpressionAttributeNames?.['#due']) {
      const row = memory.rows.get(command.input.Item.pk); row.revision++; row.value.revision++;
    }
    return memory.send(command);
  } });
  assert.equal(await lease(racing), undefined);
  assert.equal((await queue.get(job.id)).state, 'queued');
  assert.equal((await queue.get(job.id)).attempt, 0);
});

test('index and strong-read failures propagate without scan fallback, and malformed index responses reject', async () => {
  for (const at of ['query', 'get']) {
    const failure = new Error(`${at} unavailable`), calls = [];
    const queue = makeQueue({ send: async command => {
      calls.push(command.constructor.name);
      if (at === 'get' && command.constructor.name === 'QueryCommand') return { Items: [{ pk: 'durableJobs#id', sk: 'record' }] };
      throw failure;
    } });
    await assert.rejects(lease(queue), error => error === failure);
    assert.deepEqual(calls, at === 'get' ? ['QueryCommand', 'GetCommand'] : ['QueryCommand']);
  }
  for (const Items of [Array(101).fill({ pk: 'durableJobs#id', sk: 'record' }), [{ pk: 'creators#id', sk: 'record' }], [{ pk: 'durableJobs#', sk: 'record' }], 'invalid']) {
    const queue = makeQueue({ send: async () => ({ Items }) });
    await assert.rejects(lease(queue), /Invalid job discovery/);
  }
});
