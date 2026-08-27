import assert from "node:assert/strict";
import test from "node:test";
import { ForeignCellJobError, requireLocalJob } from "../dist/index.js";

test("workers reject jobs belonging to another cell", () => {
  assert.doesNotThrow(() => requireLocalJob({ cellId: "cell-a" }, "cell-a"));
  assert.throws(() => requireLocalJob({ cellId: "cell-b" }, "cell-a"), ForeignCellJobError);
});
