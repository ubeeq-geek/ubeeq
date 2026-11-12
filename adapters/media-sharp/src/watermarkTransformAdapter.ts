import sharp from "sharp";
import {
  type WatermarkAndTransformPort,
  type DerivativeTransformInput,
  type DerivativeTransformOutput,
  type TextWatermarkSpec,
  FeatureDisabledInSingleOperatorModeError,
} from "@ubeeq/extension-sdk";

export class SharpWatermarkAndTransformAdapter implements WatermarkAndTransformPort {
  readonly supportsGraphicWatermark = false as const;
  readonly supportsImageAdjustments = false as const;

  async applyDerivativeTransform(
    input: DerivativeTransformInput,
  ): Promise<DerivativeTransformOutput> {
    // 1. Strictly reject unsupported graphic watermarking in single-operator mode
    if (input.graphicWatermark || input.graphicWatermarkAssetId) {
      throw new FeatureDisabledInSingleOperatorModeError("Custom graphic watermarking");
    }

    // 2. Strictly reject unsupported pro image adjustments in single-operator mode
    if (
      input.adjustments &&
      (input.adjustments.brightness !== undefined ||
        input.adjustments.contrast !== undefined ||
        input.adjustments.autoLuminance)
    ) {
      throw new FeatureDisabledInSingleOperatorModeError("Pro image adjustments");
    }

    // 3. If text watermark requested, composite using Sharp SVG overlay
    if (input.textWatermark?.text) {
      return this.renderTextWatermark(
        input.sourceBytes,
        input.mimeType,
        input.textWatermark,
      );
    }

    // 4. Default pass-through
    return { bytes: input.sourceBytes, mimeType: input.mimeType };
  }

  private async renderTextWatermark(
    sourceBytes: Uint8Array,
    mimeType: string,
    spec: TextWatermarkSpec,
  ): Promise<DerivativeTransformOutput> {
    const image = sharp(sourceBytes);
    const metadata = await image.metadata();
    const width = metadata.width ?? 1200;
    const height = metadata.height ?? 800;

    const text = escapeXml(spec.text.slice(0, 100));
    const opacity = Math.min(1, Math.max(0.05, spec.opacity ?? 0.7));
    const fontSize = Math.max(16, Math.round(width * 0.035));
    const strokeWidth = Math.max(1, Math.round(fontSize * 0.06));
    const margin = Math.round(Math.min(width, height) * 0.04);

    let svgInner = "";
    if (spec.position === "tiled") {
      const stepX = Math.round(width / 3);
      const stepY = Math.round(height / 3);
      const rows: string[] = [];
      for (let y = Math.round(stepY / 2); y < height; y += stepY) {
        for (let x = Math.round(stepX / 2); x < width; x += stepX) {
          rows.push(
            `<text x="${x}" y="${y}" transform="rotate(-30 ${x} ${y})" text-anchor="middle" class="wm-text">${text}</text>`,
          );
        }
      }
      svgInner = rows.join("\n");
    } else {
      let x = width - margin;
      let y = height - margin;
      let textAnchor = "end";

      switch (spec.position) {
        case "bottom-left":
          x = margin;
          y = height - margin;
          textAnchor = "start";
          break;
        case "top-right":
          x = width - margin;
          y = margin + fontSize;
          textAnchor = "end";
          break;
        case "top-left":
          x = margin;
          y = margin + fontSize;
          textAnchor = "start";
          break;
        case "center":
          x = Math.round(width / 2);
          y = Math.round(height / 2);
          textAnchor = "middle";
          break;
        case "bottom-right":
        default:
          x = width - margin;
          y = height - margin;
          textAnchor = "end";
          break;
      }
      svgInner = `<text x="${x}" y="${y}" text-anchor="${textAnchor}" class="wm-text">${text}</text>`;
    }

    const svgOverlay = Buffer.from(`
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <style>
          .wm-text {
            font-family: system-ui, -apple-system, sans-serif;
            font-size: ${fontSize}px;
            font-weight: 600;
            fill: rgba(255, 255, 255, ${opacity});
            stroke: rgba(0, 0, 0, ${opacity * 0.75});
            stroke-width: ${strokeWidth}px;
            paint-order: stroke fill;
          }
        </style>
        ${svgInner}
      </svg>
    `);

    const pipeline = image.composite([{ input: svgOverlay, top: 0, left: 0 }]);
    const format = (metadata.format ?? "jpeg").toLowerCase();

    let outputBuffer: Buffer;
    if (format === "png" || mimeType === "image/png") {
      outputBuffer = await pipeline.png().toBuffer();
    } else if (format === "webp" || mimeType === "image/webp") {
      outputBuffer = await pipeline.webp().toBuffer();
    } else {
      outputBuffer = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    }

    return {
      bytes: new Uint8Array(outputBuffer),
      mimeType: mimeType || "image/jpeg",
    };
  }
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const createSharpWatermarkAdapter = (): WatermarkAndTransformPort =>
  new SharpWatermarkAndTransformAdapter();

// Alias for drop-in compatibility with commercial adapter interface
export { SharpWatermarkAndTransformAdapter as CommercialWatermarkAndTransformAdapter };
