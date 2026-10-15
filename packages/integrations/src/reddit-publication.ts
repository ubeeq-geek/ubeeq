import { RedditApiError, type RedditSubmission } from './reddit.js';

export interface RedditPublishableWork {
  workId: string;
  title: string;
  publicUrl: string;
  nsfw?: boolean;
  flairId?: string;
}

export interface RedditPublishableCollection {
  collectionId: string;
  title: string;
  publicUrl: string;
  nsfw?: boolean;
  flairId?: string;
}

export type RedditPublicationRequest =
  | { type: 'announcement'; subreddit: string; title: string; text?: string; publicUrl?: string; nsfw?: boolean; flairId?: string }
  | { type: 'works'; subreddit: string; works: readonly RedditPublishableWork[] }
  | { type: 'collection'; subreddit: string; collection: RedditPublishableCollection };

export interface RedditPlannedSubmission {
  /** Local entity represented by the post. Announcements intentionally have no entity id. */
  source?: { type: 'work' | 'collection'; id: string };
  submission: RedditSubmission;
}

export interface RedditPublicationReceipt {
  source?: RedditPlannedSubmission['source'];
  remoteId: string;
  remoteUrl: string;
}

export type RedditPublicationResult =
  | { status: 'published'; receipts: readonly RedditPublicationReceipt[] }
  | { status: 'failed' | 'partially_published'; receipts: readonly RedditPublicationReceipt[]; failedIndex: number; error: RedditApiError };

const requireText = (value: string, label: string, maximum: number): string => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new RedditApiError(`${label} is invalid.`, 422);
  }
  return value;
};

const publicUrl = (value: string): string => {
  let url: URL;
  try { url = new URL(value); } catch { throw new RedditApiError('Use a public HTTPS link.', 422); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new RedditApiError('Use a public HTTPS link.', 422);
  }
  return url.href;
};

const destination = (subreddit: string): string => {
  if (!/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) throw new RedditApiError('Use a valid subreddit name.', 422);
  return subreddit;
};

const link = (subreddit: string, item: RedditPublishableWork | RedditPublishableCollection): RedditSubmission => ({
  kind: 'link', subreddit, title: requireText(item.title, 'Reddit title', 300), url: publicUrl(item.publicUrl),
  ...(item.flairId ? { flairId: requireText(item.flairId, 'Reddit flair ID', 100) } : {}), ...(item.nsfw === undefined ? {} : { nsfw: item.nsfw })
});

/**
 * Converts a product snapshot into immutable Reddit API submissions. A work batch
 * deliberately creates one post per work; a collection creates one post linking
 * to the collection rather than silently expanding mutable membership.
 */
export function planRedditPublication(request: RedditPublicationRequest): readonly RedditPlannedSubmission[] {
  const subreddit = destination(request.subreddit);
  if (request.type === 'announcement') {
    const title = requireText(request.title, 'Reddit title', 300);
    const common = { subreddit, title, ...(request.flairId ? { flairId: requireText(request.flairId, 'Reddit flair ID', 100) } : {}), ...(request.nsfw === undefined ? {} : { nsfw: request.nsfw }) };
    if (request.publicUrl !== undefined) {
      if (request.text !== undefined) throw new RedditApiError('A Reddit announcement cannot contain both body text and a link.', 422);
      return [{ submission: { ...common, kind: 'link', url: publicUrl(request.publicUrl) } }];
    }
    const text = request.text === undefined ? '' : request.text;
    if (text.length > 40_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new RedditApiError('Reddit announcement text is invalid.', 422);
    return [{ submission: { ...common, kind: 'self', text } }];
  }
  if (request.type === 'collection') {
    const id = requireText(request.collection.collectionId, 'Collection ID', 200);
    return [{ source: { type: 'collection', id }, submission: link(subreddit, request.collection) }];
  }
  if (!request.works.length) throw new RedditApiError('Select at least one work to publish.', 422);
  const seen = new Set<string>();
  return request.works.map((work) => {
    const id = requireText(work.workId, 'Work ID', 200);
    if (seen.has(id)) throw new RedditApiError('A work can only be included once in a Reddit publication.', 422);
    seen.add(id);
    return { source: { type: 'work' as const, id }, submission: link(subreddit, work) };
  });
}

export interface RedditSubmissionPort {
  submit(token: string, input: RedditSubmission): Promise<{ id: string; url: string }>;
}

/**
 * Executes a frozen plan in order and stops after the first failure. Receipts for
 * successful posts are retained so callers can persist partial progress and must
 * not retry the whole batch (Reddit has no submission idempotency key).
 */
export async function publishRedditPlan(client: RedditSubmissionPort, token: string, plan: readonly RedditPlannedSubmission[]): Promise<RedditPublicationResult> {
  if (!token.trim()) throw new RedditApiError('A Reddit access token is required.', 401);
  if (!plan.length) throw new RedditApiError('A Reddit publication plan cannot be empty.', 422);
  const receipts: RedditPublicationReceipt[] = [];
  for (let index = 0; index < plan.length; index += 1) {
    try {
      const remote = await client.submit(token, structuredClone(plan[index]!.submission));
      receipts.push({ ...(plan[index]!.source ? { source: structuredClone(plan[index]!.source) } : {}), remoteId: remote.id, remoteUrl: remote.url });
    } catch (cause) {
      const error = cause instanceof RedditApiError ? cause : new RedditApiError('Reddit publication failed.', undefined, undefined, true);
      return { status: receipts.length ? 'partially_published' : 'failed', receipts, failedIndex: index, error };
    }
  }
  return { status: 'published', receipts };
}

export async function publishToReddit(client: RedditSubmissionPort, token: string, request: RedditPublicationRequest): Promise<RedditPublicationResult> {
  return publishRedditPlan(client, token, planRedditPublication(request));
}
