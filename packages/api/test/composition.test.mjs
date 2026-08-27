import assert from "node:assert/strict";
import test from "node:test";
import { CellRoutingError, requireHomeCell, validateInstanceConfiguration } from "../dist/index.js";

test("validates local reference configuration and extension compatibility", () => {
  assert.doesNotThrow(() => validateInstanceConfiguration({
    instanceId: "local.reference",
    cell: { id: "local-cell", region: "local", operator: "test" },
    publicBaseUrl: "http://localhost:4000",
    extensions: [{ id: "example.operations", apiVersion: "1", contracts: ["operations"] }],
    requiredExtensions: { "example.operations": ["operations"] },
    localAdapter: { sqliteDatabasePath: "./var/ubeeq.sqlite", storageDirectory: "./var/objects" }
  }));
  assert.throws(() => validateInstanceConfiguration({ instanceId: "bad id", publicBaseUrl: "https://example.test", extensions: [], requiredExtensions: {} }), /Instance id/);
  assert.throws(() => validateInstanceConfiguration({ instanceId: "reference", publicBaseUrl: "http://example.test", extensions: [], requiredExtensions: {} }), /HTTPS/);
});

test("rejects writes routed to a foreign creator cell", () => {
  assert.doesNotThrow(() => requireHomeCell({ cellId: "cell-a" }, { homeCellId: "cell-a" }));
  assert.throws(() => requireHomeCell({ cellId: "cell-b" }, { homeCellId: "cell-a" }), CellRoutingError);
});
