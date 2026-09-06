import type { StoredPostBlock as PostBlock } from '@ubeeq/core';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

export type DescriptionBlockType = 'paragraph' | 'heading' | 'quote' | 'divider';

const descriptionBlockTypes = new Set<PostBlock['type']>(['paragraph', 'heading', 'quote', 'divider']);

const createBlockId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `block-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const isSafeLink = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
};

/** One inert HTML parser for server and browser. Reconstruct only the inline allowlist;
 * never serialize source nodes or attributes. Input and visited-node budgets fail closed.
 */
const inlineContent = (value: string, plainText: boolean): string => {
  if (!value) return '';
  if (value.length > 1_048_576) throw new Error('Inline content exceeds its input budget.');
  const root = parseFragment(value);
  const stack: Array<DefaultTreeAdapterMap['node'] | string> = [...root.childNodes].reverse();
  const output: string[] = [];
  let visited = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node === 'string') { output.push(node); continue; }
    if (++visited > 50_000) throw new Error('Inline content exceeds its structure budget.');
    if (node.nodeName === '#text' && 'value' in node) { output.push(plainText ? node.value : escapeHtml(node.value)); continue; }
    if (!('tagName' in node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    const tag = node.tagName;
    if (['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript'].includes(tag)) continue;
    if (tag === 'br') { output.push(plainText ? '\n' : '<br>'); continue; }
    let start = '', end = '';
    if (!plainText) {
      const normalized = ({ b: 'strong', strong: 'strong', i: 'em', em: 'em', u: 'u', s: 's', strike: 's', code: 'code' } as Record<string, string>)[tag];
      if (normalized) { start = '<' + normalized + '>'; end = '</' + normalized + '>'; }
      else if (tag === 'div' || tag === 'p') end = '<br>';
      else if (tag === 'li') { start = '• '; end = '<br>'; }
      else if (tag === 'a') {
        const href = node.attrs.find(attribute => attribute.name === 'href')?.value || '';
        if (isSafeLink(href)) { start = '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">'; end = '</a>'; }
      }
    }
    output.push(start);
    if (end) stack.push(end);
    for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]);
  }
  return output.join('');
};

export const sanitizeInlineHtml = (value: string): string => inlineContent(value, false);
export const inlineHtmlToText = (value: string): string => inlineContent(value, true);

export const textToInlineHtml = (value: string): string => escapeHtml(value).replace(/\r?\n/g, '<br>');

export const createDescriptionBlock = (type: DescriptionBlockType = 'paragraph'): PostBlock => ({
  blockId: createBlockId(),
  type,
  ...(type === 'heading' ? { level: 2 } : {}),
  ...(type !== 'divider' ? { text: '', html: '' } : {})
});

/** Work-body blocks, not compatible with the description-only serializer. */
export const createStructuredBlock = (type: 'section' | 'link' | 'credit'): PostBlock => {
  if (!['section', 'link', 'credit'].includes(type)) throw new Error('Unsupported structured block type.');
  return { blockId: createBlockId(), type,
    ...(type === 'section' ? { title: '', blocks: [] } : type === 'link' ? { label: '', url: '' } : { author: '', text: '', url: '' }) };
};

const blockFromElement = (element: HTMLElement): PostBlock | null => {
  const tag = element.tagName.toLowerCase();
  if (tag === 'hr') return createDescriptionBlock('divider');
  const html = sanitizeInlineHtml(element.innerHTML);
  const text = inlineHtmlToText(html).trim();
  if (!text && !html.includes('<br>')) return null;
  if (/^h[1-6]$/.test(tag)) {
    return { ...createDescriptionBlock('heading'), level: Number(tag.slice(1)), text, html };
  }
  if (tag === 'blockquote') {
    return { ...createDescriptionBlock('quote'), text, quote: text, html };
  }
  return { ...createDescriptionBlock('paragraph'), text, html };
};

export const parseDescriptionBlocks = (value?: string): PostBlock[] => {
  const source = value?.trim() || '';
  if (!source) return [createDescriptionBlock()];
  if (!/<\/?[a-z][^>]*>/i.test(source)) {
    return source.split(/\n\s*\n+/).filter(Boolean).map((text) => ({
      ...createDescriptionBlock(),
      text,
      html: textToInlineHtml(text)
    }));
  }
  if (typeof DOMParser === 'undefined') {
    return source.split(/\n\s*\n+/).filter(Boolean).map((text) => ({
      ...createDescriptionBlock(),
      text,
      html: textToInlineHtml(text)
    }));
  }

  const document = new DOMParser().parseFromString(`<body>${source}</body>`, 'text/html');
  const blocks: PostBlock[] = [];
  let inlineNodes: Node[] = [];
  const flushInlineNodes = () => {
    if (!inlineNodes.length) return;
    const holder = document.createElement('p');
    inlineNodes.forEach((node) => holder.appendChild(node.cloneNode(true)));
    const block = blockFromElement(holder);
    if (block) blocks.push(block);
    inlineNodes = [];
  };

  Array.from(document.body.childNodes).forEach((node) => {
    if (node instanceof HTMLElement && /^(p|div|h[1-6]|blockquote|hr|section|article|ul|ol)$/.test(node.tagName.toLowerCase())) {
      flushInlineNodes();
      const block = blockFromElement(node);
      if (block) blocks.push(block);
      return;
    }
    inlineNodes.push(node);
  });
  flushInlineNodes();

  return blocks.length ? blocks : [createDescriptionBlock()];
};

const inlineHtmlForBlock = (block: PostBlock): string => {
  if (block.html !== undefined) return sanitizeInlineHtml(block.html);
  return textToInlineHtml(block.quote || block.text || '');
};

export const normalizeDescriptionBlocks = (blocks: PostBlock[]): PostBlock[] => blocks
  .filter((block) => descriptionBlockTypes.has(block.type))
  .map((block) => {
    if (block.type === 'divider') return { blockId: block.blockId || createBlockId(), type: 'divider' };
    const html = inlineHtmlForBlock(block);
    const text = inlineHtmlToText(html);
    return {
      blockId: block.blockId || createBlockId(),
      type: block.type,
      ...(block.type === 'heading' ? { level: Math.max(1, Math.min(6, block.level || 2)) } : {}),
      ...(block.type === 'quote' ? { quote: text } : {}),
      text,
      html
    };
  });

export const serializeDescriptionBlocks = (
  blocks: PostBlock[],
  options: { maxHeadingLevel?: number } = {}
): string => normalizeDescriptionBlocks(blocks).map((block) => {
  if (block.type === 'divider') return '<hr>';
  const html = inlineHtmlForBlock(block);
  if (!inlineHtmlToText(html).trim() && !html.includes('<br>')) return '';
  if (block.type === 'heading') {
    const level = Math.max(1, Math.min(options.maxHeadingLevel ?? 6, block.level || 2));
    return `<h${level}>${html}</h${level}>`;
  }
  if (block.type === 'quote') return `<blockquote>${html}</blockquote>`;
  return `<p>${html}</p>`;
}).filter(Boolean).join('');

export const clonePostBlocks = <T extends PostBlock>(blocks: T[]): T[] => structuredClone(blocks);

/** Change text presentation without dropping IDs, nested content or extension metadata. */
export const changeTextBlockType = (block: PostBlock, type: 'paragraph' | 'heading' | 'quote'): PostBlock => {
  const supported = new Set(['paragraph', 'heading', 'quote']);
  if (!supported.has(block.type) || !supported.has(type)) throw new Error('Only text blocks support text type changes.');
  const next = structuredClone(block);
  const html = block.html !== undefined ? block.html : textToInlineHtml(block.quote || block.text || '');
  next.type = type;
  next.html = html;
  next.text = inlineHtmlToText(html);
  delete next.level; delete next.quote;
  if (type === 'heading') next.level = block.type === 'heading' ? block.level || 2 : 2;
  if (type === 'quote') next.quote = next.text;
  return next;
};

/** Reorder whole top-level subtrees; input blocks remain isolated from the result. */
export const movePostBlock = (blocks: PostBlock[], blockId: string, direction: -1 | 1): PostBlock[] => {
  const index = blocks.findIndex(block => block.blockId === blockId);
  if (index < 0 || (direction !== -1 && direction !== 1)) throw new Error('Invalid block move.');
  const next = clonePostBlocks(blocks), target = index + direction;
  if (target >= 0 && target < next.length) [next[index], next[target]] = [next[target], next[index]];
  return next;
};
