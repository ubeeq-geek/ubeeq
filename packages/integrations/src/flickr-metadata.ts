import { createHash } from 'node:crypto';

export interface FlickrManifestPhoto {
  remoteId: string;
  remoteUrl: string;
  title?: string;
  description?: string;
  tags: string[];
  albumIds: string[];
  capturedAt?: string;
  uploadedAt?: string;
  licence?: string;
  visibility: 'public' | 'friends' | 'family' | 'private';
  previewUrl?: string;
  /** Provider capability: callers must omit it from public/browser projections. */
  originalSourceUrl?: string;
  originalFilename?: string;
  originalSizeBytes?: number;
  originalAvailable: boolean;
  metadataHash: string;
}

/** Preserve the established pre-normalization hash to avoid rewriting saved identities. */
export const normalizeFlickrPhoto = (photo: Omit<FlickrManifestPhoto, 'metadataHash'>): FlickrManifestPhoto => ({
  ...photo,
  tags: [...new Set(photo.tags.map(tag => tag.trim()).filter(Boolean))],
  albumIds: [...new Set(photo.albumIds)],
  metadataHash: createHash('sha256').update(JSON.stringify(photo)).digest('hex')
});

export const flickrTextContent = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { _content?: unknown })._content === 'string') return (value as { _content: string })._content;
  return undefined;
};

/** Provider metadata only. No ownership, rights, URL-fetch admission or publication intent. */
export const normalizeFlickrProviderPhoto = (value: Record<string, unknown>, albumIds: string[]): FlickrManifestPhoto => {
  const remoteId = String(value.id || '');
  const owner = String(value.owner || value.pathalias || 'me');
  return normalizeFlickrPhoto({
    remoteId,
    remoteUrl: `https://www.flickr.com/photos/${encodeURIComponent(owner)}/${encodeURIComponent(remoteId)}`,
    title: flickrTextContent(value.title), description: flickrTextContent(value.description),
    tags: String(value.tags || '').split(' ').filter(Boolean), albumIds,
    capturedAt: typeof value.datetaken === 'string' ? value.datetaken : undefined,
    uploadedAt: value.dateupload ? new Date(Number(value.dateupload) * 1000).toISOString() : undefined,
    licence: value.license === undefined ? undefined : String(value.license),
    visibility: value.ispublic === 1 ? 'public' : value.isfriend === 1 ? 'friends' : value.isfamily === 1 ? 'family' : 'private',
    previewUrl: typeof value.url_m === 'string' ? value.url_m : undefined,
    originalSourceUrl: typeof value.url_o === 'string' ? value.url_o : undefined,
    originalFilename: typeof value.originalformat === 'string' ? `${remoteId}.${value.originalformat}` : undefined,
    originalSizeBytes: undefined,
    originalAvailable: typeof value.url_o === 'string'
  });
};
