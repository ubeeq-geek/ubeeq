import assert from "node:assert/strict";
import test from "node:test";
import { inspectContentCredentials } from "../dist/index.js";

const bytes = (text) => new TextEncoder().encode(text);
test("credential marker inspection never authenticates or assigns provenance", () => {
  for (const input of ["c2pa.created", "c2pa.edited", "JUMBF", "Content Credentials"]) {
    const result = inspectContentCredentials(bytes(input), "now");
    assert.equal(result.present, true);
    assert.equal(result.verification, "not_performed");
    assert.equal(result.inspectedAt, "now");
    assert.equal(result.candidateAssertion, undefined);
    assert.equal(result.provenance, undefined);
  }
});
test("explicit AI markers remain untrusted candidates rather than provenance assertions", () => {
  for (const [input, candidate] of [["c2pa trainedAlgorithmicMedia", "ai-generated"], ["c2pa AI-assisted", "ai-assisted"]]) {
    const result = inspectContentCredentials(bytes(input));
    assert.equal(result.candidateAssertion, candidate);
    assert.equal(result.verification, "not_performed");
    assert.equal(result.provenance, undefined);
  }
  assert.equal(inspectContentCredentials(bytes("AI-generated")).present, false);
});
test("inspection respects the byte view and reports its fixed scan limit", () => {
  const input = bytes("c2pa trainedAlgorithmicMedia");
  assert.equal(inspectContentCredentials(input.subarray(5)).present, false);
  const long = new Uint8Array(2 * 1024 * 1024 + input.length);
  long.set(input, 2 * 1024 * 1024);
  const result = inspectContentCredentials(long);
  assert.equal(result.present, false);
  assert.equal(result.truncated, true);
  assert.equal(result.inspectedBytes, 2 * 1024 * 1024);
  assert.equal(inspectContentCredentials(new Uint8Array()).truncated, false);
});
