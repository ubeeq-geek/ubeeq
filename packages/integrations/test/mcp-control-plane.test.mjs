import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeMcpControlTool,
  previewWorkFlowPolicyMutation,
  validateMcpMutationEnvelope,
  validateWorkFlowPolicy
} from "../dist/mcp-control-plane.js";

test("MCP tools enforce scoped permissions", () => {
  const reader = { subjectId: "assistant-a", permissions: ["flows.read"] };
  assert.doesNotThrow(() => authorizeMcpControlTool(reader, "works.flow.preview"));
  assert.throws(() => authorizeMcpControlTool(reader, "works.flow.apply"), /flows.write/);
});

test("flow policy supports one upstream and many downstreams per field", () => {
  const policy = validateWorkFlowPolicy({
    workId: "work-1",
    revision: 2,
    fields: [{
      field: "title",
      upstream: { endpoint: "integration:youtube", mode: "automatic" },
      downstream: [
        { endpoint: "integration:vimeo", mode: "automatic" },
        { endpoint: "integration:tumblr", mode: "manual" }
      ]
    }]
  });
  assert.equal(policy.fields[0].upstream.endpoint, "integration:youtube");
  assert.equal(policy.fields[0].downstream.length, 2);
});

test("flow policy rejects loops and duplicate destinations", () => {
  assert.throws(() => validateWorkFlowPolicy({
    workId: "work-1",
    revision: 0,
    fields: [{
      field: "title",
      upstream: { endpoint: "integration:youtube", mode: "automatic" },
      downstream: [{ endpoint: "integration:youtube", mode: "automatic" }]
    }]
  }), /both upstream and downstream/);

  assert.throws(() => validateWorkFlowPolicy({
    workId: "work-1",
    revision: 0,
    fields: [{
      field: "tags",
      downstream: [
        { endpoint: "integration:vimeo", mode: "automatic" },
        { endpoint: "integration:vimeo", mode: "manual" }
      ]
    }]
  }), /Duplicate downstream endpoint/);
});

test("preview produces a deterministic next revision without mutating current policy", () => {
  const current = {
    workId: "work-1",
    revision: 4,
    fields: [{ field: "title", downstream: [] }]
  };
  const preview = previewWorkFlowPolicyMutation(current, [
    { type: "set_upstream", field: "title", endpoint: "integration:youtube" },
    { type: "set_downstream", field: "title", endpoint: "integration:vimeo", mode: "automatic" },
    { type: "set_downstream", field: "tags", endpoint: "integration:youtube", mode: "automatic" },
    { type: "set_downstream", field: "tags", endpoint: "integration:vimeo", mode: "automatic" }
  ]);

  assert.equal(preview.currentRevision, 4);
  assert.equal(preview.next.revision, 5);
  assert.deepEqual(preview.changedFields, ["tags", "title"]);
  assert.equal(current.revision, 4);
  assert.equal(current.fields[0].downstream.length, 0);
});

test("mutation envelopes require subject, idempotency and optimistic concurrency", () => {
  const valid = validateMcpMutationEnvelope({
    principal: { subjectId: "assistant-a", permissions: ["flows.write"] },
    idempotencyKey: "change-123",
    expectedRevision: 8,
    input: { workId: "work-1", mutations: [] }
  });
  assert.equal(valid.expectedRevision, 8);
  assert.throws(() => validateMcpMutationEnvelope({ ...valid, idempotencyKey: " " }), /idempotency key/);
});
