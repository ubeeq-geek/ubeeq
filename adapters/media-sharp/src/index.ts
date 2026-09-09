import sharp from "sharp";
export * from './rendition.js';
export * from './rendition-set.js';
import type { MediaProcessor } from "@ubeeq/processing";

export interface ImagePreviewOptions {
  width: number;
  height: number;
  fit?: "inside" | "cover";
  attentionCrop?: boolean;
  withoutEnlargement?: boolean;
  quality?: number;
  maxInputPixels?: number;
}

/** Decodes the source and creates JPEG bytes; product composition chooses the recipe. */
export const createImagePreview = async (source: Uint8Array, options: ImagePreviewOptions): Promise<Uint8Array> => {
  const maxInputPixels = options.maxInputPixels ?? 40_000_000;
  if (![options.width, options.height, maxInputPixels].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("Preview dimensions and pixel budget must be positive integers.");
  const quality = options.quality ?? 82;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("JPEG quality must be between 1 and 100.");
  return sharp(source, { limitInputPixels: maxInputPixels, failOn: "error" })
    .rotate().resize(options.width, options.height, { fit: options.fit ?? "inside",
      position: options.attentionCrop ? "attention" : "centre", withoutEnlargement: options.withoutEnlargement ?? true })
    .jpeg({ quality, mozjpeg: true }).toBuffer();
};

/** Optional decoded-image processor with immutable source lineage and transient preview bytes. */
export class SharpImageProcessor implements MediaProcessor {
  constructor(private readonly options: ImagePreviewOptions = { width: 320, height: 320 }) {}
  async process(input: Parameters<MediaProcessor['process']>[0]) {
    if (!input.contentType.startsWith("image/") || !input.sourceVersionId) throw new Error("Image processing requires an image type and source version.");
    const preview = await createImagePreview(input.source, this.options);
    const source = await sharp(input.source, { limitInputPixels: this.options.maxInputPixels ?? 40_000_000 }).metadata();
    const output = await sharp(preview).metadata();
    return {
      metadata: { contentType: input.contentType, byteLength: input.source.byteLength, width: source.width!, height: source.height!,
        decodedFormat: source.format!, previewWidth: output.width!, previewHeight: output.height! },
      renditions: [{ id: `preview:${input.assetId}:${input.sourceVersionId}`, sourceVersionId: input.sourceVersionId,
        contentType: "image/jpeg", byteLength: preview.byteLength, role: "preview" as const, body: preview }],
      measuredUnits: 1
    };
  }
}

export interface ImageSourceValidationOptions { maxInputBytes?: number; maxInputPixels?: number }
export type ImageSourceValidation = { safe: true; decodedFormat: string } |
  { safe: false; reason: 'unsupported_mime' | 'invalid_source_size' | 'invalid_image' | 'mime_mismatch' };

/** Bounded image decode/type validation, not malware, rights or content moderation.
 * Uses the preview decoder's default page/frame; does not inspect every animation frame. */
export const validateImageSource = async (source: Uint8Array, mimeType: string, options: ImageSourceValidationOptions = {}): Promise<ImageSourceValidation> => {
  const maxInputBytes = options.maxInputBytes ?? 50 * 1024 * 1024, maxInputPixels = options.maxInputPixels ?? 40_000_000;
  if (![maxInputBytes, maxInputPixels].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Image validation budgets must be positive integers.');
  const formats: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/tiff': 'tiff' };
  const expected = formats[mimeType.toLowerCase()];
  if (!expected) return { safe: false, reason: 'unsupported_mime' };
  if (!source.byteLength || source.byteLength > maxInputBytes) return { safe: false, reason: 'invalid_source_size' };
  try {
    const result = await new SharpImageProcessor({ width: 1, height: 1, maxInputPixels }).process({
      source, contentType: mimeType.toLowerCase(), assetId: 'validation', sourceVersionId: 'validation'
    });
    if (result.metadata.decodedFormat !== expected) return { safe: false, reason: 'mime_mismatch' };
    return { safe: true, decodedFormat: result.metadata.decodedFormat };
  } catch { return { safe: false, reason: 'invalid_image' }; }
};
