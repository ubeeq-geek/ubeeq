/**
 * Structural view of validated canonical stored blocks. Extra canonical metadata
 * is not rendered. Callers must parse and bound untrusted trees before rendering.
 */
export interface WordPressRenderBlock {
  type: string;
  text?: string;
  level?: number;
  quote?: string;
  url?: string;
  label?: string;
  title?: string;
  blocks?: readonly WordPressRenderBlock[];
}

/**
 * Pure HTML serialization only: no network requests, credential access, site
 * eligibility, or publication authorization. No embed hosts are approved by default.
 */
const escapeHtml = (text = '') => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The only route from canonical blocks to WordPress HTML; raw HTML and arbitrary embeds are rejected. */
export type WordPressRenderPolicy = { approvedEmbedHosts?: readonly string[]; format?: 'blocks' | 'classic' };

export const renderWordPressContent = (blocks: readonly WordPressRenderBlock[] = [], policy: WordPressRenderPolicy = {}): string => blocks.map((block) => {
  if (block.type === 'paragraph') return `<p>${escapeHtml(block.text)}</p>`;
  if (block.type === 'heading') return `<h${Math.min(6, Math.max(2, block.level || 2))}>${escapeHtml(block.text)}</h${Math.min(6, Math.max(2, block.level || 2))}>`;
  if (block.type === 'quote') return `<blockquote><p>${escapeHtml(block.quote || block.text)}</p></blockquote>`;
  if (block.type === 'divider') return '<hr />';
  if (block.type === 'link') {
    const url = new URL(block.url || '');
    if (!['https:', 'mailto:'].includes(url.protocol)) throw new Error('Only HTTPS and email links are supported');
    return `<p><a href="${escapeHtml(url.toString())}" rel="noopener noreferrer">${escapeHtml(block.label || block.text || url.toString())}</a></p>`;
  }
  if (block.type === 'embed') {
    let url: URL;
    try { url = new URL(block.url || ''); } catch { throw new Error('Untrusted WordPress embed provider'); }
    const approved = (policy.approvedEmbedHosts || []).map((host) => host.toLowerCase());
    if (url.protocol !== 'https:' || !approved.includes(url.hostname.toLowerCase()) || url.username || url.password) throw new Error('Untrusted WordPress embed provider');
    const link = `<figure class="wp-block-embed"><div class="wp-block-embed__wrapper">${escapeHtml(url.toString())}</div></figure>`;
    return policy.format === 'classic' ? `<p><a href="${escapeHtml(url.toString())}" rel="noopener noreferrer">${escapeHtml(block.title || url.toString())}</a></p>` : `<!-- wp:embed -->\n${link}\n<!-- /wp:embed -->`;
  }
  if (['html_fragment', 'video', 'audio', 'file', 'pdf_preview'].includes(block.type)) throw new Error(`Unsupported WordPress block: ${block.type}`);
  if (block.type === 'section') return renderWordPressContent(block.blocks || [], policy);
  throw new Error(`Unsupported WordPress block: ${block.type}`);
}).join('\n');
