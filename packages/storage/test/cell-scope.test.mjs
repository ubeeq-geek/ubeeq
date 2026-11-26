import assert from "node:assert/strict";
import test from "node:test";
import { cellScopedObjectKey, requireCellScopedObject, requireCreatorScopedObject } from "../dist/index.js";

test("builds and validates canonical cell-scoped object keys", () => {
  const key = cellScopedObjectKey({ cellId: "eu-cell", creatorId: "creator-1", kind: "originals", objectId: "asset-1" });
  assert.equal(key, "cells/eu-cell/creators/creator-1/originals/asset-1");
  assert.doesNotThrow(() => requireCellScopedObject(key, "eu-cell"));
  assert.doesNotThrow(() => requireCreatorScopedObject(key, { cellId: "eu-cell", creatorId: "creator-1" }));
  assert.throws(() => requireCreatorScopedObject(key, { cellId: "eu-cell", creatorId: "creator-2" }), /not scoped/);
  assert.throws(() => requireCellScopedObject(key, "us-cell"), /not scoped/);
  assert.throws(() => cellScopedObjectKey({ cellId: "../escape", creatorId: "creator-1", kind: "uploads", objectId: "asset-1" }), /Invalid cellId/);
});

test('storage scope guards reject noncanonical keys before a provider normalizes their paths', () => {
  const prefix = 'cells/cell/creators/creator/';
  for (const suffix of ['uploads/../../other/file','uploads/./file','uploads//file','uploads/%2e%2e/file','uploads/..\\file','uploads/file\0']) {
    assert.throws(() => requireCreatorScopedObject(prefix + suffix,{cellId:'cell',creatorId:'creator'}), /not scoped/);
    assert.throws(() => requireCellScopedObject(prefix + suffix,'cell'), /not scoped/);
  }
  assert.doesNotThrow(() => requireCreatorScopedObject(prefix + 'uploads/photo..png',{cellId:'cell',creatorId:'creator'}));
});
