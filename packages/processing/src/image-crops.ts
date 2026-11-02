export interface SquareCropInput { x: number; y: number; size: number }
export interface CoverCropInput { x: number; y: number; width: number; height: number }
export interface FocalPointInput { x: number; y: number }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const dimensions = (...values: number[]) => {
  if (!values.every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Image dimensions must be positive integers.');
};
const finite = (...values: number[]) => {
  if (!values.every(Number.isFinite)) throw new Error('Crop coordinates must be finite.');
};

export const pickSquareCrop = (width: number, height: number, requested?: SquareCropInput): SquareCropInput => {
  dimensions(width, height);
  const maxSide = Math.min(width, height);
  if (!requested) return { x: Math.floor((width - maxSide) / 2), y: Math.floor((height - maxSide) / 2), size: maxSide };
  finite(requested.x, requested.y, requested.size);
  const size = clamp(Math.floor(requested.size), 1, maxSide);
  return { x: clamp(Math.floor(requested.x), 0, width - size), y: clamp(Math.floor(requested.y), 0, height - size), size };
};

export const pickCoverCrop = (sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number,
  focalPoint: FocalPointInput, requested?: CoverCropInput, zoom=1): CoverCropInput => {
  dimensions(sourceWidth, sourceHeight, targetWidth, targetHeight);
  if(!Number.isFinite(zoom)||zoom<1||zoom>3)throw new Error('Cover zoom must be between 1 and 3.');
  if (requested) {
    finite(requested.x, requested.y, requested.width, requested.height);
    const width = clamp(Math.floor(requested.width), 1, sourceWidth), height = clamp(Math.floor(requested.height), 1, sourceHeight);
    return { x: clamp(Math.floor(requested.x), 0, sourceWidth - width), y: clamp(Math.floor(requested.y), 0, sourceHeight - height), width, height };
  }
  finite(focalPoint.x, focalPoint.y);
  const aspect = targetWidth / targetHeight, sourceAspect = sourceWidth / sourceHeight;
  const width = Math.max(1,Math.round((sourceAspect > aspect ? clamp(Math.round(sourceHeight * aspect), 1, sourceWidth) : sourceWidth)/zoom));
  const height = Math.max(1,Math.round((sourceAspect > aspect ? sourceHeight : clamp(Math.round(sourceWidth / aspect), 1, sourceHeight))/zoom));
  return { x: clamp(Math.round(clamp(focalPoint.x, 0, 1) * sourceWidth - width / 2), 0, sourceWidth - width),
    y: clamp(Math.round(clamp(focalPoint.y, 0, 1) * sourceHeight - height / 2), 0, sourceHeight - height), width, height };
};
