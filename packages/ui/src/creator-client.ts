/** Same-origin creator API client. Credentials are kept in memory, never persisted. */
import type { WorkKind } from '@ubeeq/core';
export class CreatorClient {
  private token?: string;
  constructor(private readonly request: typeof fetch = fetch, private readonly base = '/api') {}
  async call(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await this.request(`${this.base}${path}`, { method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = response.status === 204 ? undefined : await response.json();
    if (!response.ok) {
      if (response.status === 401) this.token = undefined;
      throw new Error(value?.message || value?.decision?.code || value?.error || `Request failed (${response.status})`);
    }
    return value;
  }
  async signIn(email: string, password: string) {
    this.token = undefined;
    const session = await this.call('/v1/auth/sign-in', 'POST', { email, password });
    if (typeof session.token !== 'string' || !session.token) throw new Error('Session credential missing.');
    this.token = session.token;
    return session.session;
  }
  async register(email: string, password: string) { await this.call('/v1/auth/sign-up', 'POST', { email, password }); }
  async signOut() { try { await this.call('/v1/auth/sign-out', 'POST'); } finally { this.token = undefined; } }
  creators() { return this.call('/v1/creators/me'); }
  creatorMembers(creatorId: string) { return this.call(`/studio/creators/${encodeURIComponent(creatorId)}/members`); }
  addCreatorMember(creatorId: string, userId: string, role: string) {
    return this.call(`/studio/creators/${encodeURIComponent(creatorId)}/members`, 'POST', { userId, role });
  }
  removeCreatorMember(creatorId: string, userId: string) {
    return this.call(`/studio/creators/${encodeURIComponent(creatorId)}/members/${encodeURIComponent(userId)}`, 'DELETE');
  }
  createCreator(displayName: string) { return this.call('/v1/creators', 'POST', { displayName }); }
  updateCreatorHandle(id: string, expectedRevision: number, handle: string) {
    return this.call(`/studio/creators/${encodeURIComponent(id)}/handle`, 'PATCH', { expectedRevision, handle });
  }
  updateCreator(id: string, expectedRevision: number, fields: { displayName?: string; bio?: string; links?: { label: string; url: string }[] }) {
    return this.call(`/studio/creators/${encodeURIComponent(id)}`, 'PATCH', { ...fields, expectedRevision });
  }
  works(creatorId: string, query = '') { return this.call(`/studio/works?creatorId=${encodeURIComponent(creatorId)}&query=${encodeURIComponent(query)}`); }
  createWork(creatorId: string, title: string, description: string, tags?: string[], kind?: WorkKind) { return this.call('/studio/works', 'POST', { creatorId, title, description, ...(tags === undefined ? {} : { tags }), ...(kind === undefined ? {} : { kind }) }); }
  collections(creatorId: string) { return this.call(`/studio/collections?creatorId=${encodeURIComponent(creatorId)}`); }
  createCollection(creatorId: string, title: string, metadata: { type?: 'collection' | 'gallery' | 'series' | 'playlist'; slug?: string; description?: string } = {}) {
    return this.call('/studio/collections', 'POST', { creatorId, title, type: metadata.type, slug: metadata.slug, description: metadata.description });
  }
  updateCollection(collectionId: string, title: string, metadata: { type?: 'collection' | 'gallery' | 'series' | 'playlist'; slug?: string; description?: string; expectedRevision?: number } = {}) {
    return this.call(`/studio/collections/${encodeURIComponent(collectionId)}`, 'PATCH', { title, type: metadata.type, slug: metadata.slug, description: metadata.description, expectedRevision: metadata.expectedRevision });
  }
  deleteCollection(collectionId: string, expectedRevision?: number) { return this.call(`/studio/collections/${encodeURIComponent(collectionId)}`, 'DELETE', expectedRevision === undefined ? undefined : { expectedRevision }); }
  setCollectionArchived(collectionId: string, archived: boolean, expectedRevision?: number) {
    return this.call(`/studio/collections/${encodeURIComponent(collectionId)}`, 'PATCH', { status: archived ? 'archived' : 'draft', expectedRevision });
  }
  setCollectionCover(collectionId: string, coverAssetId: string, expectedRevision: number) {
    return this.call(`/studio/collections/${encodeURIComponent(collectionId)}`, 'PATCH', { coverAssetId, expectedRevision });
  }
  async collectionCover(collectionId: string): Promise<Blob> {
    const response = await this.request(`${this.base}/studio/collections/${encodeURIComponent(collectionId)}/cover`,
      { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!response.ok) { if (response.status === 401) this.token = undefined; throw new Error('Collection cover preview unavailable.'); }
    if (response.headers.get('content-type') !== 'image/jpeg') throw new Error('Unexpected cover preview format.');
    return response.blob();
  }
  replaceCollectionWorks(collectionId: string, workIds: string[], expectedWorkIds?: string[]) { return this.call(`/studio/collections/${encodeURIComponent(collectionId)}/works`, 'PUT', { workIds, expectedWorkIds }); }
  updateWork(workId: string, revision: number, title: string, description: string, tags?: string[], metadata: { slug?: string } = {}) { return this.call(`/studio/works/${encodeURIComponent(workId)}`, 'PATCH', { expectedRevision: revision, title, description, ...(tags === undefined ? {} : { tags }), ...(metadata.slug === undefined ? {} : { slug: metadata.slug }) }); }
  setWorkArchived(workId: string, revision: number, archived: boolean) {
    return this.call(`/studio/works/${encodeURIComponent(workId)}`, 'PATCH', { expectedRevision: revision, status: archived ? 'archived' : 'draft' });
  }
  /** Soft-delete from the creator library; retained originals are not erased. */
  deleteWork(workId: string, revision: number) {
    return this.call(`/studio/works/${encodeURIComponent(workId)}`, 'PATCH', { expectedRevision: revision, status: 'deleted' });
  }
  updateWorkBody(workId: string, revision: number, body: unknown[]) {
    return this.call(`/studio/works/${encodeURIComponent(workId)}`, 'PATCH', { expectedRevision: revision, body });
  }
  assets(workId: string) { return this.call(`/studio/works/${encodeURIComponent(workId)}/assets`); }
  async downloadOriginal(workId: string, assetId: string): Promise<Blob> {
    const response = await this.request(`${this.base}/studio/works/${encodeURIComponent(workId)}/assets/${encodeURIComponent(assetId)}/content`,
      { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!response.ok) { if (response.status === 401) this.token = undefined; throw new Error('Original download unavailable.'); }
    if (response.headers.get('content-type') !== 'application/octet-stream') throw new Error('Unexpected original download format.');
    return response.blob();
  }
  async upload(workId: string, file: Blob, filename: string) {
    const response = await this.request(`${this.base}/studio/works/${encodeURIComponent(workId)}/assets?originalFilename=${encodeURIComponent(filename)}`, {
      method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: file });
    const result = await response.json();
    if (!response.ok) { if (response.status === 401) this.token = undefined; throw new Error(result.message || result.error || 'Upload failed.'); }
    return result;
  }
  async preview(workId: string, assetId: string, renditionId: string): Promise<Blob> {
    const response = await this.request(`${this.base}/studio/works/${encodeURIComponent(workId)}/assets/${encodeURIComponent(assetId)}/renditions/${encodeURIComponent(renditionId)}/content`,
      { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!response.ok) { if (response.status === 401) this.token = undefined; throw new Error('Preview unavailable.'); }
    if (response.headers.get('content-type') !== 'image/jpeg') throw new Error('Unexpected preview format.');
    return response.blob();
  }
}
