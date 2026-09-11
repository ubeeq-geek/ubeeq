import assert from "node:assert/strict";
import test from "node:test";
import { parseContentBlocks, parseStoredPostBlocks, toStoredPostBlocks, validateContentBlocks } from "../dist/index.js";

test('structural budgets reject deep blocks, metadata, broad input and cycles before parsing', () => {
  let deep = [{ type: 'paragraph', text: 'leaf' }];
  for (let i = 0; i < 10000; i++) deep = [{ type: 'section', children: deep }];
  assert.throws(() => parseContentBlocks(deep, { unbounded: true }), { code: 'invalid_content_structure' });
  let payload = {};
  for (let i = 0; i < 10000; i++) payload = { nested: payload };
  assert.throws(() => parseStoredPostBlocks([{ type: 'section', payload }]), { code: 'invalid_content_structure' });
  assert.throws(() => parseContentBlocks(Array(10001).fill(null)), { code: 'invalid_content_structure' });
  const cyclic = { type: 'section' }; cyclic.children = [cyclic];
  assert.throws(() => parseContentBlocks([cyclic]), { code: 'invalid_content_structure' });
});

test('exact budgets preserve long text and repeated non-cyclic metadata', () => {
  const input = [{ type: 'paragraph', text: 'a'.repeat(100000) }];
  assert.equal(parseContentBlocks(input, { unbounded: true, maxDepth: 2, maxNodes: 4 })[0].text.length, 100000);
  assert.throws(() => parseContentBlocks(input, { maxDepth: 1 }), { code: 'invalid_content_structure' });
  assert.throws(() => parseContentBlocks(input, { maxNodes: 3 }), { code: 'invalid_content_structure' });
  const data = { label: 'shared' };
  assert.equal(parseContentBlocks([{ type: 'section', data }, { type: 'section', data }]).length, 2);
  for (const maxDepth of [0, 129, Infinity, 1.5]) assert.throws(() => parseContentBlocks([], { maxDepth }), { code: 'invalid_content_structure' });
  for (const maxNodes of [0, Infinity, 1.5]) assert.throws(() => parseContentBlocks([], { maxNodes }), { code: 'invalid_content_structure' });
});

test("legacy and portable editor trees share normalization without losing media or file references", () => {
  const legacy = [{ blockId: "section", type: "section", payload: { status: "draft", custom: true }, blocks: [
    { blockId: "paragraph", type: "paragraph", text: "Body" },
    { blockId: "file", type: "file", mediaId: "asset", fileId: "file-ref" }
  ] }];
  const portable = parseContentBlocks(legacy);
  assert.deepEqual(portable[0].data, legacy[0].payload);
  assert.equal(portable[0].children[1].assetId, "asset");
  assert.equal(portable[0].children[1].fileId, "file-ref");
  assert.deepEqual(parseContentBlocks(portable), portable);
  assert.deepEqual(toStoredPostBlocks(portable), legacy);
  assert.deepEqual(parseStoredPostBlocks(legacy), legacy);
});
test("editor normalization retains bounded post limits and unbounded Work text", () => {
  const input = [{ type: "heading", level: 99, text: "a".repeat(21000), quote: "q".repeat(5000), html: "h".repeat(51000), title: "t".repeat(400) }, null, { type: "unsupported" }];
  const [bounded] = parseContentBlocks(input);
  assert.equal(bounded.level, 6);
  assert.equal(bounded.text.length, 20000);
  assert.equal(bounded.quote.length, 4000);
  assert.equal(bounded.html.length, 50000);
  const [unbounded] = parseContentBlocks(input, { unbounded: true });
  assert.equal(unbounded.text.length, 21000);
  assert.equal(unbounded.quote.length, 5000);
  assert.equal(unbounded.html.length, 51000);
  assert.equal(unbounded.title.length, 300);
  assert.equal(parseContentBlocks(input).length, 1);
  assert.deepEqual(parseContentBlocks({}), []);
});
test("generated nested IDs are stable and distinct across sections", () => {
  const input = [{ type: "section", blocks: [{ type: "paragraph", text: "One" }] }, { type: "section", blocks: [{ type: "paragraph", text: "Two" }] }];
  const blocks = parseContentBlocks(input);
  assert.doesNotThrow(() => validateContentBlocks(blocks));
  assert.equal(blocks[0].children[0].id, "section-1/paragraph-1");
  assert.equal(blocks[1].children[0].id, "section-2/paragraph-1");
  assert.deepEqual(parseContentBlocks(input), blocks);
});

test('empty section arrays round-trip and nested metadata never aliases either source format', () => {
  const legacy = [{ blockId: 'section', type: 'section', title: 'Empty section', blocks: [], payload: { nested: { list: ['original'] } } }];
  const portable = parseContentBlocks(legacy);
  assert.deepEqual(portable[0].children, []);
  assert.deepEqual(toStoredPostBlocks(portable), legacy);
  portable[0].data.nested.list.push('portable change');
  assert.deepEqual(legacy[0].payload.nested.list, ['original']);
  const stored = toStoredPostBlocks(portable);
  stored[0].payload.nested.list.push('stored change');
  assert.deepEqual(portable[0].data.nested.list, ['original', 'portable change']);
  const reparsed = parseContentBlocks(portable);
  reparsed[0].data.nested.list.push('reparsed change');
  assert.deepEqual(portable[0].data.nested.list, ['original', 'portable change']);
  assert.equal(parseContentBlocks([{ id: 'paragraph', type: 'paragraph' }])[0].children, undefined);
});
