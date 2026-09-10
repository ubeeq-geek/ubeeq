import type { CropImageSize, CropPreviewRect } from './crop-preview.js';

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
const orientationValue = (value: number): ExifOrientation => {
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error('Invalid EXIF orientation.');
  return value as ExifOrientation;
};
const validateSize = (size: CropImageSize) => {
  if (![size.width, size.height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid source image dimensions.');
};
/** Dimensions of an upright view; source dimensions always describe raw pixels. */
export const orientedImageSize = (size: CropImageSize, orientation = 1): CropImageSize => {
  validateSize(size);
  return orientationValue(orientation) >= 5 ? { width: size.height, height: size.width } : { ...size };
};
const edgePoint = (x: number, y: number, width: number, height: number, orientation: ExifOrientation): [number, number] => {
  switch (orientation) {
    case 1: return [x, y];
    case 2: return [width - x, y];
    case 3: return [width - x, height - y];
    case 4: return [x, height - y];
    case 5: return [y, x];
    case 6: return [height - y, x];
    case 7: return [height - y, width - x];
    case 8: return [y, width - x];
  }
};
/** Transform integer pixel-edge rectangles, not pixel-centre coordinates. */
export const cropRectToOriented = (size: CropImageSize, crop: CropPreviewRect, orientation = 1): CropPreviewRect => {
  validateSize(size); const value = orientationValue(orientation);
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger) || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 ||
    crop.x > size.width || crop.y > size.height || crop.width > size.width - crop.x || crop.height > size.height - crop.y) throw new Error('Crop is outside source image bounds.');
  const first = edgePoint(crop.x, crop.y, size.width, size.height, value);
  const last = edgePoint(crop.x + crop.width, crop.y + crop.height, size.width, size.height, value);
  return { x: Math.min(first[0], last[0]), y: Math.min(first[1], last[1]), width: Math.abs(last[0] - first[0]), height: Math.abs(last[1] - first[1]) };
};
const inverse = (orientation: ExifOrientation): ExifOrientation => orientation === 6 ? 8 : orientation === 8 ? 6 : orientation;
/** Convert an upright-view selection back to the existing raw-source crop contract. */
export const cropRectToSource = (size: CropImageSize, crop: CropPreviewRect, orientation = 1): CropPreviewRect =>
  cropRectToOriented(orientedImageSize(size, orientation), crop, inverse(orientationValue(orientation)));

/** Focal fractions in an upright view become fractions in raw-source space. */
export const orientedFocalPointToSource = (point: { x: number; y: number }, orientation = 1) => {
  if (![point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('Invalid focal fractions.');
  const [x, y] = edgePoint(point.x, point.y, 1, 1, inverse(orientationValue(orientation)));
  return { x, y };
};
export const sourceFocalPointToOriented = (point: { x: number; y: number }, orientation = 1) => {
  if (![point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('Invalid focal fractions.');
  const [x, y] = edgePoint(point.x, point.y, 1, 1, orientationValue(orientation));
  return { x, y };
};
