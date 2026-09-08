import { SoundCloudTransport } from './soundcloud-transport.js';
import { ExternalProviderError } from './provider-errors.js';
import { normalizeSoundCloudAccount, normalizeSoundCloudProfile, normalizeSoundCloudPlaylist, normalizeSoundCloudFavouriteUser,
  normalizeSoundCloudTrack, normalizeSoundCloudComment, normalizeSoundCloudActivity } from './soundcloud-normalization.js';

const collection = (payload: Record<string, unknown>, key = 'collection'): unknown[] => {
  if (!Array.isArray(payload[key])) throw new ExternalProviderError('SoundCloud page collection was missing or malformed', 'invalid_response');
  return payload[key];
};
const normalizePage = <T>(items: unknown[], normalize: (value: unknown) => T | null): T[] => items.map(value => {
  const result = normalize(value);
  if (result === null) throw new ExternalProviderError('SoundCloud page contained an entry without required identity', 'invalid_response');
  return result;
});

/** Provider reads only. Persistence, admission, scheduling and reconciliation belong to the caller. */
export class SoundCloudReadClient {
  constructor(private readonly transport: SoundCloudTransport) {}

  async getAccount(accessToken: string) {
    return normalizeSoundCloudAccount(await this.transport.request('/me', accessToken));
  }
  async getProfile(accessToken: string, userUrn: string) {
    return normalizeSoundCloudProfile(await this.transport.request(`/users/${encodeURIComponent(userUrn)}`, accessToken));
  }
  async listContent(accessToken: string, options: { cursor?: string; limit?: number } = {}) {
    const path = options.cursor || `/me/tracks?linked_partitioning=true&limit=${Math.max(1, Math.min(200, options.limit || 50))}`;
    const payload = await this.transport.request(path, accessToken);
    return { items: normalizePage(collection(payload), normalizeSoundCloudTrack), nextCursor: this.transport.safeNextHref(payload.next_href) };
  }
  async getContent(accessToken: string, trackUrn: string) {
    const result = normalizeSoundCloudTrack(await this.transport.request(`/tracks/${encodeURIComponent(trackUrn)}`, accessToken));
    if (!result) throw new ExternalProviderError('SoundCloud track response was incomplete', 'invalid_response');
    return result;
  }
  async listCollections(accessToken: string) {
    const collections: NonNullable<ReturnType<typeof normalizeSoundCloudPlaylist>>[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined = '/me/playlists?linked_partitioning=true&limit=50';
    for (let page = 0; cursor && page < 20; page++) {
      const canonicalCursor = new URL(cursor, 'https://api.soundcloud.com').toString();
      if (visited.has(canonicalCursor)) throw new ExternalProviderError('SoundCloud playlist pagination repeated a cursor', 'invalid_response');
      visited.add(canonicalCursor);
      const payload = await this.transport.request(cursor, accessToken);
      if (!Array.isArray(payload.collection)) throw new ExternalProviderError('SoundCloud playlist collection response was incomplete', 'invalid_response');
      for (const value of payload.collection) {
        const playlist = normalizeSoundCloudPlaylist(value);
        if (!playlist) throw new ExternalProviderError('SoundCloud playlist identity response was incomplete', 'invalid_response');
        collections.push(playlist);
      }
      cursor = this.transport.safeNextHref(payload.next_href);
    }
    if (cursor) throw new ExternalProviderError('SoundCloud playlist traversal exceeded its page budget; catalogue reconciliation was not performed', 'preflight_blocked');
    return collections;
  }
  async listCollectionContent(accessToken: string, playlistUrn: string, cursor?: string) {
    const payload = await this.transport.request(cursor || `/playlists/${encodeURIComponent(playlistUrn)}`, accessToken);
    const tracks = collection(payload, Object.hasOwn(payload, 'collection') ? 'collection' : 'tracks');
    return { items: normalizePage(tracks, normalizeSoundCloudTrack), nextCursor: this.transport.safeNextHref(payload.next_href) };
  }
  async listComments(accessToken: string, trackUrn: string, cursor?: string) {
    const payload = await this.transport.request(cursor || `/tracks/${encodeURIComponent(trackUrn)}/comments?linked_partitioning=true&limit=100`, accessToken);
    return { items: normalizePage(collection(payload), normalizeSoundCloudComment), nextCursor: this.transport.safeNextHref(payload.next_href) };
  }
  async listFavourites(accessToken: string, trackUrn: string, cursor?: string) {
    const payload = await this.transport.request(cursor || `/tracks/${encodeURIComponent(trackUrn)}/favoriters?linked_partitioning=true&limit=100`, accessToken);
    return { items: normalizePage(collection(payload), normalizeSoundCloudFavouriteUser), nextCursor: this.transport.safeNextHref(payload.next_href) };
  }
  async listFeed(accessToken: string, cursor?: string) {
    const payload = await this.transport.request(cursor || '/me/feed?linked_partitioning=true&limit=50', accessToken);
    return { items: normalizePage(collection(payload), normalizeSoundCloudActivity), nextCursor: this.transport.safeNextHref(payload.next_href) };
  }
}
