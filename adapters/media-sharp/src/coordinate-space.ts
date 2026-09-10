/** Raw is the legacy pre-EXIF raster; oriented applies EXIF before selecting pixels. */
export type ImageCoordinateSpace = 'raw' | 'oriented';

export function validateCoordinateSpace(value: unknown): asserts value is ImageCoordinateSpace | undefined {
  if (value !== undefined && value !== 'raw' && value !== 'oriented') throw new Error('Invalid image coordinate space.');
}

export function renditionDimensions(width: number, height: number, orientation: number | undefined, space?: ImageCoordinateSpace) {
  validateCoordinateSpace(space);
  if (space === 'oriented') {
    const tag = orientation ?? 1;
    if (!Number.isInteger(tag) || tag < 1 || tag > 8) throw new Error('Invalid image orientation.');
    if (tag >= 5) return { width: height, height: width };
  }
  return { width, height };
}
