import sharp from 'sharp';
import { pickCoverCrop, type CoverCropInput, type FocalPointInput } from '@ubeeq/processing';
import { renderImageRendition } from './rendition.js';

export interface CoverRenditionVariant<Name extends string = string> {
  name: Name; width: number; height: number; crop?: CoverCropInput;
}
export interface CoverRenditionSetOptions<Name extends string = string> {
  variants: readonly CoverRenditionVariant<Name>[];
  focalPoint?: FocalPointInput;
  maxSourceBytes?: number;
  maxInputPixels?: number;
  maxOutputPixels?: number;
  maxOutputBytes?: number;
}

/** Storage-free cover rendering. Product composition supplies sizes and names.
 * Coordinates precede EXIF orientation, as in renderImageRendition. */
export const renderCoverRenditions = async <Name extends string>(source: Uint8Array, options: CoverRenditionSetOptions<Name>) => {
  const snapshot = structuredClone(options);
  const maxSourceBytes = snapshot.maxSourceBytes ?? 50 * 1024 * 1024;
  const maxInputPixels = snapshot.maxInputPixels ?? 40_000_000;
  const maxOutputPixels = snapshot.maxOutputPixels ?? 40_000_000;
  const maxOutputBytes = snapshot.maxOutputBytes ?? 50 * 1024 * 1024;
  if (![maxSourceBytes, maxInputPixels, maxOutputPixels, maxOutputBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid cover rendition budgets.');
  if (!(source instanceof Uint8Array) || !source.byteLength || source.byteLength > maxSourceBytes) throw new Error('Cover source exceeds byte budget.');
  const variants = snapshot.variants;
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 16 || new Set(variants.map(v => v?.name)).size !== variants.length) throw new Error('Invalid cover rendition variants.');
  let pixels = 0;
  for (const variant of variants) {
    if (!variant || typeof variant.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(variant.name) ||
      ![variant.width, variant.height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid cover rendition variant.');
    pixels += variant.width * variant.height;
    if (!Number.isSafeInteger(pixels) || pixels > maxOutputPixels) throw new Error('Cover output exceeds pixel budget.');
  }
  const requestedFocalPoint = snapshot.focalPoint ?? { x: 0.5, y: 0.5 };
  if (![requestedFocalPoint.x, requestedFocalPoint.y].every(Number.isFinite)) throw new Error('Invalid cover focal point.');
  const focalPoint = { x: Math.max(0, Math.min(1, requestedFocalPoint.x)), y: Math.max(0, Math.min(1, requestedFocalPoint.y)) };
  const bytes = Uint8Array.from(source);
  const metadata = await sharp(bytes, { limitInputPixels: maxInputPixels, failOn: 'error' }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Invalid cover source dimensions.');
  const width = metadata.width, height = metadata.height;
  // Resolve every crop before rendering any variant, including overrides late in the set.
  const selections = variants.map(variant => ({ ...variant,
    crop: pickCoverCrop(width, height, variant.width, variant.height, focalPoint, variant.crop) }));
  const renditions: Array<{ name: Name; crop: CoverCropInput; body: Uint8Array; contentType: 'image/jpeg'; byteLength: number }> = [];
  let outputBytes = 0;
  for (const variant of selections) {
    const body = await renderImageRendition(bytes, { width: variant.width, height: variant.height, crop: variant.crop, maxInputPixels });
    outputBytes += body.byteLength;
    if (outputBytes > maxOutputBytes) throw new Error('Cover output exceeds byte budget.');
    renditions.push({ name: variant.name, crop: variant.crop, body, contentType: 'image/jpeg', byteLength: body.byteLength });
  }
  return { sourceWidth: width, sourceHeight: height, focalPoint, renditions };
};
