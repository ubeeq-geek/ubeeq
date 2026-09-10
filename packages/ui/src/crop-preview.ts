export interface CropImageSize { width: number; height: number }
export interface CropPreviewRect { x: number; y: number; width: number; height: number }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const validate = (size: CropImageSize, x: number, y: number) => {
  if (![size.width, size.height].every(n => Number.isSafeInteger(n) && n > 0) || ![x, y].every(Number.isFinite)) throw new Error('Invalid crop preview geometry.');
};

/** Percentage focal controls and zoom; returns original-image pixel coordinates. */
export const squareCropFromControls = (size: CropImageSize, positionX: number, positionY: number, zoom: number) => {
  validate(size, positionX, positionY);
  if (!Number.isFinite(zoom) || zoom < 1) throw new Error('Crop zoom must be at least one.');
  const side = Math.max(1, Math.round(Math.min(size.width, size.height) / zoom));
  return { x: Math.round(clamp(clamp(positionX, 0, 100) / 100 * size.width - side / 2, 0, size.width - side)),
    y: Math.round(clamp(clamp(positionY, 0, 100) / 100 * size.height - side / 2, 0, size.height - side)), size: side };
};

export const coverCropFromControls = (size: CropImageSize, targetWidth: number, targetHeight: number, positionX: number, positionY: number): CropPreviewRect => {
  validate(size, positionX, positionY); validate({ width: targetWidth, height: targetHeight }, positionX, positionY);
  const aspect = targetWidth / targetHeight, sourceAspect = size.width / size.height;
  const width = sourceAspect > aspect ? clamp(Math.round(size.height * aspect), 1, size.width) : size.width;
  const height = sourceAspect > aspect ? size.height : clamp(Math.round(size.width / aspect), 1, size.height);
  return { x: Math.round(clamp(clamp(positionX, 0, 100) / 100 * size.width - width / 2, 0, size.width - width)),
    y: Math.round(clamp(clamp(positionY, 0, 100) / 100 * size.height - height / 2, 0, size.height - height)), width, height };
};

/** Ignore hidden/zero-size canvases instead of emitting non-finite selections. */
export const cropPreviewPoint = (bounds: { left: number; top: number; width: number; height: number }, x: number, y: number) => {
  if (![bounds.left, bounds.top, bounds.width, bounds.height, x, y].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return undefined;
  return { x: clamp((x - bounds.left) / bounds.width, 0, 1), y: clamp((y - bounds.top) / bounds.height, 0, 1) };
};
