import { SoundCloudTransport } from './soundcloud-transport.js';
import { ExternalProviderError } from './provider-errors.js';
import { normalizeSoundCloudComment } from './soundcloud-normalization.js';

export interface SoundCloudTrackUpdate { title?: string; description?: string; tags?: string[]; allowComments?: boolean }

/** Explicit provider operations only: no automatic publication, retry or persistence. */
export class SoundCloudWriteClient {
  constructor(private readonly transport: SoundCloudTransport) {}

  async updateContent(accessToken: string, trackUrn: string, update: SoundCloudTrackUpdate): Promise<void> {
    const form = new URLSearchParams();
    if (update.title !== undefined) form.set('track[title]', update.title);
    if (update.description !== undefined) form.set('track[description]', update.description);
    if (update.tags !== undefined) form.set('track[tag_list]', update.tags.join(' '));
    if (update.allowComments !== undefined) form.set('track[commentable]', String(update.allowComments));
    if (!form.size) return;
    await this.transport.request(`/tracks/${encodeURIComponent(trackUrn)}`, accessToken, { method: 'PUT', body: form });
  }
  async deleteContent(accessToken: string, trackUrn: string): Promise<void> {
    await this.transport.request(`/tracks/${encodeURIComponent(trackUrn)}`, accessToken, { method: 'DELETE', emptyResponse: true, ignoreNotFound: true });
  }
  async postTimedComment(accessToken: string, trackUrn: string, body: string, timestampMs?: number) {
    const form = new URLSearchParams({ 'comment[body]': body });
    if (timestampMs !== undefined) form.set('comment[timestamp]', String(Math.max(0, Math.floor(timestampMs))));
    let payload: Record<string, unknown>;
    try {
      payload = await this.transport.request(`/tracks/${encodeURIComponent(trackUrn)}/comments`, accessToken, { method: 'POST', body: form });
    } catch (error) {
      if (error instanceof ExternalProviderError) throw error;
      throw new ExternalProviderError('SoundCloud comment outcome is unknown; reconcile comments before retrying', 'ambiguous_submission');
    }
    const comment = normalizeSoundCloudComment(payload);
    if (!comment) throw new ExternalProviderError('SoundCloud comment response was incomplete', 'ambiguous_submission');
    return comment;
  }
  likeContent(token: string, id: string): Promise<void> { return this.stateAction(token, `/likes/tracks/${encodeURIComponent(id)}`, 'PUT'); }
  unlikeContent(token: string, id: string): Promise<void> { return this.stateAction(token, `/likes/tracks/${encodeURIComponent(id)}`, 'DELETE'); }
  repostContent(token: string, id: string): Promise<void> { return this.stateAction(token, `/reposts/tracks/${encodeURIComponent(id)}`, 'PUT'); }
  unrepostContent(token: string, id: string): Promise<void> { return this.stateAction(token, `/reposts/tracks/${encodeURIComponent(id)}`, 'DELETE'); }
  followUser(token: string, id: string): Promise<void> { return this.stateAction(token, `/me/followings/${encodeURIComponent(id)}`, 'PUT'); }
  unfollowUser(token: string, id: string): Promise<void> { return this.stateAction(token, `/me/followings/${encodeURIComponent(id)}`, 'DELETE'); }
  private async stateAction(token: string, path: string, method: 'PUT' | 'DELETE'): Promise<void> {
    await this.transport.request(path, token, { method, emptyResponse: true, ignoreNotFound: method === 'DELETE' });
  }
}
