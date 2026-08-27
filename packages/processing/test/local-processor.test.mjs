import assert from "node:assert/strict";
import test from "node:test";
import { LocalImageProcessor } from "../dist/index.js";

test("local image processor records PNG dimensions and source lineage", async () => {
  const png = new Uint8Array(24); png.set([137,80,78,71,13,10,26,10]); new DataView(png.buffer).setUint32(16, 640); new DataView(png.buffer).setUint32(20, 480);
  const result = await new LocalImageProcessor().process({ assetId: "asset", contentType: "image/png", source: png, sourceVersionId: "v1" });
  assert.deepEqual(result.metadata, { contentType: "image/png", byteLength: 24, width: 640, height: 480 });
  assert.deepEqual(result.renditions, [{ id: "source:v1", contentType: "image/png", byteLength: 24, role: "source" }]);
});
