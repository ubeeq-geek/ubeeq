import type { ReactNode } from 'react';
import { parseContentBlocks, type ContentBlock, type StoredPostBlock } from '@ubeeq/core';
import { sanitizeInlineHtml, textToInlineHtml } from './block-content.js';

export interface BlockPreviewMedia {
  mediaId: string;
  label: string;
  /** Caller-supplied, already-authorized browser preview; no original URL lookup. */
  thumbnailUrl?: string;
}

/** The caller authorizes delivery and owns its React output. Raw stored URLs are
 * deliberately excluded; resolve these identities against an admitted media set.
 * Return undefined to keep the default private-preview/unavailable rendering.
 */
export type BlockMediaRenderer = (media: Readonly<{
  type: ContentBlock['type']; assetId?: string; fileId?: string; caption?: string;
}>) => ReactNode | undefined;

const safeLink = (url?: string): string | undefined => {
  if (!url) return;
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol) ? url : undefined; }
  catch { return; }
};

/** Read-only draft preview. Does not authorize publication or embed remote content. */
export function BlockPreview({ value, mediaOptions = [], label = 'Content preview', renderMedia }: {
  value: readonly StoredPostBlock[];
  mediaOptions?: readonly BlockPreviewMedia[];
  label?: string;
  renderMedia?: BlockMediaRenderer;
}) {
  let blocks: ContentBlock[];
  try { blocks = parseContentBlocks(value, { unbounded: true }); }
  catch { return <section aria-label={label}><p role="alert">Content exceeds the preview structure limits.</p></section>; }
  const inline = (block: ContentBlock) => <span dangerouslySetInnerHTML={{ __html: sanitizeInlineHtml(block.html ?? textToInlineHtml(block.quote || block.text || '')) }} />;
  const link = (block: ContentBlock) => {
    const href = safeLink(block.url), text = block.label || block.title || block.url || 'Link';
    return href ? <a href={href} target="_blank" rel="noopener noreferrer">{text}</a> : <span>{text} (link unavailable)</span>;
  };
  const render = (block: ContentBlock): ReactNode => {
    let content: ReactNode;
    switch (block.type) {
      case 'section': content = <section>{block.title && <h2>{block.title}</h2>}{block.children?.map(render)}</section>; break;
      case 'paragraph': content = <p>{inline(block)}</p>; break;
      case 'heading': {
        const Heading = `h${Math.max(2, Math.min(6, block.level || 2))}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        content = <Heading>{inline(block)}</Heading>; break;
      }
      case 'quote': content = <blockquote>{inline(block)}{block.author && <cite>{block.author}</cite>}</blockquote>; break;
      case 'divider': content = <hr />; break;
      case 'link': content = <p>{link(block)}</p>; break;
      case 'credit': content = <p>{block.author && <strong>{block.author}: </strong>}{block.text}{block.url && <> — {link(block)}</>}</p>; break;
      case 'image': case 'video': case 'audio': case 'file': case 'pdf_preview': {
        const authorized = renderMedia?.({ type: block.type, assetId: block.assetId, fileId: block.fileId, caption: block.caption });
        if (authorized !== undefined) { content = authorized; break; }
        const media = mediaOptions.find(item => item.mediaId === (block.assetId || block.fileId));
        // Only use object URLs the caller created after authenticated delivery.
        const thumbnail = media?.thumbnailUrl?.startsWith('blob:') ? media.thumbnailUrl : undefined;
        content = <figure>{thumbnail ? <img src={thumbnail} alt={block.caption || media?.label || 'Media preview'} width={320} /> : <p>{media?.label || 'Media unavailable'} — {block.type} preview unavailable</p>}
          {block.caption && <figcaption>{block.caption}</figcaption>}
          {block.type !== 'image' && thumbnail && <p>Static preview only; playback is not available here.</p>}
        </figure>; break;
      }
      default: content = <p>{block.type} block is retained but is not rendered in this preview.</p>;
    }
    return <div key={block.id} data-preview-block={block.id}>{content}</div>;
  };
  return <section aria-label={label}>{blocks.length ? blocks.map(render) : <p>No body content yet.</p>}</section>;
}
