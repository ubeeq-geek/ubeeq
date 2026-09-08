export interface DeviantArtPublicAiLabels { isAiGenerated?: boolean; noAi?: boolean }

/** Read only the recognized page-state record shape. Missing, ambiguous or
 * malformed metadata is unknown, never evidence of a negative label.
 * This function performs no network access and does not admit publication.
 */
export const parseDeviantArtPublicAiLabels = (html: string, externalUrl: string): DeviantArtPublicAiLabels => {
  let url: URL;
  try { url = new URL(externalUrl); } catch { return {}; }
  if (url.protocol !== 'https:' || (url.hostname !== 'deviantart.com' && !url.hostname.endsWith('.deviantart.com'))) return {};
  const id = url.pathname.match(/-(\d+)\/?$/)?.[1];
  if (!id) return {};
  // The compatibility page shape uses a plain or quote-escaped object beginning
  // with deviationId. Parse the complete object, not a slice spanning neighbors.
  const source = html.replace(/\\"/g, '"');
  const marker = new RegExp(`\\{\\s*"deviationId"\\s*:\\s*${id}(?=\\s*[,}])`, 'g');
  let match: RegExpExecArray | null, result: DeviantArtPublicAiLabels | undefined;
  while ((match = marker.exec(source))) {
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let i = match.index; i < Math.min(source.length, match.index + 5_000); i++) {
      const char = source[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) return {};
    try {
      const record = JSON.parse(source.slice(match.index, end)) as Record<string, unknown>;
      if (String(record.deviationId) !== id) return {};
      const labels: DeviantArtPublicAiLabels = {
        ...(typeof record.isAiGenerated === 'boolean' ? { isAiGenerated: record.isAiGenerated } : {}),
        ...(typeof record.isAiUseDisallowed === 'boolean' ? { noAi: record.isAiUseDisallowed } : {})
      };
      if (result && JSON.stringify(result) !== JSON.stringify(labels)) return {};
      result = labels;
    } catch { return {}; }
  }
  return result ?? {};
};
