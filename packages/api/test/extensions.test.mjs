import assert from "node:assert/strict";
import test from "node:test";
import { loadProductExtensions } from "../dist/index.js";

test("loads a compatible, uniquely identified extension set", () => {
  const extensions = [{ id: "example.hosted", apiVersion: "1", contracts: ["brand", "operations"] }];
  const loaded = loadProductExtensions(extensions, { "example.hosted": ["brand", "operations"] });
  assert.equal(loaded.get("example.hosted"), extensions[0]);
});

test("rejects duplicate and missing extensions", () => {
  const extension = { id: "example.hosted", apiVersion: "1", contracts: ["brand"] };
  assert.throws(() => loadProductExtensions([extension, extension], {}), /unique ids/);
  assert.throws(() => loadProductExtensions([], { "example.hosted": ["brand"] }), /not installed/);
});
