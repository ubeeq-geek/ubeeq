import sharp from 'sharp';
import { pickSquareCrop, type MediaProcessor, type ProcessedRendition, type SquareCropInput } from '@ubeeq/processing';
import { renderImageRendition } from './rendition.js';
import { renditionDimensions, validateCoordinateSpace, type ImageCoordinateSpace } from './coordinate-space.js';

const recipes = [
  ['w320', 320, false], ['w640', 640, false], ['w1280', 1280, false], ['w1920', 1920, false],
  ['square256', 256, true], ['square512', 512, true], ['square1024', 1024, true]
] as const;
export type ImageRenditionName = typeof recipes[number][0];

export interface ImageRenditionSetOptions {
  /** Explicit nonempty subset, returned in canonical recipe order. Default: all seven. */
  renditionNames?: readonly ImageRenditionName[];
  squareCrop?: SquareCropInput;
  /** Coordinates and reported dimensions default to raw; oriented is explicit. */
  coordinateSpace?: ImageCoordinateSpace;
  maxInputPixels?: number;
  maxSourceBytes?: number;
  maxOutputBytes?: number;
}

/** Four fitted long-edge sizes and three square crops. Raw coordinates are the
 * compatibility default; oriented mode applies EXIF before crop selection.
 * Outputs carry lineage, not storage references or publication authority. */
export class SharpImageRenditionProcessor implements MediaProcessor {
  private readonly options: ImageRenditionSetOptions;
  constructor(options: ImageRenditionSetOptions = {}) {
    this.options = structuredClone(options);
    validateCoordinateSpace(this.options.coordinateSpace);
    const selected = this.options.renditionNames;
    if (selected !== undefined && (!Array.isArray(selected) || !selected.length || selected.length > recipes.length ||
      new Set(selected).size !== selected.length || selected.some(name => !recipes.some(recipe => recipe[0] === name)))) {
      throw new Error('Invalid image rendition selection.');
    }
    for (const value of [options.maxInputPixels, options.maxSourceBytes, options.maxOutputBytes]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('Image rendition budgets must be positive integers.');
    }
    if (options.squareCrop && !Object.values(options.squareCrop).every(Number.isFinite)) throw new Error('Invalid square crop.');
  }
  async process(input: Parameters<MediaProcessor['process']>[0]) {
    const { assetId, sourceVersionId, contentType } = input;
    // Capture request-owned options before the first decoder await. Never mutate
    // the shared processor defaults or retain a caller-owned crop object.
    const squareCrop = input.squareCrop === undefined ? this.options.squareCrop : { ...input.squareCrop };
    if (squareCrop && ![squareCrop.x, squareCrop.y, squareCrop.size].every(Number.isFinite)) throw new Error('Invalid square crop.');
    if (!assetId || !sourceVersionId || !contentType.startsWith('image/')) throw new Error('Image processing requires asset identity, image type and source version.');
    if (!input.source.byteLength || input.source.byteLength > (this.options.maxSourceBytes ?? 50 * 1024 * 1024)) throw new Error('Image source exceeds byte budget.');
    const source = Uint8Array.from(input.source);
    const maxInputPixels = this.options.maxInputPixels ?? 40_000_000;
    const metadata = await sharp(source, { limitInputPixels: maxInputPixels, failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height || !metadata.format) throw new Error('Image decoder did not produce valid dimensions.');
    const { width, height } = renditionDimensions(metadata.width, metadata.height, metadata.orientation, this.options.coordinateSpace);
    const crop = pickSquareCrop(width, height, squareCrop);
    const renditions: ProcessedRendition[] = [];
    let outputBytes = 0;
    for (const [name, size, square] of recipes) {
      if (this.options.renditionNames && !this.options.renditionNames.includes(name)) continue;
      const body = await renderImageRendition(source, { width: size, height: size, quality: 82, maxInputPixels,
        coordinateSpace: this.options.coordinateSpace,
        fit: square ? 'cover' : 'inside', withoutEnlargement: !square,
        ...(square ? { crop: { x: crop.x, y: crop.y, width: crop.size, height: crop.size } } : {}) });
      outputBytes += body.byteLength;
      if (outputBytes > (this.options.maxOutputBytes ?? 50 * 1024 * 1024)) throw new Error('Image renditions exceed output byte budget.');
      renditions.push({ id: name === 'w320' ? `preview:${assetId}:${sourceVersionId}` : `${name}:${assetId}:${sourceVersionId}`,
        sourceVersionId, contentType: 'image/jpeg', role: 'preview', byteLength: body.byteLength, body });
    }
    return { metadata: { contentType, byteLength: source.byteLength, width, height,
      ...(this.options.coordinateSpace === 'oriented' ? { coordinateSpace: 'oriented',
        rawSourceWidth: metadata.width, rawSourceHeight: metadata.height, sourceOrientation: metadata.orientation ?? 1 } : {}),
      decodedFormat: metadata.format, aspectRatio: Number((width / height).toFixed(5)),
      squareCropX: crop.x, squareCropY: crop.y, squareCropSize: crop.size }, renditions, measuredUnits: renditions.length };
  }
}
