import test from 'node:test';
import assert from 'node:assert/strict';
import { AiAssistanceService } from '../dist/ai-assistance.js';
const p = { tenantId: 'tenant', userId: 'user' };
const input = { title: 'its a trap', casing: 'title', language: 'en', preservedNames: [] };
class Store {
  rows = new Map();
  async get(key) { return structuredClone(this.rows.get(key) ?? null); }
  async commit(writes) {
    if (writes.some(w => (this.rows.get(w.key)?.revision ?? null) !== w.revision)) return false;
    for (const w of writes) this.rows.set(w.key, { revision: (w.revision ?? 0) + 1, value: structuredClone(w.value) });
    return true;
  }
}
async function fixture({ config = {}, provider, canEdit = async () => true, store = new Store() } = {}) {
  const events = [], calls = [];
  provider ??= { identity: 'fake-v1', async polishTitle(i) { calls.push(i); return { result: { status: 'changed', suggestion: 'It’s a Trap' }, inputTokens: 40, outputTokens: 10 }; } };
  const service = new AiAssistanceService({ enabled: true, perUserDailyLimit: 50, instanceDailyBudgetUsd: 10, maxRequestCostUsd: 1, ...config }, { store, provider, canEdit, observe: e => events.push(e) });
  await service.initializePreference(p, true);
  return { service, store, events, calls };
}
test('framework default is disabled and explicit migration never overwrites opt-out', async () => {
  const f = await fixture({ config: { enabled: false } });
  await assert.rejects(f.service.polishTitle(p, 'title', input), { code: 'disabled' });
  await f.service.setPreference(p, false); await f.service.initializePreference(p, true);
  assert.equal((await f.service.preference(p)).showAiAssistance, false); assert.equal(f.calls.length, 0);
});
test('three per-title attempts persist across sessions, text changes, and editors', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.service.polishTitle(p, 'title', { ...input, title: input.title + i });
  await assert.rejects(f.service.polishTitle(p, 'title', input), { code: 'limit', message: 'Polish limit reached for this title.' });
  const other = { ...p, userId: 'editor' }; await f.service.initializePreference(other, true);
  await assert.rejects(f.service.polishTitle(other, 'title', input), { code: 'limit' });
  const another = await fixture({ store: f.store });
  assert.equal((await another.service.availability(p, 'title')).remaining, 0);
});
test('atomic reservations prevent concurrent overspending across service workers', async () => {
  const store = new Store();
  const a = await fixture({ store }), b = await fixture({ store });
  const settled = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).service.polishTitle(p, 'title', input)));
  assert.equal(settled.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal(a.calls.length + b.calls.length, 3);
});
test('configuration can change title quota; daily user and instance budget stop calls', async () => {
  const title = await fixture({ config: { perTitleLimit: 1 } }); await title.service.polishTitle(p, 'title', input);
  await assert.rejects(title.service.polishTitle(p, 'title', input), { code: 'limit' });
  for (const config of [{ perUserDailyLimit: 1 }, { instanceDailyBudgetUsd: 1 }]) {
    const f = await fixture({ config }); await f.service.polishTitle(p, 'first', input);
    await assert.rejects(f.service.polishTitle(p, 'second', { ...input, title: 'other' }), { code: 'limit' }); assert.equal(f.calls.length, 1);
  }
});
test('opt-out blocks direct requests and discards in-flight output, even after toggling back on', async () => {
  let finish, started;
  const running = new Promise(resolve => { started = resolve; });
  const f = await fixture({ provider: { identity: 'fake', async polishTitle() { started(); return new Promise(resolve => { finish = resolve; }); } } });
  const pending = f.service.polishTitle(p, 'title', input); await running;
  await f.service.setPreference(p, false);
  await assert.rejects(f.service.polishTitle(p, 'another', input), { code: 'disabled' });
  await f.service.setPreference(p, true);
  finish({ result: { status: 'changed', suggestion: 'Changed' }, inputTokens: 1, outputTokens: 1 });
  await assert.rejects(pending, { code: 'disabled' });
});
test('permission, invalid input, invalid output and timeouts leave source unchanged', async () => {
  const denied = await fixture({ canEdit: async () => false });
  await assert.rejects(denied.service.polishTitle(p, 'title', input), { code: 'denied' }); assert.equal(denied.calls.length, 0);
  const f = await fixture(); await assert.rejects(f.service.polishTitle(p, 'title', { ...input, title: 'x'.repeat(501) }), { code: 'invalid' });
  for (const result of [{ status: 'changed', suggestion: '' }, { status: 'made_up' }, { status: 'changed', suggestion: 'fine', instructions: 'execute' }]) {
    const invalid = await fixture({ provider: { identity: 'bad', async polishTitle() { return { result, inputTokens: 1, outputTokens: 1 }; } } });
    await assert.rejects(invalid.service.polishTitle(p, 'title', input), { code: 'unavailable' });
  }
  const slow = await fixture({ config: { timeoutMs: 5 }, provider: { identity: 'slow', async polishTitle() { return new Promise(() => {}); } } });
  await assert.rejects(slow.service.polishTitle(p, 'title', input), { code: 'unavailable' });
  assert.equal(input.title, 'its a trap');
});
test('cache partitions by user, tenant, model/options/context and still consumes title allowance', async () => {
  const f = await fixture();
  await f.service.polishTitle(p, 'title', input); await f.service.polishTitle(p, 'title', input);
  assert.equal(f.calls.length, 1); assert.equal((await f.service.availability(p, 'title')).remaining, 1);
  const other = { ...p, userId: 'other' }; await f.service.initializePreference(other, true);
  await f.service.polishTitle(other, 'different-title', input); assert.equal(f.calls.length, 2);
  await f.service.polishTitle(p, 'context-title', { ...input, context: 'bounded' }); assert.equal(f.calls.length, 3);
  assert.ok([...f.store.rows.keys()].every(k => !k.includes(input.title)));
  assert.ok(f.events.every(e => !JSON.stringify(e).includes(input.title)));
});
test('unchanged and context-needed statuses do not invent suggestions', async () => {
  for (const status of ['unchanged', 'needs_context']) {
    const f = await fixture({ provider: { identity: 'status', async polishTitle() { return { result: { status }, inputTokens: 1, outputTokens: 1 }; } } });
    assert.deepEqual(await f.service.polishTitle(p, 'title', input), { status });
  }
});
