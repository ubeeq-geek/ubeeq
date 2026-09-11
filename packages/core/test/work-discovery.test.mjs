import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkDiscoveryParticipation } from '../dist/index.js';
const input = { tenantId: 'tenant', creatorId: 'creator', workId: 'work', now: '2026-09-10T00:00:00Z', removalReason: 'Caller reason' };
test('discovery states preserve scope and select only their applicable timestamps', () => {
  for (const state of ['none', 'eligible', 'opted_in', 'removed']) {
    const value = createWorkDiscoveryParticipation({ ...input, state });
    assert.equal(value.tenantId, input.tenantId); assert.equal(value.creatorId, input.creatorId); assert.equal(value.workId, input.workId);
    assert.equal(value.state, state); assert.equal(value.updatedAt, input.now);
    assert.equal(value.optedInAt, state === 'opted_in' ? input.now : undefined);
    assert.equal(value.withdrawnAt, state === 'none' ? input.now : undefined);
    assert.equal(value.removedAt, state === 'removed' ? input.now : undefined);
    assert.equal(value.removalReason, state === 'removed' ? input.removalReason : undefined);
  }
});
test('invalid scope, state and time reject instead of constructing participation', () => {
  for (const patch of [{ tenantId: '' }, { creatorId: ' ' }, { workId: undefined }, { state: 'public' }, { now: 'invalid' }]) {
    assert.throws(() => createWorkDiscoveryParticipation({ ...input, state: 'eligible', ...patch }), /Invalid discovery/);
  }
});
