/** Metadata-only Vimeo projections. No original-media URLs or credentials are retained. */
export interface VimeoAccount {
  id: string; name: string; uri: string; accountType?: string;
  uploadQuota?: { freeBytes?: number; resetsAt?: string };
}
export interface VimeoRemoteVideo {
  id: string; uri: string; link?: string; title: string; description?: string;
  durationSeconds?: number; privacy?: string; embedDomains: string[];
  stats: { plays?: number; finishes?: number; likes?: number }; modifiedAt?: string;
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const identity = (value: unknown, resource: string): { id: string; uri: string } => {
  const uri = string(value);
  if (!uri || !new RegExp(`^/${resource}/[0-9]+$`).test(uri)) throw new Error(`Invalid Vimeo ${resource} identity.`);
  return { uri, id: uri.slice(uri.lastIndexOf('/') + 1) };
};

export function normalizeVimeoAccount(payload: unknown): VimeoAccount {
  const value = object(payload), quota = object(value.upload_quota);
  return {
    ...identity(value.uri, 'users'), name: string(value.name) ?? '', accountType: string(value.account),
    uploadQuota: { freeBytes: number(object(quota.space).free), resetsAt: string(object(quota.periodic).reset_date) }
  };
}

export function normalizeVimeoVideo(payload: unknown): VimeoRemoteVideo {
  const value = object(payload), stats = object(value.stats), domains = object(value.embed).domains;
  return {
    ...identity(value.uri, 'videos'), title: string(value.name) || 'Untitled Vimeo video',
    link: string(value.link), description: string(value.description), durationSeconds: number(value.duration),
    privacy: string(object(value.privacy).view),
    embedDomains: Array.isArray(domains) ? domains.filter((domain): domain is string => typeof domain === 'string') : [],
    stats: { plays: number(stats.plays), finishes: number(stats.finishes), likes: number(object(object(object(value.metadata).connections).likes).total) },
    modifiedAt: string(value.modified_time)
  };
}

export function normalizeVimeoVideoPage(payload: unknown, page: number): { videos: VimeoRemoteVideo[]; nextPage?: number } {
  if (!Number.isSafeInteger(page) || page < 1 || page === Number.MAX_SAFE_INTEGER) throw new Error('Invalid Vimeo page number.');
  const value = object(payload);
  if (!Array.isArray(value.data)) throw new Error('Invalid Vimeo video collection.');
  return { videos: value.data.map(normalizeVimeoVideo), nextPage: object(value.paging).next ? page + 1 : undefined };
}
