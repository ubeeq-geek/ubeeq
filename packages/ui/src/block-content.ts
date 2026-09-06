import type { StoredPostBlock as PostBlock } from '@ubeeq/core';

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

const sanitizeInlineNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent || '');
  if (!(node instanceof HTMLElement)) return '';

  const tag = node.tagName.toLowerCase();
  const children = Array.from(node.childNodes).map(sanitizeInlineNode).join('');
  if (tag === 'br') return '<br>';
  if (tag === 'strong' || tag === 'b') return `<strong>${children}</strong>`;
  if (tag === 'em' || tag === 'i') return `<em>${children}</em>`;
  if (tag === 'u') return `<u>${children}</u>`;
  if (tag === 's' || tag === 'strike') return `<s>${children}</s>`;
  if (tag === 'code') return `<code>${children}</code>`;
  if (tag === 'div' || tag === 'p') return `${children}<br>`;
  if (tag === 'li') return `• ${children}<br>`;
  if (tag === 'a') {
    const href = node.getAttribute('href') || '';
    return isSafeLink(href)
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${children}</a>`
      : children;
  }
  return children;
};

export const sanitizeInlineHtml = (value: string): string => {
  if (!value) return '';
  if (typeof DOMParser === 'undefined') return escapeHtml(value);
  const document = new DOMParser().parseFromString(`<body>${value}</body>`, 'text/html');
  return Array.from(document.body.childNodes).map(sanitizeInlineNode).join('');
};

export const inlineHtmlToText = (value: string): string => {
  if (!value) return '';
  if (typeof DOMParser === 'undefined') return value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
  const document = new DOMParser().parseFromString(`<body>${value}</body>`, 'text/html');
  document.body.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
  return document.body.textContent || '';
};

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
