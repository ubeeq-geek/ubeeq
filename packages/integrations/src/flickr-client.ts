import { createHmac, randomBytes } from 'crypto';
import { readBoundedResponseText } from './bounded-response-text.js';

type FetchLike = typeof fetch;
export type FlickrOAuthCredentials = { token: string; tokenSecret: string };
export interface FlickrRequestLimits { timeoutMs?: number; maxResponseBytes?: number }

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

const oauthParameters = (consumerKey: string, token?: string) => ({
  oauth_consumer_key: consumerKey,
  oauth_nonce: randomBytes(16).toString('hex'),
  oauth_signature_method: 'HMAC-SHA1',
  oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
  ...(token ? { oauth_token: token } : {}),
  oauth_version: '1.0'
});

const signedParameters = (method: string, url: string, parameters: Record<string, string>, consumerSecret: string, tokenSecret = '') => {
  const normalized = Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
  const signatureBase = [method.toUpperCase(), encode(url), encode(normalized)].join('&');
  const signature = createHmac('sha1', `${encode(consumerSecret)}&${encode(tokenSecret)}`).update(signatureBase).digest('base64');
  return { ...parameters, oauth_signature: signature };
};

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

export interface FlickrInventoryPage {
  page: number;
  pages: number;
  photos: Array<Record<string, unknown>>;
}

/** Minimal Flickr OAuth 1.0a/read API client. It never sends credentials to the browser. */
export class FlickrClient {
  private readonly requestTokenUrl = 'https://www.flickr.com/services/oauth/request_token';
  private readonly accessTokenUrl = 'https://www.flickr.com/services/oauth/access_token';
  private readonly restUrl = 'https://www.flickr.com/services/rest';

