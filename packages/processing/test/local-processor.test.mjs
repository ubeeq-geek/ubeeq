import assert from "node:assert/strict";
import test from "node:test";
import { LocalImageProcessor, MediaProcessorRegistry } from "../dist/index.js";

test("local image processor records PNG dimensions and source lineage", async () => {
  const png = new Uint8Array(24); png.set([137,80,78,71,13,10,26,10]); new DataView(png.buffer).setUint32(16, 640); new DataView(png.buffer).setUint32(20, 480);
  const result = await new LocalImageProcessor().process({ assetId: "asset", contentType: "image/png", source: png, sourceVersionId: "v1" });
  assert.deepEqual(result.metadata, { contentType: "image/png", byteLength: 24, width: 640, height: 480 });
  assert.deepEqual(result.renditions, [{ id: "source:v1", sourceVersionId: "v1", contentType: "image/png", byteLength: 24, role: "source" }]);
});

test("processor registry selects a pluggable processor by content type", async () => {
  const fallback = new LocalImageProcessor();
  const registry = new MediaProcessorRegistry([{ supports: ({ contentType }) => contentType === "image/custom", processor: { process: async (input) => ({ metadata: { custom: true }, renditions: [{ id: "preview", sourceVersionId: input.sourceVersionId, contentType: input.contentType, byteLength: 1, role: "preview" }], measuredUnits: 2 }) } }], fallback);
  const result = await registry.process({ assetId: "asset", contentType: "image/custom", source: new Uint8Array([1]), sourceVersionId: "source-v1" });
  assert.equal(result.metadata.custom, true); assert.equal(result.renditions[0].sourceVersionId, "source-v1");
});
