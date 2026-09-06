import { parseContentBlocks } from './content-blocks.js';
import { parseContentMediaReferences } from './content-media.js';

/** Asset identities used by supported body blocks and media/comparison references.
 * This is not authorization; callers must check current attached asset ownership.
 * File IDs and external URLs are separate identities, not canonical asset IDs.
 */
export const contentAssetReferences = (body: unknown, media: unknown): string[] => {
  const ids = new Set<string>();
  const stack = [...parseContentBlocks(body, { unbounded: true })];
  while (stack.length) {
    const block = stack.pop()!;
    if (block.assetId) ids.add(block.assetId);
    if (block.children) stack.push(...block.children);
  }
  for (const item of parseContentMediaReferences(media)) {
    ids.add(item.assetId);
    if (item.comparison?.item?.assetId) ids.add(item.comparison.item.assetId);
  }
  return [...ids];
};
