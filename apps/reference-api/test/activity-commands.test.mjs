import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReferenceApi } from '../dist/server.js';
import { createLocalAdapterSet, LocalActivityWorkflowStore } from '@ubeeq/adapter-local';
import { ActivityWorkflows, ActivityCommandInterface } from '@ubeeq/integrations';
test('authenticated HTTP activity interface uses session identity and persistent workflows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'activity-api-'));
  const local = createLocalAdapterSet({ databasePath: join(dir, 'state.sqlite'), dataDirectory: dir, cellId: 'cell', publicBaseUrl: 'http://localhost' });
  const store = new LocalActivityWorkflowStore(local.database, 'instance'), posted = [];
  const event = { id: 'event', creatorId: 'creator', platform: 'native', sourceAt: '2026-09-15T12:00:00Z', kind: 'comment', commentId: 'comment' };
  await store.append(event);
  const workflows = new ActivityWorkflows(store, {
    choices: async actor => ({ creators: actor === 'owner' ? [{ id: 'creator', name: 'Creator' }] : [], platforms: ['native'] }),
    authorize: async actor => actor === 'owner', visible: async () => true,
    comment: async () => ({ id: 'comment', creatorId: 'creator', platform: 'native', body: 'Hello', workTitle: 'Work', answered: false, replyAllowed: true, thread: [] }),
    reply: async input => { posted.push(input); return 'sent'; }, canNotify: async () => false, notify: async () => 'not_sent'
  });
  const api = createReferenceApi({ publicBaseUrl: 'http://127.0.0.1:0', cellId: 'cell', activityCommands: new ActivityCommandInterface(workflows),
    adapters: { repositories: local.repositories, storage: local.storage, uploads: local.storage, delivery: local.storage, jobs: local.jobs,
      identity: { verifySession: async ({ credential }) => ['owner', 'other'].includes(credential) ? { id: credential, subject: { id: credential, roles: [], scopes: [] } } : undefined } } });
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${api.server.address().port}/v1/activity/command`;
  const send = (command, token = 'owner') => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ command, actorId: 'owner', profileId: 'injected' }) });
  try {
    assert.equal((await send('activity', '')).status, 401);
    assert.match((await (await send('activity', 'other')).json()).text, /No authorized/);
    const response = await send('activity'); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const token = (await response.json()).text.match(/ack (\S+)/)[1];
    assert.match((await (await send(`ack ${token}`)).json()).text, /checkpoint saved/);
    assert.match((await (await send('activity')).json()).text, /No new activity/);
    const ref = (await (await send('inbox')).json()).text.split(' ')[0];
    const preview = (await (await send(`reply ${ref} Thank you`)).json()).text.match(/confirm (\S+)/)[1];
    await send(`confirm ${preview}`); await send(`confirm ${preview}`);
    assert.equal(posted.length, 1); assert.equal(posted[0].actorId, 'owner');
    assert.equal((await send('x'.repeat(4097))).status, 400);
  } finally { await api.close(); local.database.database.close(); rmSync(dir, { recursive: true, force: true }); }
});
