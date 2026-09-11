/**
 * WordPress REST capability observations and editable-field snapshots.
 * These describe provider responses; they do not authorize a publication or
 * replace current remote permission checks, product policy, or conflict fencing.
 * Normalization preserves the existing stored snapshot and hash representation.
 */
export type WordPressCapabilityProfile = {
  postsRead: boolean; postsWrite: boolean; pagesRead: boolean; pagesWrite: boolean;
  mediaUpload: boolean; categoriesWrite: boolean; tagsWrite: boolean; schedule: boolean;
  authorAssignment: boolean; featuredMedia: boolean; blockFormat: boolean;
  classicHtmlFormat: boolean; webhookAdapter: boolean;
};

export type WordPressPostSnapshot = {
  title: string; slug: string; excerpt: string; content: string; status: string;
  date: string; author?: number; categories: number[]; tags: number[]; featuredMediaId?: number;
};

export type WordPressFieldDiff = {
  field: keyof WordPressPostSnapshot; local: unknown; remote: unknown;
};

const routeSupports = (routes: any, route: string, method: string): boolean => {
  const definition = routes?.[route];
  if (!definition) return false;
  if (Array.isArray(definition.methods) && definition.methods.includes(method)) return true;
  return Array.isArray(definition.endpoints)
    && definition.endpoints.some((endpoint: any) => Array.isArray(endpoint?.methods) && endpoint.methods.includes(method));
};

export const detectWordPressCapabilities = (user: any, routes: any): WordPressCapabilityProfile => {
  const can = user?.capabilities || {};
  const has = (route: string, method: string) => routeSupports(routes, route, method);
  return {
    postsRead: has('/wp/v2/posts', 'GET'), postsWrite: has('/wp/v2/posts', 'POST') && !!can.edit_posts,
    pagesRead: has('/wp/v2/pages', 'GET'), pagesWrite: has('/wp/v2/pages', 'POST') && !!can.edit_pages,
    mediaUpload: has('/wp/v2/media', 'POST') && !!can.upload_files,
    categoriesWrite: has('/wp/v2/categories', 'POST') && !!can.manage_categories,
    tagsWrite: has('/wp/v2/tags', 'POST') && !!can.manage_categories,
    schedule: !!can.publish_posts, authorAssignment: !!can.edit_others_posts,
    featuredMedia: has('/wp/v2/media', 'POST'), blockFormat: true, classicHtmlFormat: true, webhookAdapter: false
  };
};

const rendered = (value: unknown): string => typeof value === 'string'
  ? value
  : typeof (value as any)?.raw === 'string'
    ? (value as any).raw
    : typeof (value as any)?.rendered === 'string' ? (value as any).rendered : '';

export const wordPressPostSnapshot = (post: any): WordPressPostSnapshot => ({
  title: rendered(post?.title), slug: String(post?.slug || ''), excerpt: rendered(post?.excerpt),
  content: rendered(post?.content), status: String(post?.status || ''),
  date: String(post?.date_gmt || post?.date || ''),
  author: Number.isInteger(post?.author) ? post.author : undefined,
  categories: Array.isArray(post?.categories) ? post.categories.filter(Number.isInteger) : [],
  tags: Array.isArray(post?.tags) ? post.tags.filter(Number.isInteger) : [],
  featuredMediaId: Number.isInteger(post?.featured_media) && post.featured_media > 0 ? post.featured_media : undefined
});

export const diffWordPressSnapshots = (local: WordPressPostSnapshot, remote: WordPressPostSnapshot): WordPressFieldDiff[] =>
  (Object.keys(local) as Array<keyof WordPressPostSnapshot>).flatMap((field) =>
    JSON.stringify(local[field]) === JSON.stringify(remote[field]) ? [] : [{ field, local: local[field], remote: remote[field] }]
  );
