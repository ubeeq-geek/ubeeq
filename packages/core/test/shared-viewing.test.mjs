import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedViewingService } from '../dist/index.js';
function fixture() {
  const rooms = new Map(); let now = 1000000, allowed = true;
  const store = { create: async r => { if (rooms.has(r.roomId)) return false; rooms.set(r.roomId, structuredClone(r)); return true; },
    get: async id => rooms.get(id) ?? null,
    compareAndSwap: async (r, rev) => { if (rooms.get(r.roomId)?.revision !== rev) return false; rooms.set(r.roomId, structuredClone(r)); return true; } };
  const service = new SharedViewingService(store, { canHost: async actor => actor === 'host', canView: async actor => allowed && ['host', 'viewer'].includes(actor) }, () => now);
  return { service, rooms, advance: ms => { now += ms; }, revoke: () => { allowed = false; } };
}
const items = [{ workId: 'gallery', kind: 'image' }, { workId: 'song', kind: 'audio', durationSeconds: 120 }];
test('gallery selection and timed playback synchronize late joiners', async () => {
  const { service, advance } = fixture();
  await service.create('host', 'room', items);
  await service.control('host', 'room', 0, { type: 'select', index: 1 });
  await service.control('host', 'room', 1, { type: 'play' });
  advance(5000);
  assert.equal((await service.read('viewer', 'room')).positionSeconds, 5);
  await service.control('host', 'room', 2, { type: 'pause' });
  advance(10000);
  assert.equal((await service.read('viewer', 'room')).positionSeconds, 5);
  await service.control('host', 'room', 3, { type: 'seek', positionSeconds: 119 });
  await service.control('host', 'room', 4, { type: 'play' });
  advance(5000);
  assert.equal((await service.read('viewer', 'room')).positionSeconds, 120);
});
test('viewers cannot control and revoked access cannot read', async () => {
  const { service, revoke } = fixture();
  await service.create('host', 'room', items);
  await assert.rejects(service.control('viewer', 'room', 0, { type: 'close' }), { code: 'denied' });
  await assert.rejects(service.read('stranger', 'room'), { code: 'denied' });
  revoke();
  await assert.rejects(service.read('viewer', 'room'), { code: 'denied' });
});
test('simultaneous controls use atomic revision conflict protection', async () => {
  const { service } = fixture(); await service.create('host', 'room', items);
  const results = await Promise.allSettled([service.control('host', 'room', 0, { type: 'select', index: 1 }), service.control('host', 'room', 0, { type: 'select', index: 1 })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'conflict');
});
test('closed and expired rooms reject reads', async () => {
  const { service, advance } = fixture();
  await service.create('host', 'closed', items); await service.control('host', 'closed', 0, { type: 'close' });
  await assert.rejects(service.read('viewer', 'closed'), { code: 'denied' });
  await service.create('host', 'expired', items, 60); advance(60000);
  await assert.rejects(service.read('viewer', 'expired'), { code: 'denied' });
});
test('invalid controls and unbounded input fail without changing state', async () => {
  const { service } = fixture();
  await assert.rejects(service.create('host', 'room', Array(101).fill(items[0])), { code: 'invalid' });
  await assert.rejects(service.create('host', 'room', [{ workId: 'x', kind: 'video' }]), { code: 'invalid' });
  await service.create('host', 'room', items);
  for (const action of [{ type: 'play' }, { type: 'select', index: -1 }, { type: 'seek', positionSeconds: NaN }]) await assert.rejects(service.control('host', 'room', 0, action), { code: 'invalid' });
  assert.equal((await service.read('viewer', 'room')).room.revision, 0);
});
test('returned state and input cannot mutate persisted state', async () => {
  const { service } = fixture(); const list = structuredClone(items);
  const created = await service.create('host', 'room', list); list[0].workId = 'changed'; created.items[0].workId = 'changed';
  const read = await service.read('viewer', 'room'); read.room.items[0].workId = 'changed';
  assert.equal((await service.read('viewer', 'room')).room.items[0].workId, 'gallery');
});
