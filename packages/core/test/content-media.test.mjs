import assert from "node:assert/strict";
import test from "node:test";
import { parseContentMediaReferences, parseStoredPostMediaReferences } from "../dist/index.js";

test("media references normalize credits, comparison items and order in both formats", () => {
  const input = [{ mediaId: " original ", sortOrder: -2, caption: " Caption ", credit: { label: " Artist ", url: " https://example.test " },
    comparison: { type: " before-after ", order: 2.9, comparisonItem: { mediaId: " after ", role: " after ", caption: " After ", credit: { label: " Editor " } } } }];
  const [native] = parseContentMediaReferences(input);
  assert.equal(native.assetId, "original");
  assert.equal(native.position, 0);
  assert.equal(native.caption, " Caption ");
  assert.equal(native.credit.label, "Artist");
  assert.equal(native.comparison.item.assetId, "after");
  assert.equal(native.comparison.order, 2);
  assert.equal(native.comparison.item.caption, "After");
  const [stored] = parseStoredPostMediaReferences(input, { defaultDiscoverable: true });
  assert.equal(stored.mediaId, "original");
  assert.equal(stored.sortOrder, 0);
  assert.equal(stored.comparison.comparisonItem.mediaId, "after");
  assert.deepEqual(parseContentMediaReferences([native]), [native]);
});
test("discovery defaults are selected explicitly by the consuming product", () => {
  const input = [{ assetId: "one" }, { assetId: "two", discoverable: false }];
  assert.deepEqual(parseContentMediaReferences(input).map((item) => item.discoverable), [false, false]);
  assert.deepEqual(parseContentMediaReferences(input, { defaultDiscoverable: true }).map((item) => item.discoverable), [true, false]);
});
test("invalid references and incomplete comparisons are omitted while field limits remain bounded", () => {
  const input = [null, [], {}, { mediaId: " " }, { mediaId: "one", caption: "c".repeat(2100), credit: { label: " " }, comparison: { type: "pair", comparisonItem: {} } }];
  const result = parseContentMediaReferences(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].caption.length, 2000);
  assert.equal(result[0].credit, undefined);
  assert.equal(result[0].comparison, undefined);
});
