import assert from 'node:assert/strict';
import test from 'node:test';
import { auditJobIndexPage, jobDiscoveryAttributes } from '../dist/index.js';
const row = (id, state = 'queued') => {
  const value = { id, revision: 1, cellId: 'cell', type: 'type', state, availableAt: '1970-01-01T00:00:00Z', leaseExpiresAt: '1970-01-01T00:01:00Z' };
  return { pk: `durableJobs#${id}`, sk: 'record', repository: 'durableJobs', id, revision: 1, value, ...jobDiscoveryAttributes(value) };
};
const fake = items => ({ send: async command => {
  assert.equal(command.constructor.name, 'ScanCommand');
  assert.equal(command.input.IndexName, undefined);
  assert.equal(command.input.FilterExpression, undefined);
  assert.equal(command.input.ConsistentRead, true);
  assert.ok(command.input.Limit <= 100);
  assert.ok(!command.input.ProjectionExpression.includes('payload'));
  assert.ok(!command.input.ProjectionExpression.split(', ').includes('#value'));
  return { Items: items, ScannedCount: items.length };
} });

test('audits active and terminal attributes without returning payloads', async () => {
  const items = ['queued', 'retry_scheduled', 'leased', 'completed', 'cancelled', 'dead_lettered'].map((state, i) => row(String(i), state));
  const missing = row('missing'); delete missing.jobDue;
  const stale = row('stale', 'completed'); stale.jobCell = 'cell';
  const invalid = row('invalid'); invalid.value.state = 'unknown';
  const wrong = row('wrong'); wrong.value.revision = 2;
  const badDue = row('bad-date'); badDue.value.availableAt = 'bad';
  items.push(missing, stale, invalid, wrong, badDue, { pk: 'works#x', sk: 'record', repository: 'works' });
  items[0].value.payload = { secret: 'must-not-leak' };
  const result = await auditJobIndexPage(fake(items), { tableName: 'records' });
  assert.equal(result.evaluated, 12); assert.equal(result.jobs, 11); assert.equal(result.matching, 6);
  assert.deepEqual(result.issues.map(issue => issue.reason), ['missing_or_mismatched_attributes', 'missing_or_mismatched_attributes', 'invalid_record', 'invalid_record', 'invalid_record']);
  assert.ok(!JSON.stringify(result).includes('must-not-leak'));
});

test('one call reads one page and resumes through pages containing no jobs', async () => {
  const calls = [];
  const client = { send: async command => {
    calls.push(command.input);
    return calls.length === 1 ? { Items: [{ pk: 'works#x', sk: 'record' }], ScannedCount: 1, LastEvaluatedKey: { pk: 'works#x', sk: 'record' } } : { Items: [row('next')], ScannedCount: 1 };
  } };
  const first = await auditJobIndexPage(client, { tableName: 'records', limit: 1 });
  assert.equal(calls.length, 1); assert.equal(first.jobs, 0); assert.ok(first.nextCursor);
  const second = await auditJobIndexPage(client, { tableName: 'records', limit: 1, cursor: first.nextCursor });
  assert.deepEqual(calls[1].ExclusiveStartKey, first.nextCursor.key);
  assert.equal(second.matching, 1); assert.equal(second.nextCursor, undefined);
});

test('rejects invalid bounds and cross-table cursors before sending', async () => {
  const client = { send: async () => assert.fail('must not send') };
  for (const limit of [0, 101, 1.5, NaN]) await assert.rejects(auditJobIndexPage(client, { tableName: 'records', limit }));
  await assert.rejects(auditJobIndexPage(client, { tableName: 'records', cursor: { tableName: 'other', key: { pk: 'x', sk: 'record' } } }));
  await assert.rejects(auditJobIndexPage(client, { tableName: 'records', cursor: { tableName: 'records', key: { pk: 'x', sk: 'record', injected: true } } }));
});

test('bounded traversal finds missing attributes beyond the first hundred records', async () => {
  const items = Array.from({ length: 250 }, (_, i) => row(String(i), 'completed'));
  const target = row('historical'); delete target.jobCell; delete target.jobCellType; delete target.jobDue;
  items.push(target);
  let calls = 0;
  const client = { send: async command => {
    calls++;
    const start = command.input.ExclusiveStartKey ? items.findIndex(item => item.pk === command.input.ExclusiveStartKey.pk) + 1 : 0;
    const page = items.slice(start, start + command.input.Limit);
    const last = page.at(-1);
    return { Items: page, ScannedCount: page.length, ...(start + page.length < items.length ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
  } };
  let cursor, evaluated = 0;
  const issues = [];
  do {
    const page = await auditJobIndexPage(client, { tableName: 'records', cursor });
    evaluated += page.evaluated; issues.push(...page.issues); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(calls, 3); assert.equal(evaluated, 251);
  assert.deepEqual(issues, [{ key: { pk: target.pk, sk: 'record' }, reason: 'missing_or_mismatched_attributes' }]);
});

test('fails on malformed responses, nonadvancing cursors and infrastructure errors', async () => {
  for (const response of [{}, { Items: [], ScannedCount: 1 }, { Items: [null], ScannedCount: 1 }, { Items: [], ScannedCount: 0, LastEvaluatedKey: { pk: 'x' } }]) {
    await assert.rejects(auditJobIndexPage({ send: async () => response }, { tableName: 'records' }));
  }
  const cursor = { tableName: 'records', key: { pk: 'x', sk: 'record' } };
  await assert.rejects(auditJobIndexPage({ send: async () => ({ Items: [], ScannedCount: 0, LastEvaluatedKey: cursor.key }) }, { tableName: 'records', cursor }), /did not advance/);
  const failure = new Error('unavailable');
  await assert.rejects(auditJobIndexPage({ send: async () => { throw failure; } }, { tableName: 'records' }), error => error === failure);
});
