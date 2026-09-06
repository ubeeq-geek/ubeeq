import type { ContentBlock, ContentBlockType, EntityId } from "./index.js";

const supported = new Set(["section", "heading", "paragraph", "image", "video", "audio", "quote", "divider", "embed", "file", "link", "credit", "grouping", "carousel", "pdf_preview", "html_fragment"]);

export interface ContentBlockParseOptions {
  unbounded?: boolean;
  /** JSON container depth, including block arrays and metadata. */
  maxDepth?: number;
  /** Total input values, including ignored fields and unsupported blocks. */
  maxNodes?: number;
}

export class ContentBlockInputError extends Error {
  readonly code = "invalid_content_structure";
}

/** Iterative preflight runs before recursive parsing or metadata cloning. */
const checkStructure = (value: unknown, options: ContentBlockParseOptions): void => {
  const maxDepth = options.maxDepth ?? 64, maxNodes = options.maxNodes ?? 10000;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 128 ||
      !Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new ContentBlockInputError("Content limits require a depth of 1–128 and a positive node budget.");
  }
  const active = new Set<object>();
  let remaining = maxNodes;
  const visit = (input: unknown, depth: number): Iterator<unknown> | undefined => {
    if (--remaining < 0) throw new ContentBlockInputError("Content node budget exceeded.");
    if (!input || typeof input !== "object") return;
    if (depth > maxDepth) throw new ContentBlockInputError("Content nesting limit exceeded.");
    if (active.has(input)) throw new ContentBlockInputError("Content cannot contain cycles.");
    active.add(input);
    return (function* () {
      for (const key in input) if (Object.hasOwn(input, key)) yield (input as Record<string, unknown>)[key];
    })();
  };
  const first = visit(value, 1);
  const stack = first ? [{ object: value as object, values: first, depth: 1 }] : [];
  while (stack.length) {
    const frame = stack[stack.length - 1], next = frame.values.next();
    if (next.done) { active.delete(frame.object); stack.pop(); continue; }
    const values = visit(next.value, frame.depth + 1);
    if (values) stack.push({ object: next.value as object, values, depth: frame.depth + 1 });
  }
};

/** Existing stored keys remain available while consumers migrate to portable blocks. */
export interface StoredPostBlock extends Omit<ContentBlock, "id" | "assetId" | "fileId" | "data" | "children"> {
  blockId: string;
  mediaId?: string;
  fileId?: string;
  payload?: Record<string, unknown>;
  blocks?: StoredPostBlock[];
}

/**
 * Normalizes editor input, including compatibility field names. This is not HTML,
 * URL or embed sanitization: renderers and product policy must enforce those rules.
 * Unknown block types are omitted, matching the existing editor import contract.
 */
export const parseContentBlocks = (value: unknown, options: ContentBlockParseOptions = {}): ContentBlock[] => {
  checkStructure(value, options);
  const parse = (input: unknown, parent = ""): ContentBlock[] => {
    if (!Array.isArray(input)) return [];
    return input.flatMap((item, index): ContentBlock[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const type = typeof row.type === "string" ? row.type.trim() : "";
      if (!supported.has(type)) return [];
      const suppliedId = row.blockId ?? row.id;
      const id = typeof suppliedId === "string" && suppliedId.trim() ? suppliedId.trim() : `${parent}${type}-${index + 1}`;
      const block: ContentBlock = { id: id as EntityId, type: type as ContentBlockType };
      if (typeof row.text === "string") block.text = options.unbounded ? row.text : row.text.slice(0, 20000);
      if (typeof row.level === "number" && Number.isFinite(row.level)) block.level = Math.max(1, Math.min(6, Math.floor(row.level)));
      const assetId = row.mediaId ?? row.assetId;
      if (typeof assetId === "string" && assetId.trim()) block.assetId = assetId.trim() as EntityId;
      if (typeof row.fileId === "string" && row.fileId.trim()) block.fileId = row.fileId.trim() as EntityId;
      if (typeof row.caption === "string") block.caption = row.caption.slice(0, 2000);
      if (typeof row.quote === "string") block.quote = options.unbounded ? row.quote : row.quote.slice(0, 4000);
      if (typeof row.author === "string") block.author = row.author.slice(0, 200);
      if (typeof row.url === "string") block.url = row.url.slice(0, 2048);
      if (typeof row.mimeType === "string") block.mimeType = row.mimeType.slice(0, 255);
      if (typeof row.title === "string") block.title = row.title.slice(0, 300);
      if (typeof row.label === "string") block.label = row.label.slice(0, 300);
      if (typeof row.html === "string") block.html = options.unbounded ? row.html : row.html.slice(0, 50000);
      const data = row.payload ?? row.data;
      if (data && typeof data === "object" && !Array.isArray(data)) block.data = structuredClone(data) as Record<string, unknown>;
      const childInput = row.blocks ?? row.children;
      const children = parse(childInput, `${id}/`);
      if (children.length || Array.isArray(childInput)) block.children = children;
      return [block];
    });
  };
  return parse(value);
};

export const toStoredPostBlocks = (blocks: readonly ContentBlock[]): StoredPostBlock[] => blocks.map((block) => {
  const { id, assetId, data, children, ...fields } = block;
  return { ...fields, blockId: id,
    ...(assetId ? { mediaId: assetId } : {}), ...(data ? { payload: structuredClone(data) } : {}),
    ...(children ? { blocks: toStoredPostBlocks(children) } : {}) };
});

export const parseStoredPostBlocks = (value: unknown, options: ContentBlockParseOptions = {}): StoredPostBlock[] =>
  toStoredPostBlocks(parseContentBlocks(value, options));
