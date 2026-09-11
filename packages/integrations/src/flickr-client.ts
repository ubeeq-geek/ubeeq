import { createHmac, randomBytes } from 'crypto';

type FetchLike = typeof fetch;
export type FlickrOAuthCredentials = { token: string; tokenSecret: string };

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

  constructor(private apiKey: string, private apiSecret: string, private fetcher: FetchLike = fetch, private minimumIntervalMs = 0) {}

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
    const response = await this.fetcher(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(parameters) });
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
      response = await this.fetcher(`${this.restUrl}?${form(parameters)}`);
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
    const payload = await this.rest('flickr.people.getPhotos', credentials, {
      user_id: 'me', page: String(page), per_page: String(Math.min(500, perPage)),
      extras: 'description,date_upload,date_taken,license,tags,url_m,url_o,original_format,o_dims,media,path_alias'
    });
    const photos = payload.photos as { page?: number; pages?: number; photo?: Array<Record<string, unknown>> } | undefined;
    return { page: Number(photos?.page || page), pages: Number(photos?.pages || page), photos: photos?.photo || [] };
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
