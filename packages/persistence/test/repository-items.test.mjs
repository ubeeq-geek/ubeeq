import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryItems } from '../dist/index.js';

test('repository iteration follows empty pages and fails on repeated cursors or backend errors', async () => {
  const calls = [];
  const rows = [];
  for await (const row of repositoryItems(async request => {
    calls.push(request);
    if (!request.cursor) return { items: [1], nextCursor: 'one' };
    if (request.cursor === 'one') return { items: [], nextCursor: 'two' };
    return { items: [2] };
  }, 7)) rows.push(row);
  assert.deepEqual(rows, [1, 2]);
  assert.deepEqual(calls, [{ limit: 7 }, { limit: 7, cursor: 'one' }, { limit: 7, cursor: 'two' }]);
  await assert.rejects(async () => { for await (const row of repositoryItems(async () => ({ items: [], nextCursor: 'same' }))) void row; }, /repeated a cursor/);
  await assert.rejects(async () => { for await (const row of repositoryItems(async () => { throw new Error('backend unavailable'); })) void row; }, /backend unavailable/);
});
