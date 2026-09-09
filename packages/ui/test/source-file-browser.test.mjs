import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceFileBrowser } from '../dist/source-file-browser.js';
const dom = () => {
  const document = { createElement: () => ({ ownerDocument: document, children: [], events: {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, setAttribute() {}, addEventListener(name, fn) { this.events[name] = fn; } }) };
  return document.createElement();
};
const file = { creatorId: 'creator/one', fileId: 'file', sourceKind: 'document', mimeType: 'application/pdf', storageKey: 'https://private.invalid/key', originalFilename: '<img src=x onerror=alert(1)>' };
test('registration snapshots creator-bound metadata and requires inspection after uncertain writes', async () => {
  const panel = dom(), calls = []; let fail = false, actor = 'actor';
  const browser = createSourceFileBrowser({ client: { call: async (...args) => { calls.push(args); if (fail) throw Error('lost reply'); return { items: [] }; } },
    panel, getCreator: () => 'creator/one', getActor: () => actor });
  const [first, , status, , form] = panel.children;
  const inputs = form.children.slice(0, 5).map(label => label.children[0]);
  const fill = () => ['document', 'application/pdf', 'private/source', 'source.pdf', '42'].forEach((value, i) => { inputs[i].value = value; });
  const submit = () => form.events.submit({ preventDefault() {} });
  fill(); await submit();
  assert.deepEqual(calls[0], ['/studio/creators/creator%2Fone/files', 'POST', { sourceKind: 'document', mimeType: 'application/pdf', storageKey: 'private/source', originalFilename: 'source.pdf', sizeBytes: 42 }]);
  assert.match(status.textContent, /No object was uploaded/); assert.ok(inputs.every(input => input.value === ''));
  fill(); fail = true; await submit(); const count = calls.length; await submit(); assert.equal(calls.length, count);
  assert.match(status.textContent, /may already have succeeded/);
  fail = false; await first.events.click(); assert.equal(form.children.at(-1).disabled, false);
  actor = undefined; browser.sync(); await submit(); assert.equal(calls.length, count + 1); assert.ok(inputs.every(input => input.value === ''));
});
test('file catalogue renders inert metadata and follows bounded pages without fetching object keys', async () => {
  const panel = dom(), calls = [];
  const client = { call: async path => { calls.push(path); return calls.length === 1 ? { items: [file], nextCursor: 'opaque/cursor' } : { items: [] }; } };
  createSourceFileBrowser({ client, panel, getCreator: () => 'creator/one', getActor: () => 'actor' });
  const [first, next, status, list] = panel.children;
  await first.events.click(); assert.equal(list.children.length, 1);
  assert.match(list.children[0].textContent, /<img/); assert.equal(list.children[0].children.length, 0);
  assert.doesNotMatch(list.children[0].textContent, /private.invalid/);
  await next.events.click(); assert.equal(list.children.length, 0); assert.equal(next.disabled, true);
  assert.deepEqual(calls, ['/studio/creators/creator%2Fone/files?limit=50', '/studio/creators/creator%2Fone/files?limit=50&cursor=opaque%2Fcursor']);
  assert.match(status.textContent, /No file records/);
});
test('file catalogue clears on identity change and rejects stale and foreign pages', async () => {
  const panel = dom(); let creator = 'creator/one', actor = 'actor', resolve, result, calls = 0;
  const browser = createSourceFileBrowser({ client: { call: async () => { calls++; return result; } }, panel, getCreator: () => creator, getActor: () => actor });
  const [first, next, status, list] = panel.children;
  result = new Promise(done => { resolve = done; }); const pending = first.events.click();
  creator = 'other'; browser.sync(); resolve({ items: [file] }); await pending;
  assert.equal(list.children.length, 0);
  result = { items: [file] }; await first.events.click(); assert.match(status.textContent, /Invalid source-file/);
  result = { items: [{ ...file, creatorId: 'other' }] }; await first.events.click(); assert.equal(list.children.length, 1);
  actor = undefined; browser.sync(); assert.equal(list.children.length, 0); assert.equal(next.disabled, true);
  const before = calls; await first.events.click(); assert.equal(calls, before);
});
