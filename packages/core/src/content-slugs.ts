export interface ContentSlugOptions {
  /** Applied after ASCII normalization, preserving existing truncation behavior. */
  maxLength?: number;
  fallback: string;
}

/** URL-label normalization only, not uniqueness, authorization or a reservation. */
export const normalizeContentSlug = (value: string, options: ContentSlugOptions): string => {
  if (options.maxLength !== undefined && (!Number.isSafeInteger(options.maxLength) || options.maxLength < 1)) {
    throw new Error('Invalid slug length limit.');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.fallback)) throw new Error('Invalid slug fallback.');
  const normalized = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (options.maxLength === undefined ? normalized : normalized.slice(0, options.maxLength)) || options.fallback;
};

/** Stable first-seen history; callers retain control over compatibility rules. */
export const normalizeSlugHistory = (
  values: readonly (string | undefined)[], normalize: (value: string) => string
): string[] => {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const normalized = normalize(value);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
};

/** Current slugs are already canonical; historical aliases may need normalization. */
export const matchesContentSlug = (
  record: { slug: string; slugHistory?: readonly string[] }, candidate: string,
  normalize: (value: string) => string
): boolean => {
  const normalized = normalize(candidate);
  return Boolean(normalized) && (record.slug === normalized ||
    (record.slugHistory || []).some(value => normalize(value) === normalized));
};
