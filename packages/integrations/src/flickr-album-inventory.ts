import type { FlickrClient, FlickrOAuthCredentials } from './flickr-client.js';
import type { FlickrExternalCollection } from './flickr-migration-state.js';
import { flickrTextContent } from './flickr-metadata.js';

export interface FlickrAlbumInventory {
  phase: 'albums' | 'members' | 'complete';
  page: number;
  albumIndex: number;
  albums: FlickrExternalCollection[];
}
export const initialFlickrAlbumInventory = (): FlickrAlbumInventory => ({ phase: 'albums', page: 1, albumIndex: 0, albums: [] });

/** One provider page per call. The application admits, persists and fences checkpoints. */
export async function advanceFlickrAlbumInventory(client: Pick<FlickrClient, 'albumsPage' | 'albumPhotoIdsPage'>,
  credentials: FlickrOAuthCredentials, previous: FlickrAlbumInventory): Promise<FlickrAlbumInventory> {
  const next = structuredClone(previous);
  if (next.phase === 'complete') return next;
  if (!['albums', 'members'].includes(next.phase) || !Number.isSafeInteger(next.page) || next.page < 1
    || !Number.isSafeInteger(next.albumIndex) || next.albumIndex < 0) throw new Error('Invalid Flickr album checkpoint');
  if (next.phase === 'albums') {
    const result = await client.albumsPage(credentials, next.page);
    const seen = new Set(next.albums.map(album => album.remoteAlbumId));
    for (const album of result.albums) {
      const id = album.id as string;
      if (seen.has(id)) throw new Error('Flickr album inventory changed across pages');
      seen.add(id);
      next.albums.push({ remoteAlbumId: id, title: flickrTextContent(album.title) || 'Untitled album',
        description: flickrTextContent(album.description), orderedRemotePhotoIds: [] });
    }
    if (result.page < result.pages) next.page++;
    else { next.page = 1; next.phase = next.albums.length ? 'members' : 'complete'; }
  } else {
    const album = next.albums[next.albumIndex];
    if (!album) throw new Error('Invalid Flickr album checkpoint');
    const result = await client.albumPhotoIdsPage(credentials, album.remoteAlbumId, next.page);
    const seen = new Set(album.orderedRemotePhotoIds);
    for (const id of result.photoIds) {
      if (seen.has(id)) throw new Error('Flickr album membership changed across pages');
      seen.add(id); album.orderedRemotePhotoIds.push(id);
    }
    if (result.page < result.pages) next.page++;
    else { next.page = 1; next.albumIndex++; if (next.albumIndex === next.albums.length) next.phase = 'complete'; }
  }
  return next;
}
