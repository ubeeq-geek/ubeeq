/**
 * Product-neutral Ghost content serialization and legacy node/URL validation.
 * No network, credentials, publication authorization or site eligibility.
 * Validation is not a complete Lexical schema or HTML sanitizer; callers remain
 * responsible for input size/nesting limits and approved media provenance.
 */
export type GhostRenderBlock = { type: 'paragraph' | 'heading' | 'image' | 'code' | 'link'; text?: string; level?: 2 | 3 | 4; src?: string; alt?: string; caption?: string; href?: string };
export const renderGhostLexical = (blocks: readonly GhostRenderBlock[], canonicalUrl: string, options: { canonicalLinkText?: string } = {}): string => {
  const safeUrl = (value: string, image = false) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !image)) throw new Error('Only safe HTTP(S) URLs are supported');
    return value;
  };
  const children = blocks.map((block) => {
    if (block.type === 'paragraph' || block.type === 'code') return { type: block.type, version: 1, children: [{ type: 'text', version: 1, text: block.text || '' }] };
    if (block.type === 'heading') return { type: 'heading', version: 1, tag: `h${block.level || 2}`, children: [{ type: 'text', version: 1, text: block.text || '' }] };
    if (block.type === 'image') return { type: 'image', version: 1, src: safeUrl(block.src || '', true), altText: block.alt || '', caption: block.caption || '' };
    return { type: 'paragraph', version: 1, children: [{ type: 'link', version: 1, url: safeUrl(block.href || ''), children: [{ type: 'text', version: 1, text: block.text || block.href || '' }] }] };
  });
  children.push({ type: 'paragraph', version: 1, children: [{ type: 'link', version: 1, url: safeUrl(canonicalUrl), children: [{ type: 'text', version: 1, text: options.canonicalLinkText ?? 'View the canonical Work' }] }] });
  return JSON.stringify({ root: { type: 'root', version: 1, children } });
};

export const validateGhostLexical = (value: string): string => {
  let document: unknown;
  try {
    document = JSON.parse(value);
  } catch {
    throw new Error('Ghost Lexical content must be valid JSON');
  }
  const allowed = new Set(['root', 'paragraph', 'heading', 'text', 'image', 'code', 'link']);
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Ghost Lexical nodes must be objects');
    const record = node as Record<string, unknown>;
    if (typeof record.type !== 'string' || !allowed.has(record.type)) throw new Error(`Unsupported Ghost Lexical node: ${String(record.type)}`);
    if (record.type === 'link' || record.type === 'image') {
      const target = record.type === 'link' ? record.url : record.src;
      if (typeof target !== 'string') throw new Error(`Ghost Lexical ${record.type} requires a URL`);
      const url = new URL(target);
      if (record.type === 'image' ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Only safe HTTP(S) URLs are supported');
      }
    }
    if (record.children !== undefined) {
      if (!Array.isArray(record.children)) throw new Error('Ghost Lexical children must be an array');
      record.children.forEach(visit);
    }
  };
  const root = (document as { root?: unknown })?.root;
  visit(root);
  if ((root as { type?: string }).type !== 'root') throw new Error('Ghost Lexical document requires a root node');
  return JSON.stringify(document);
};
