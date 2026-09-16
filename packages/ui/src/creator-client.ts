/** Same-origin creator API client. Credentials are kept in memory, never persisted. */
import type { WorkKind, CreatorAssetRegenerationRequest } from '@ubeeq/core';
export type CreatorImageCoordinateSpace = 'raw' | 'oriented';
export interface CreatorCoverImageControls {
  focalPoint?: { x: number; y: number };
  crops?: Readonly<Record<string, { x: number; y: number; width: number; height: number }>>;
  altText?: string;
}
export interface CreatorCropSourcePreview {
  revision: number; imageId: string; sourceWidth: number; sourceHeight: number; orientation: number;
  width: number; height: number; preview: Blob;
}
export class CreatorClient {
  private token?: string;
  constructor(private readonly request: typeof fetch = fetch, private readonly base = '/api') {}
  async call(path: string, method = 'GET', body?: unknown, options?: { idempotencyKey: string }): Promise<any> {
    const response = await this.request(`${this.base}${path}`, { method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(options ? { 'idempotency-key': options.idempotencyKey } : {}) },
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
  async brandingCropSource(creatorId: string, kind: 'profile' | 'cover'): Promise<CreatorCropSourcePreview> {
    if (kind !== 'profile' && kind !== 'cover') throw new Error('Invalid branding image kind.');
    const value = await this.call(`/studio/creators/${encodeURIComponent(creatorId)}/branding/${kind}-image/crop-source`);
    if (!value || typeof value.imageId !== 'string' || !value.imageId || value.imageId.length > 200 ||
      ![value.revision, value.sourceWidth, value.sourceHeight, value.width, value.height, value.byteLength].every(n => Number.isSafeInteger(n) && n > 0) ||
      !Number.isInteger(value.orientation) || value.orientation < 1 || value.orientation > 8 || value.contentType !== 'image/jpeg' || value.byteLength > 2 * 1024 * 1024 ||
      typeof value.previewBase64 !== 'string' || value.previewBase64.length !== Math.ceil(value.byteLength / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.previewBase64)) throw new Error('Invalid crop source preview.');
    const bytes = Uint8Array.from(atob(value.previewBase64), character => character.charCodeAt(0));
    if (bytes.byteLength !== value.byteLength) throw new Error('Invalid crop source preview length.');
    return { revision: value.revision, imageId: value.imageId, sourceWidth: value.sourceWidth, sourceHeight: value.sourceHeight,
      orientation: value.orientation, width: value.width, height: value.height, preview: new Blob([bytes], { type: 'image/jpeg' }) };
  }
  private setImageCoordinateSpace(query: URLSearchParams, coordinateSpace?: CreatorImageCoordinateSpace) {
    if (coordinateSpace === undefined) return;
    if (coordinateSpace !== 'raw' && coordinateSpace !== 'oriented') throw new Error('Invalid image coordinate space.');
    query.set('coordinateSpace', coordinateSpace);
  }
  private coverImagePath(creatorId: string, expectedRevision?: number, controls?: CreatorCoverImageControls, coordinateSpace?: CreatorImageCoordinateSpace) {
    const query = new URLSearchParams();
    this.setImageCoordinateSpace(query, coordinateSpace);
    if (expectedRevision !== undefined) query.set('expectedRevision', String(expectedRevision));
    if (controls?.focalPoint !== undefined) query.set('focalPoint', JSON.stringify(controls.focalPoint));
    if (controls?.crops !== undefined) query.set('crops', JSON.stringify(controls.crops));
    if (controls?.altText !== undefined) query.set('altText', controls.altText);
    return `/studio/creators/${encodeURIComponent(creatorId)}/branding/cover-image${query.size ? `?${query}` : ''}`;
  }
  coverImage(creatorId: string) { return this.call(this.coverImagePath(creatorId)); }
  removeCoverImage(creatorId: string, expectedRevision: number) { return this.call(this.coverImagePath(creatorId, expectedRevision), 'DELETE'); }
  recropCoverImage(creatorId: string, expectedRevision: number, controls: CreatorCoverImageControls) {
    return this.call(this.coverImagePath(creatorId, expectedRevision, controls), 'PATCH');
  }
  async saveCoverImage(creatorId: string, expectedRevision: number, file: Blob, controls: CreatorCoverImageControls = {}, coordinateSpace?: CreatorImageCoordinateSpace) {
    const response = await this.request(`${this.base}${this.coverImagePath(creatorId, expectedRevision, controls, coordinateSpace)}`, {
      method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: file });
    const result = await response.json();
    if (!response.ok) { if (response.status === 401) this.token = undefined; throw new Error(result.message || 'Cover image save failed.'); }
    return result;
  }
  async coverImagePreview(creatorId: string, variant: string): Promise<Blob> {
    const response = await this.request(`${this.base}${this.coverImagePath(creatorId)}/${encodeURIComponent(variant)}`,
      { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!response.ok) { if (response.status === 401) this.token = undefined; throw new Error('Cover image preview unavailable.'); }
    if (response.headers.get('content-type') !== 'image/jpeg') throw new Error('Unexpected cover image preview format.');
    return response.blob();
  }
  profileImage(creatorId: string) { return this.call(`/studio/creators/${encodeURIComponent(creatorId)}/branding/profile-image`); }
  recropProfileImage(creatorId: string, expectedRevision: number, squareCrop: NonNullable<CreatorAssetRegenerationRequest['squareCrop']>, altText?: string) {
    const query = new URLSearchParams({ expectedRevision: String(expectedRevision), crop: JSON.stringify(squareCrop) });
    if (altText !== undefined) query.set('altText', altText);
    return this.call(`/studio/creators/${encodeURIComponent(creatorId)}/branding/profile-image?${query}`, 'PATCH');
  }
  removeProfileImage(creatorId: string, expectedRevision: number) {
    return this.call(`/studio/creators/${encodeURIComponent(creatorId)}/branding/profile-image?expectedRevision=${expectedRevision}`, 'DELETE');
  }
  async saveProfileImage(creatorId: string, expectedRevision: number, file: Blob, squareCrop?: CreatorAssetRegenerationRequest['squareCrop'], altText = '', coordinateSpace?: CreatorImageCoordinateSpace) {
    const query = new URLSearchParams({ expectedRevision: String(expectedRevision), altText });
    this.setImageCoordinateSpace(query, coordinateSpace);
    if (squareCrop !== undefined) query.set('crop', JSON.stringify(squareCrop));
    const response = await this.request(`${this.base}/studio/creators/${encodeURIComponent(creatorId)}/branding/profile-image?${query}`, {
      method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: file });
    const result = await response.json();
    if (!response.ok) { if (response.status === 401) this.token = undefined; throw new Error(result.message || 'Profile image save failed.'); }
    return result;
  }
  async profileImagePreview(creatorId: string): Promise<Blob> {
    const response = await this.request(`${this.base}/studio/creators/${encodeURIComponent(creatorId)}/branding/profile-image/square512`,
      { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!response.ok) { if (response.status === 401) this.token = undefined; throw new Error('Profile image preview unavailable.'); }
    if (response.headers.get('content-type') !== 'image/jpeg') throw new Error('Unexpected profile image preview format.');
    return response.blob();
  }
  publications(workId: string) { return this.call(`/studio/works/${encodeURIComponent(workId)}/publications`); }
  publishWork(workId: string, expectedRevision: number, idempotencyKey: string) {
    return this.call(`/studio/works/${encodeURIComponent(workId)}/publications`, 'POST', { expectedRevision }, { idempotencyKey });
  }
  withdrawPublication(workId: string, publicationId: string, expectedRevision: number) {
    return this.call(`/studio/works/${encodeURIComponent(workId)}/publications/${encodeURIComponent(publicationId)}`, 'DELETE', { expectedRevision });
  }
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
  works(creatorId: string, query = '', options: { includeDeleted?: boolean } = {}) { return this.call(`/studio/works?creatorId=${encodeURIComponent(creatorId)}&query=${encodeURIComponent(query)}${options.includeDeleted === true ? '&includeDeleted=true' : ''}`); }
  /** Return a retained Work to draft; the server must revalidate aliases and policy. */
  restoreWork(workId: string, revision: number) {
    return this.call(`/studio/works/${encodeURIComponent(workId)}`, 'PATCH', { expectedRevision: revision, status: 'draft' });
  }
  createWork(creatorId: string, title: string, description: string, tags?: string[], kind?: WorkKind) { return this.call('/studio/works', 'POST', { creatorId, title, description, ...(tags === undefined ? {} : { tags }), ...(kind === undefined ? {} : { kind }) }); }
  collections(creatorId: string, options: { includeDeleted?: boolean } = {}) { return this.call(`/studio/collections?creatorId=${encodeURIComponent(creatorId)}${options.includeDeleted === true ? '&includeDeleted=true' : ''}`); }
  restoreCollection(collectionId: string, expectedRevision: number) {
    return this.call(`/studio/collections/${encodeURIComponent(collectionId)}`, 'PATCH', { status: 'draft', expectedRevision });
  }
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
  /** Explicit request only: callers retain the same crop and key for retries.
   * The server remains authoritative for crop validation and admission. */
  regenerateAsset(workId: string, assetId: string, expectedRevision: number, sourceVersionId: string, idempotencyKey: string,
    squareCrop?: CreatorAssetRegenerationRequest['squareCrop']) {
    return this.call(`/studio/works/${encodeURIComponent(workId)}/assets/${encodeURIComponent(assetId)}/regenerate`,
      'POST', { expectedRevision, sourceVersionId, ...(squareCrop === undefined ? {} : { squareCrop }) }, { idempotencyKey });
  }
  detachAsset(workId: string, assetId: string, expectedRevision: number) {
    return this.call(`/studio/works/${encodeURIComponent(workId)}/assets/${encodeURIComponent(assetId)}`, 'DELETE', { expectedRevision });
  }
  setAssetOrder(workId: string, assetIds: string[], expectedRevision: number) {
    return this.call(`/studio/works/${encodeURIComponent(workId)}/asset-order`, 'PUT', { assetIds, expectedRevision });
  }
  setPrimaryAsset(workId: string, assetId: string, expectedRevision: number) {
    return this.call(`/studio/works/${encodeURIComponent(workId)}/primary-asset`, 'PUT', { assetId, expectedRevision });
  }
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
