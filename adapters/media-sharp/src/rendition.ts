import sharp from 'sharp';
import type { CoverCropInput } from '@ubeeq/processing';

export interface ImageRenditionOptions {
  width: number; height: number;
  crop?: CoverCropInput;
  fit?: 'inside' | 'cover';
  withoutEnlargement?: boolean;
  quality?: number;
  /** False is an explicit legacy compatibility opt-out, not a safe default. */
  maxInputPixels?: number | false;
}

/** Crop coordinates refer to decoded pixels before EXIF orientation. No rotation,
 * storage, publication or permission decisions are performed by this renderer. */
export const renderImageRendition = async (source: Uint8Array, options: ImageRenditionOptions): Promise<Uint8Array> => {
  const limit = options.maxInputPixels ?? 40_000_000, quality = options.quality ?? 82;
  if (![options.width, options.height].every(value => Number.isSafeInteger(value) && value > 0) ||
    (limit !== false && (!Number.isSafeInteger(limit) || limit < 1))) throw new Error('Invalid rendition dimensions or pixel budget.');
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('Invalid JPEG quality.');
  let pipeline = sharp(source, { limitInputPixels: limit });
  if (options.crop) {
    const { x, y, width, height } = options.crop;
    if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1) throw new Error('Invalid rendition crop.');
    pipeline = pipeline.extract({ left: x, top: y, width, height });
  }
  return pipeline.resize(options.width, options.height, { fit: options.fit ?? 'cover', withoutEnlargement: options.withoutEnlargement ?? false })
    .jpeg({ quality, mozjpeg: true }).toBuffer();
};