  private requestGate: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private apiKey: string, private apiSecret: string, private fetcher: FetchLike = fetch, private minimumIntervalMs = 0, limits: FlickrRequestLimits = {}) {
    this.timeoutMs = limits.timeoutMs ?? 30_000;
    this.maxResponseBytes = limits.maxResponseBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000
      || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 16 * 1024 * 1024) throw new Error('Invalid Flickr request limits');
  }

  private async request(url: string, init: RequestInit = {}) {
    const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    let body = '';
    try { body = await readBoundedResponseText(response, this.maxResponseBytes); }
    catch (error) {
      if (response.ok) throw error;
      // Preserve HTTP status/retry classification even when an error body is oversized.
    }
    return new Response(body || null, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  private async pace() {
    const previous = this.requestGate;
    let release!: () => void;
    this.requestGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const delay = Math.max(0, this.nextRequestAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    this.nextRequestAt = Date.now() + Math.max(0, this.minimumIntervalMs);
    release();
  }

  private async tokenRequest(url: string, extra: Record<string, string>, credentials?: FlickrOAuthCredentials) {
    const parameters = signedParameters('POST', url, { ...oauthParameters(this.apiKey, credentials?.token), ...extra }, this.apiSecret, credentials?.tokenSecret);
    const response = await this.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(parameters) });
    if (!response.ok) throw new Error(`Flickr OAuth request failed (${response.status})`);
    const result = new URLSearchParams(await response.text());
    if (!result.get('oauth_token') || !result.get('oauth_token_secret')) throw new Error('Flickr OAuth response was incomplete');
    return result;
  }

  requestToken(callbackUrl: string) { return this.tokenRequest(this.requestTokenUrl, { oauth_callback: callbackUrl }); }
  accessToken(requestToken: string, requestTokenSecret: string, verifier: string) {
    return this.tokenRequest(this.accessTokenUrl, { oauth_verifier: verifier }, { token: requestToken, tokenSecret: requestTokenSecret });
  }

  private async rest(method: string, credentials: FlickrOAuthCredentials, values: Record<string, string>) {
    const parameters = signedParameters('GET', this.restUrl, {
      ...oauthParameters(this.apiKey, credentials.token), method, format: 'json', nojsoncallback: '1', ...values
    }, this.apiSecret, credentials.tokenSecret);
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.pace();
      response = await this.request(`${this.restUrl}?${form(parameters)}`);
      if (response.ok) break;
      if (response.status !== 429 && response.status < 500) throw new Error(`Flickr API request failed (${response.status})`);
      if (attempt < 2) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 5000)));
      }
    }
    if (!response?.ok) throw new Error(`Flickr API request failed (${response?.status || 'unavailable'})`);
    const payload = await response.json() as Record<string, unknown>;
    if (payload.stat === 'fail') throw new Error(`Flickr API error ${String(payload.code || 'unknown')}`);
    return payload;
  }

  async inventoryPage(credentials: FlickrOAuthCredentials, page: number, perPage = 100): Promise<FlickrInventoryPage> {
    if (!Number.isSafeInteger(page) || page < 1 || page === Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(perPage) || perPage < 1) throw new Error('Invalid Flickr inventory pagination');
    const payload = await this.rest('flickr.people.getPhotos', credentials, {
      user_id: 'me', page: String(page), per_page: String(Math.min(500, perPage)),
      extras: 'description,date_upload,date_taken,license,tags,url_m,url_o,original_format,o_dims,media,path_alias'
    });
    const photos = payload?.photos as { page?: unknown; pages?: unknown; photo?: unknown } | undefined;
    const integer = (value: unknown): number => typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)) ? Number(value) : NaN;
    const returnedPage = integer(photos?.page), pages = integer(photos?.pages);
    if (!photos || typeof photos !== 'object' || Array.isArray(photos) || returnedPage !== page
      || !Number.isSafeInteger(pages) || pages < 0 || pages === Number.MAX_SAFE_INTEGER
      || !Array.isArray(photos.photo) || photos.photo.length > Math.min(500, perPage)
      || (pages < page && !(page === 1 && pages === 0 && photos.photo.length === 0))) throw new Error('Invalid Flickr inventory response');
    const ids = new Set<string>();
    for (const photo of photos.photo) {
      if (!photo || typeof photo !== 'object' || Array.isArray(photo) || typeof photo.id !== 'string' || !photo.id.trim() || ids.has(photo.id)) throw new Error('Invalid Flickr inventory photo');
      ids.add(photo.id);
    }
    return { page: returnedPage, pages, photos: photos.photo as Array<Record<string, unknown>> };
  }

  async albums(credentials: FlickrOAuthCredentials): Promise<Array<Record<string, unknown>>> {
    const albums: Array<Record<string, unknown>> = [];
    let page = 1; let pages = 1;
    do {
      const payload = await this.rest('flickr.photosets.getList', credentials, { user_id: 'me', per_page: '500', page: String(page) });
      const result = payload.photosets as { page?: number; pages?: number; photoset?: Array<Record<string, unknown>> } | undefined;
      albums.push(...(result?.photoset || [])); pages = Number(result?.pages || page); page += 1;
    } while (page <= pages);
    return albums;
  }

  /** One provider request. Callers persist continuation rather than walking the whole catalogue. */
  async albumsPage(credentials: FlickrOAuthCredentials, page: number, perPage = 100): Promise<{ page: number; pages: number; albums: Array<Record<string, unknown>> }> {
    this.validateAlbumPageRequest(page, perPage);
    const payload = await this.rest('flickr.photosets.getList', credentials, { user_id: 'me', page: String(page), per_page: String(perPage) });
    const result = this.validateAlbumPage(payload.photosets, 'photoset', page, perPage);
    return { page, pages: result.pages, albums: result.items };
  }

  /** One provider request; preserves provider ordering and rejects incomplete item identities. */
  async albumPhotoIdsPage(credentials: FlickrOAuthCredentials, albumId: string, page: number, perPage = 100): Promise<{ page: number; pages: number; photoIds: string[] }> {
    this.validateAlbumPageRequest(page, perPage);
    if (typeof albumId !== 'string' || !albumId.trim() || albumId.length > 200) throw new Error('Invalid Flickr album identity');
    const payload = await this.rest('flickr.photosets.getPhotos', credentials, { photoset_id: albumId, user_id: 'me', page: String(page), per_page: String(perPage) });
    const result = this.validateAlbumPage(payload.photoset, 'photo', page, perPage);
    const returnedId = (payload.photoset as { id?: unknown }).id;
    if (returnedId !== albumId) throw new Error('Invalid Flickr album response identity');
    return { page, pages: result.pages, photoIds: result.items.map(item => item.id as string) };
  }

  private validateAlbumPageRequest(page: number, perPage: number) {
    if (!Number.isSafeInteger(page) || page < 1 || page === Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 500) throw new Error('Invalid Flickr album pagination');
  }

  private validateAlbumPage(value: unknown, field: 'photo' | 'photoset', requestedPage: number, limit: number): { pages: number; items: Array<Record<string, unknown>> } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Flickr album page');
    const record = value as Record<string, unknown>;
    const integer = (input: unknown): number => typeof input === 'number' || (typeof input === 'string' && /^\d+$/.test(input)) ? Number(input) : NaN;
    const page = integer(record.page), pages = integer(record.pages), items = record[field];
    if (page !== requestedPage || !Number.isSafeInteger(pages) || pages < 0 || pages === Number.MAX_SAFE_INTEGER
      || !Array.isArray(items) || items.length > limit
      || (pages < page && !(page === 1 && pages === 0 && items.length === 0))) throw new Error('Invalid Flickr album page');
    const seen = new Set<string>();
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)) throw new Error('Invalid Flickr album page item');
      seen.add(item.id);
    }
    return { pages, items: items as Array<Record<string, unknown>> };
  }

  async albumPhotoIds(credentials: FlickrOAuthCredentials, albumId: string): Promise<string[]> {
    const ids: string[] = []; let page = 1; let pages = 1;
    do {
      const payload = await this.rest('flickr.photosets.getPhotos', credentials, { photoset_id: albumId, user_id: 'me', per_page: '500', page: String(page) });
      const result = payload.photoset as { page?: number; pages?: number; photo?: Array<{ id?: string }> } | undefined;
      ids.push(...((result?.photo || []).map((photo) => String(photo.id || '')).filter(Boolean))); pages = Number(result?.pages || page); page += 1;
    } while (page <= pages);
    return ids;
  }
}
