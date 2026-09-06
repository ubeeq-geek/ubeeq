import type { ContentMediaReference, EntityId } from "./index.js";

type Row = Record<string, unknown>;
const rowFor = (value: unknown): Row | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const text = (value: unknown, limit: number): string | undefined => typeof value === "string" ? value.trim().slice(0, limit) : undefined;
const order = (value: unknown): number | undefined => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : undefined;
const creditFor = (value: unknown): ContentMediaReference['credit'] => {
  const row = rowFor(value);
  const label = text(row?.label, 300);
  return label ? { label, url: text(row?.url, 2048) } : undefined;
};

/** Structural normalization only; referenced-asset authorization and URL safety are separate. */
export const parseContentMediaReferences = (value: unknown, options: { defaultDiscoverable?: boolean } = {}): ContentMediaReference[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((input): ContentMediaReference[] => {
    const row = rowFor(input);
    if (!row) return [];
    const assetId = text(row.mediaId ?? row.assetId, Infinity);
    if (!assetId) return [];
    const comparison = rowFor(row.comparison);
    const item = rowFor(comparison?.comparisonItem ?? comparison?.item);
    const itemId = text(item?.mediaId ?? item?.assetId, Infinity);
    return [{ assetId: assetId as EntityId,
      discoverable: row.discoverable === undefined ? options.defaultDiscoverable === true : Boolean(row.discoverable),
      position: order('sortOrder' in row ? row.sortOrder : row.position),
      caption: typeof row.caption === "string" ? row.caption.slice(0, 2000) : undefined,
      credit: creditFor(row.credit),
      comparison: comparison && itemId ? {
        type: text(comparison.type, 80), role: text(comparison.role, 80), order: order(comparison.order),
        item: { assetId: itemId as EntityId, role: text(item?.role, 80), order: order(item?.order),
          caption: text(item?.caption, 2000), credit: creditFor(item?.credit) }
      } : undefined }];
  });
};

export interface StoredPostMediaReference {
  mediaId: string;
  discoverable?: boolean;
  sortOrder?: number;
  caption?: string;
  credit?: ContentMediaReference['credit'];
  comparison?: { type?: string; role?: string; order?: number;
    comparisonItem?: { mediaId: string; role?: string; order?: number; caption?: string; credit?: ContentMediaReference['credit'] } };
}
export const parseStoredPostMediaReferences = (value: unknown, options: { defaultDiscoverable: boolean }): StoredPostMediaReference[] =>
  parseContentMediaReferences(value, options).map(({ assetId, position, comparison, ...fields }) => {
    const item = comparison?.item;
    return { ...fields, mediaId: assetId, sortOrder: position,
      comparison: comparison && item ? { type: comparison.type, role: comparison.role, order: comparison.order,
        comparisonItem: { mediaId: item.assetId, role: item.role, order: item.order, caption: item.caption, credit: item.credit } } : undefined };
  });
