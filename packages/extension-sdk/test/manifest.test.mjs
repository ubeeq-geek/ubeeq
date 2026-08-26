import assert from "node:assert/strict";
import test from "node:test";
import { EXTENSION_CONTRACTS, validateExtensionManifest } from "../dist/index.js";

test("exposes the supported extension contract vocabulary", () => {
  assert.deepEqual(EXTENSION_CONTRACTS, [
    "brand", "moderation-policy", "billing-provider", "discovery",
    "integration-provider", "federation-policy", "operations"
  ]);
});

test("accepts a compatible manifest", () => {
  assert.doesNotThrow(() => validateExtensionManifest(
    { id: "example.hosted", apiVersion: "1", contracts: ["brand", "operations"] },
    ["brand"]
  ));
});

test("rejects an incompatible or incomplete manifest", () => {
  assert.throws(() => validateExtensionManifest(
    { id: "example.hosted", apiVersion: "2", contracts: ["brand"] },
    ["brand"]
  ));
  assert.throws(() => validateExtensionManifest(
    { id: "example.hosted", apiVersion: "1", contracts: ["brand", "brand"] },
    ["brand"]
  ));
  assert.throws(() => validateExtensionManifest(
    { id: "example.hosted", apiVersion: "1", contracts: ["brand"] },
    ["operations"]
  ));
});
