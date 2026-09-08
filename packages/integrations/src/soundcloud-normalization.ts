const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const identifier = (value: unknown): string | undefined => string(value) ?? (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined);
const number = (value: unknown): number | undefined => Number.isFinite(Number(value)) ? Number(value) : undefined;
const date = (value: unknown): string | undefined => {
  const numeric = number(value);
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    if (!numeric) return undefined;
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
  }
  const raw = string(value); if (!raw) return undefined;
  const parsed = Date.parse(raw); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

/** Metadata-only external reference: never supplies a canonical audio source. */
export const normalizeSoundCloudTrack = (value: unknown) => {
  const track = record(value), externalContentId = string(track.urn) || identifier(track.id);
  if (!externalContentId) return null;
  const tags = (string(track.tag_list) || '').match(/"[^"]+"|\S+/g)?.map(tag => tag.replace(/^"|"$/g, '')) || [];
  const access = string(track.access);
  return {
    externalContentId, externalUrl: string(track.permalink_url), title: string(track.title) || 'Untitled SoundCloud track',
    description: string(track.description), tags, assetType: 'audio' as const, publishedAt: date(track.created_at),
    remoteCreatedAt: date(track.created_at), remoteUpdatedAt: date(track.last_modified), collectionExternalIds: [] as string[],
    remoteState: access === 'blocked' ? 'restricted' as const : 'active' as const,
    ...(access === 'blocked' ? { remoteStateReason: 'Blocked by SoundCloud' } : {}),
    metrics: { views: number(track.playback_count), favourites: number(track.likes_count), comments: number(track.comment_count), downloads: number(track.download_count), other: { reposts: number(track.reposts_count) } },
    rawMetadata: track
  };
};

export const normalizeSoundCloudComment = (value: unknown) => {
  const comment = record(value), id = string(comment.urn) || identifier(comment.id);
  if (!id) return null;
  const user = record(comment.user);
  return {
    externalCommentId: id, authorId: string(user.urn) || identifier(user.id), authorName: string(user.username), authorAvatarUrl: string(user.avatar_url),
    body: string(comment.body) || '', createdAt: date(comment.created_at),
    parentExternalCommentId: string(comment.parent_comment_urn) || identifier(comment.parent_id),
    positionMilliseconds: number(comment.timestamp), rawPayload: comment
  };
};

export const normalizeSoundCloudActivity = (value: unknown) => {
  const event = record(value), origin = record(event.origin);
  const track = Object.keys(record(event.track)).length ? record(event.track) : record(origin.track);
  const user = Object.keys(record(event.user)).length ? record(event.user) : record(origin.user);
  const eventId = string(event.urn) || identifier(event.id), trackId = string(track.urn) || identifier(track.id), actorId = string(user.urn) || identifier(user.id);
  const type = string(event.type) || 'activity', occurredAt = date(event.created_at) || date(event.createdAt);
  const stableId = eventId || [type, actorId, trackId, occurredAt].filter(Boolean).join(':');
  if (!stableId) return null;
  return {
    remoteActivityId: `soundcloud:${stableId}`, sourceMessageId: stableId, type: type.includes('like') ? 'favourite' as const : 'activity' as const,
    occurredAt, actorId, actorName: string(user.username), actorAvatarUrl: string(user.avatar_url), externalContentId: trackId,
    body: string(event.message) || string(track.title), rawPayload: event
  };
};
