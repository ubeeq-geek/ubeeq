const decodeBasicHtmlEntities = (value: string): string => value
  .replace(/&nbsp;/gi, ' ')
  .replace(/&quot;/gi, '"')
  .replace(/&#0*39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&amp;/gi, '&');

const escapeLimitedRichText = (value: string): string => decodeBasicHtmlEntities(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

export const sanitizeLimitedRichText = (value: unknown, maxTextLength: number): string | undefined => {
  if (!Number.isSafeInteger(maxTextLength) || maxTextLength < 0) throw new Error('Invalid rich-text limit.');
  if (typeof value !== 'string') return undefined;
  const source = value.trim();
  if (!source) return undefined;
  let textLength = 0;
  const sanitized = source.split(/(<[^>]*>)/g).map((token) => {
    if (token.startsWith('<')) {
      if (/^<br\s*\/?\s*>$/i.test(token)) return '<br>';
      if (/^<\/?(?:strong|b)\s*>$/i.test(token)) return token.startsWith('</') ? '</strong>' : '<strong>';
      if (/^<\/?(?:em|i)\s*>$/i.test(token)) return token.startsWith('</') ? '</em>' : '<em>';
      if (/^<\/?u\s*>$/i.test(token)) return token.startsWith('</') ? '</u>' : '<u>';
      if (/^<\/?(?:div|p|li)\b[^>]*>$/i.test(token)) return token.startsWith('</') ? '<br>' : '';
      return '';
    }
    const decoded = decodeBasicHtmlEntities(token);
    const remaining = Math.max(0, maxTextLength - textLength);
    const limited = decoded.slice(0, remaining);
    textLength += limited.length;
    return escapeLimitedRichText(limited);
  }).join('').replace(/(?:<br>){3,}/g, '<br><br>').replace(/(?:<br>)+$/g, '');
  return sanitized || undefined;
};

export const limitedRichTextToPlainText = (value: unknown): string => decodeBasicHtmlEntities(String(value || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]*>/g, ''));


export interface ProfileLinkPolicy {
  allowCustom: boolean;
  domainsByLabel: Readonly<Record<string, readonly string[]>>;
  maxLinks?: number;
}
const trimmed = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' ? value.trim().slice(0, limit) || undefined : undefined;

/** Display links only; this does not authorize fetching a URL or prevent SSRF. */
export const normalizeProfileExternalLinks = (value: unknown, policy: ProfileLinkPolicy): Array<{ label: string; url: string }> => {
  const maxLinks = policy.maxLinks ?? 12;
  if (!Number.isSafeInteger(maxLinks) || maxLinks < 0) throw new Error('Invalid profile link limit.');
  if (!Array.isArray(value)) return [];
  const labels = Object.keys(policy.domainsByLabel);
  return value.slice(0, maxLinks).flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const candidate = trimmed(entry.url, 1000);
    if (!candidate) return [];
    let parsed: URL;
    try { parsed = new URL(candidate); } catch { return []; }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return [];
    const submitted = trimmed(entry.label, 80) || parsed.hostname;
    const label = labels.find(item => item.toLowerCase() === submitted.toLowerCase());
    if (label && !policy.domainsByLabel[label].some(domain => parsed.hostname.toLowerCase() === domain.toLowerCase() || parsed.hostname.toLowerCase().endsWith('.' + domain.toLowerCase()))) return [];
    if (!label && !policy.allowCustom) return [];
    return [{ label: label || submitted, url: parsed.href }];
  });
};
