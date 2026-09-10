import sharp from 'sharp';
import type { CoverCropInput } from '@ubeeq/processing';
import { validateCoordinateSpace, type ImageCoordinateSpace } from './coordinate-space.js';
export type { ImageCoordinateSpace } from './coordinate-space.js';

export interface ImageRenditionOptions {
  width: number; height: number;
  crop?: CoverCropInput;
  /** Default raw preserves legacy crops. Oriented applies EXIF before cropping/resizing. */
  coordinateSpace?: ImageCoordinateSpace;
  fit?: 'inside' | 'cover';
  withoutEnlargement?: boolean;
  quality?: number;
  /** False is an explicit legacy compatibility opt-out, not a safe default. */
  maxInputPixels?: number | false;
}

/** Crop coordinates default to raw pixels. Oriented mode is an explicit opt-in;
 * storage, publication and permission decisions remain outside this renderer. */
export const renderImageRendition = async (source: Uint8Array, options: ImageRenditionOptions): Promise<Uint8Array> => {
  validateCoordinateSpace(options.coordinateSpace);
  const limit = options.maxInputPixels ?? 40_000_000, quality = options.quality ?? 82;
  if (![options.width, options.height].every(value => Number.isSafeInteger(value) && value > 0) ||
    (limit !== false && (!Number.isSafeInteger(limit) || limit < 1))) throw new Error('Invalid rendition dimensions or pixel budget.');
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('Invalid JPEG quality.');
  let pipeline = sharp(source, { limitInputPixels: limit });
  if (options.coordinateSpace === 'oriented') pipeline = pipeline.autoOrient();
  if (options.crop) {
    const { x, y, width, height } = options.crop;
    if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1) throw new Error('Invalid rendition crop.');
    pipeline = pipeline.extract({ left: x, top: y, width, height });
  }
  return pipeline.resize(options.width, options.height, { fit: options.fit ?? 'cover', withoutEnlargement: options.withoutEnlargement ?? false })
    .jpeg({ quality, mozjpeg: true }).toBuffer();
};
