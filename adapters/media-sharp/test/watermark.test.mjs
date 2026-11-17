import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  SharpWatermarkAndTransformAdapter,
  createSharpWatermarkAdapter,
  CommercialWatermarkAndTransformAdapter,
} from "../dist/index.js";
import { FeatureDisabledInSingleOperatorModeError } from "@ubeeq/extension-sdk";

const createPngSource = async (width = 400, height = 300) => {
  return sharp({
    create: { width, height, channels: 3, background: "#336699" },
  })
    .png()
    .toBuffer();
};

const createJpegSource = async (width = 400, height = 300) => {
  return sharp({
    create: { width, height, channels: 3, background: "#336699" },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
};

test("Sharp watermark adapter contract capabilities", () => {
  const adapter = createSharpWatermarkAdapter();
  assert.equal(adapter.supportsGraphicWatermark, false);
  assert.equal(adapter.supportsImageAdjustments, false);
  assert.ok(adapter instanceof SharpWatermarkAndTransformAdapter);
  assert.ok(adapter instanceof CommercialWatermarkAndTransformAdapter);
});

test("Pass-through when no watermark or transform is specified", async () => {
  const adapter = createSharpWatermarkAdapter();
  const sourceBytes = await createJpegSource(100, 100);
  const result = await adapter.applyDerivativeTransform({
    sourceBytes,
    mimeType: "image/jpeg",
    creatorId: "creator-test",
  });
  assert.equal(result.bytes, sourceBytes);
  assert.equal(result.mimeType, "image/jpeg");
});

test("Text watermarking composites SVG overlay onto image bytes across positions", async () => {
  const adapter = createSharpWatermarkAdapter();
  const sourceBytes = await createJpegSource(400, 300);

  const positions = [
    "bottom-right",
    "bottom-left",
    "top-right",
    "top-left",
    "center",
    "tiled",
  ];

  for (const position of positions) {
    const result = await adapter.applyDerivativeTransform({
      sourceBytes,
      mimeType: "image/jpeg",
      creatorId: "creator-test",
      textWatermark: {
        text: "© Sample Creator",
        opacity: 0.6,
        position,
      },
    });

    assert.equal(result.mimeType, "image/jpeg");
    assert.ok(result.bytes.byteLength > 0);
    // Bytes should differ from the plain source due to the composite overlay
    assert.notDeepEqual(result.bytes, sourceBytes);

    const metadata = await sharp(result.bytes).metadata();
    assert.equal(metadata.format, "jpeg");
    assert.equal(metadata.width, 400);
    assert.equal(metadata.height, 300);
  }
});

test("Text watermarking preserves PNG format", async () => {
  const adapter = createSharpWatermarkAdapter();
  const sourceBytes = await createPngSource(200, 200);

  const result = await adapter.applyDerivativeTransform({
    sourceBytes,
    mimeType: "image/png",
    creatorId: "creator-test",
    textWatermark: {
      text: "Watermark Test",
      opacity: 0.5,
      position: "bottom-right",
    },
  });

  assert.equal(result.mimeType, "image/png");
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 200);
  assert.equal(metadata.height, 200);
});

test("Rejects graphic watermark with FeatureDisabledInSingleOperatorModeError (403)", async () => {
  const adapter = createSharpWatermarkAdapter();
  const sourceBytes = await createJpegSource(100, 100);

  await assert.rejects(
    adapter.applyDerivativeTransform({
      sourceBytes,
      mimeType: "image/jpeg",
      creatorId: "creator-test",
      graphicWatermark: {
        assetId: "graphic-logo-1",
        opacity: 0.8,
      },
    }),
    (err) => {
      assert.ok(err instanceof FeatureDisabledInSingleOperatorModeError);
      assert.equal(err.code, "FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE");
      assert.equal(err.statusCode, 403);
      assert.match(err.message, /Custom graphic watermarking/);
      return true;
    },
  );

  await assert.rejects(
    adapter.applyDerivativeTransform({
      sourceBytes,
      mimeType: "image/jpeg",
      creatorId: "creator-test",
      graphicWatermarkAssetId: "asset-123",
    }),
    (err) => {
      assert.ok(err instanceof FeatureDisabledInSingleOperatorModeError);
      assert.equal(err.code, "FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE");
      assert.equal(err.statusCode, 403);
      return true;
    },
  );
});

test("Rejects pro image adjustments with FeatureDisabledInSingleOperatorModeError (403)", async () => {
  const adapter = createSharpWatermarkAdapter();
  const sourceBytes = await createJpegSource(100, 100);

  // Brightness adjustment
  await assert.rejects(
    adapter.applyDerivativeTransform({
      sourceBytes,
      mimeType: "image/jpeg",
      creatorId: "creator-test",
      adjustments: { brightness: 1.2 },
    }),
    (err) => {
      assert.ok(err instanceof FeatureDisabledInSingleOperatorModeError);
      assert.equal(err.code, "FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE");
      assert.equal(err.statusCode, 403);
      assert.match(err.message, /Pro image adjustments/);
      return true;
    },
  );

  // Contrast adjustment
  await assert.rejects(
    adapter.applyDerivativeTransform({
      sourceBytes,
      mimeType: "image/jpeg",
      creatorId: "creator-test",
      adjustments: { contrast: 1.1 },
    }),
    (err) => {
      assert.ok(err instanceof FeatureDisabledInSingleOperatorModeError);
      assert.equal(err.statusCode, 403);
      return true;
    },
  );

  // Auto-luminance adjustment
  await assert.rejects(
    adapter.applyDerivativeTransform({
      sourceBytes,
      mimeType: "image/jpeg",
      creatorId: "creator-test",
      adjustments: { autoLuminance: true },
    }),
    (err) => {
      assert.ok(err instanceof FeatureDisabledInSingleOperatorModeError);
      assert.equal(err.statusCode, 403);
      return true;
    },
  );
});
