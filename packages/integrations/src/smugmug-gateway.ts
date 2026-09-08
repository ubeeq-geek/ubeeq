import { createHmac, randomBytes, randomUUID } from 'crypto';
import type { SmugMugCapabilities, SmugMugGateway, SmugMugInventoryPage, SmugMugRemoteCollection, SmugMugRemoteImage } from './smugmug-contracts.js';

export interface SmugMugOAuthCredential { token: string; tokenSecret: string; }

/** Credential storage is deliberately separate from migration records so tokens can be
 * encrypted, rotated, and destroyed without deleting imported catalogue data. */
export interface SmugMugCredentialVault {
  put(credential: SmugMugOAuthCredential): Promise<string>;
  get(reference: string): Promise<SmugMugOAuthCredential | undefined>;
  replace(reference: string, credential: SmugMugOAuthCredential): Promise<string>;
  delete(reference: string): Promise<void>;
}

export interface SmugMugHttpGatewayOptions {
  apiKey: string;
  apiSecret: string;
  callbackUrl: string;
  vault: SmugMugCredentialVault;
  fetch?: typeof fetch;
  apiOrigin?: string;
  oauthOrigin?: string;
}

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const oauthHeader = (method: string, url: string, consumerSecret: string, tokenSecret: string, parameters: Record<string, string>) => {
  const normalized = Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
  const base = [method.toUpperCase(), encode(url), encode(normalized)].join('&');
  const signature = createHmac('sha1', `${encode(consumerSecret)}&${encode(tokenSecret)}`).update(base).digest('base64');
  return `OAuth ${Object.entries({ ...parameters, oauth_signature: signature }).filter(([key]) => key.startsWith('oauth_')).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encode(key)}="${encode(value)}"`).join(', ')}`;
};

const scalar = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** SmugMug API v2 gateway. Callers own admission for every read or mutation. */
export class SmugMugHttpGateway implements SmugMugGateway {
  private readonly request: typeof fetch;
  private readonly apiOrigin: string;
  private readonly oauthOrigin: string;

  constructor(private readonly options: SmugMugHttpGatewayOptions) {
    this.request = options.fetch || fetch;
    this.apiOrigin = (options.apiOrigin || 'https://api.smugmug.com').replace(/\/$/, '');
    this.oauthOrigin = (options.oauthOrigin || 'https://api.smugmug.com/services/oauth/1.0a').replace(/\/$/, '');
  }

  async startAuthorization(state: string) {
    const callback = new URL(this.options.callbackUrl);
    callback.searchParams.set('state', state);
    const url = `${this.oauthOrigin}/getRequestToken`;
    const body = await this.oauthRequest('POST', url, undefined, { oauth_callback: callback.toString() }, false);
    const token = scalar(body.get('oauth_token'));
    const tokenSecret = scalar(body.get('oauth_token_secret'));
    if (!token || !tokenSecret) throw new Error('SmugMug returned an invalid request token.');
    const credentialRef = await this.options.vault.put({ token, tokenSecret });
    return { authorizationUrl: `${this.oauthOrigin}/authorize?Access=Full&Permissions=Read&oauth_token=${encode(token)}`, credentialRef };
  }

  async completeAuthorization(credentialRef: string, verifier: string) {
    const requestCredential = await this.requiredCredential(credentialRef);
    const url = `${this.oauthOrigin}/getAccessToken`;
    const body = await this.oauthRequest('POST', url, requestCredential, { oauth_verifier: verifier }, false);
    const token = scalar(body.get('oauth_token'));
    const tokenSecret = scalar(body.get('oauth_token_secret'));
    if (!token || !tokenSecret) throw new Error('SmugMug returned an invalid access token.');
    const nextReference = await this.options.vault.replace(credentialRef, { token, tokenSecret });
    const authUser = await this.apiGet('/api/v2!authuser', { token, tokenSecret });
    const response = record(authUser.Response);
    const user = record(response.User);
    const capabilities: SmugMugCapabilities = {
      inventory: true,
      // OAuth alone does not prove that originals are retrievable. Inventory
      // promotes this capability only after an authenticated image advertises it.
      originalDownloads: false,
      exif: true,
      passwordProtectedGalleries: false
    };
    return {
      credentialRef: nextReference,
      accountId: scalar(user.UserID) || scalar(user.Uri) || randomUUID(),
      accountName: scalar(user.NickName) || scalar(user.Name) || 'SmugMug creator',
      capabilities
    };
  }

  async inventory(credentialRef: string, cursor?: string): Promise<SmugMugInventoryPage> {
    const credential = await this.requiredCredential(credentialRef);
    let queue = cursor ? this.decodeCursor(cursor) : [];
    if (!queue.length) {
      const authUser = await this.apiGet('/api/v2!authuser', credential);
      const user = record(record(authUser.Response).User);
      const nodeUri = scalar(record(record(user.Uris).Node).Uri) || scalar(user.NodeUri);
      if (!nodeUri) throw new Error('SmugMug did not expose the authenticated catalogue root.');
      queue = [`${nodeUri}!children`];
    }
    const path = queue.shift()!;
    const payload = await this.apiGet(path, credential);
    const response = record(payload.Response);
    const nodes = (Array.isArray(response.Node) ? response.Node : Array.isArray(response.NodeList) ? response.NodeList : []) as unknown[];
    const images = (Array.isArray(response.AlbumImage) ? response.AlbumImage : []) as unknown[];
    const collections = nodes.map((item, index) => this.mapNode(record(item), index)).filter((item): item is SmugMugRemoteCollection => Boolean(item));
    const mappedImages = images.map((item, index) => this.mapImage(record(item), index)).filter((item): item is SmugMugRemoteImage => Boolean(item));
    const pages = record(response.Pages);
    const providerNext = scalar(pages.NextPage) || scalar(response.NextPage);
    if (providerNext) queue.unshift(providerNext);
    for (const rawNode of nodes) {
      const node = record(rawNode);
      const uris = record(node.Uris);
      const childUri = scalar(record(uris.ChildNodes).Uri) || scalar(record(uris.Node).Uri);
      const albumUri = scalar(record(uris.Album).Uri);
      if (albumUri) queue.push(`${albumUri}!images`);
      else if (childUri && childUri !== path) queue.push(`${childUri}!children`);
    }
    const nextCursor = queue.length ? this.encodeCursor(queue) : undefined;
    return { collections, images: mappedImages, ...(nextCursor ? { nextCursor } : {}) };
  }

  async download(credentialRef: string, image: SmugMugRemoteImage) {
    if (!image.originalAvailable || !image.sourceUrl) throw new Error('The SmugMug original is unavailable.');
    const credential = await this.requiredCredential(credentialRef);
    const response = await this.signedFetch('GET', image.sourceUrl, credential);
    if (!response.ok) throw new Error(`SmugMug source download failed (${response.status}).`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (image.byteSize && contentLength && contentLength !== image.byteSize) throw new Error('SmugMug source download was partial.');
    return { body: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get('content-type')?.split(';')[0] || image.mimeType || 'application/octet-stream' };
  }

  async publish(credentialRef: string, input: { galleryUri: string; body: Buffer; filename: string; mimeType: string; title: string; caption?: string; keywords: string[] }) {
    const credential = await this.requiredCredential(credentialRef);
    const uploadUrl = 'https://upload.smugmug.com/';
    const response = await this.signedFetch('PUT', uploadUrl, credential, {
      'Content-Type': input.mimeType,
      'Content-Length': String(input.body.byteLength),
      'X-Smug-AlbumUri': input.galleryUri,
      'X-Smug-FileName': input.filename,
      'X-Smug-ResponseType': 'JSON',
      'X-Smug-Version': '1.0',
      ...(input.title ? { 'X-Smug-Title': input.title } : {}),
      ...(input.caption ? { 'X-Smug-Caption': input.caption } : {}),
      ...(input.keywords.length ? { 'X-Smug-Keywords': input.keywords.join(',') } : {})
    }, input.body);
    if (!response.ok) throw new Error(`SmugMug upload failed (${response.status}).`);
    const payload = await response.json() as Record<string, unknown>;
    const responseBody = record(payload.Response);
    const image = record(responseBody.Image || payload.Image);
    const remoteId = scalar(image.ImageKey) || scalar(image.Uri);
    if (!remoteId) throw new Error('SmugMug returned an invalid upload response.');
    return { remoteId, remoteUrl: scalar(image.WebUri) || scalar(image.URL), remoteUri: scalar(image.Uri) };
  }

  async updateMetadata(credentialRef: string, input: { remoteUri: string; title: string; caption?: string; keywords: string[] }) {
    if (!input.remoteUri.startsWith('/api/v2/')) throw new Error('SmugMug image URI is invalid.');
    const credential = await this.requiredCredential(credentialRef);
    const body = Buffer.from(JSON.stringify({ Image: { Title: input.title, Caption: input.caption || '', Keywords: input.keywords.join(',') } }));
    const response = await this.signedFetch('PATCH', `${this.apiOrigin}${input.remoteUri}`, credential, { Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength) }, body);
    if (!response.ok) throw new Error(`SmugMug metadata update failed (${response.status}).`);
  }

  deleteCredential(reference: string) { return this.options.vault.delete(reference); }

  private mapNode(node: Record<string, unknown>, index: number): SmugMugRemoteCollection | undefined {
    const remoteId = scalar(node.NodeID) || scalar(node.Uri);
    if (!remoteId) return undefined;
    const type = scalar(node.Type)?.toUpperCase();
    const kind = type === 'ALBUM' ? 'ALBUM' : type === 'FOLDER' ? 'FOLDER' : record(node.Uris).Album ? 'GALLERY' : undefined;
    if (!kind) return undefined;
    const album = record(record(node.Uris).Album);
    return {
      remoteId: scalar(album.AlbumKey) || remoteId, remoteUri: scalar(album.Uri) || scalar(node.Uri), kind, parentRemoteId: scalar(node.ParentNodeID) || scalar(node.ParentUri), title: scalar(node.Name) || scalar(node.Title) || 'Untitled',
      description: scalar(node.Description), position: number(node.SortIndex) ?? index,
      privacy: { visibility: node.Privacy, securityType: node.SecurityType, unlisted: node.UrlName === undefined }
    };
  }

  private mapImage(image: Record<string, unknown>, index: number): SmugMugRemoteImage | undefined {
    const remoteId = scalar(image.ImageKey) || scalar(image.ArchivedUri) || scalar(image.Uri);
    const galleryId = scalar(image.AlbumKey) || scalar(image.AlbumUri);
    const url = scalar(image.WebUri) || scalar(image.Uri);
    if (!remoteId || !galleryId || !url) return undefined;
    const sourceUrl = scalar(image.OriginalImageUrl) || scalar(image.ArchivedUri);
    const keywords = Array.isArray(image.Keywords) ? image.Keywords.filter((item): item is string => typeof item === 'string') : scalar(image.Keywords)?.split(/[;,]/).map((item) => item.trim()).filter(Boolean) || [];
    return {
      remoteId, galleryId, url, filename: scalar(image.FileName), title: scalar(image.Title), caption: scalar(image.Caption), keywords,
      capturedAt: scalar(image.DateTimeOriginal), position: number(image.SortIndex) ?? index, byteSize: number(image.OriginalSize),
      width: number(image.OriginalWidth), height: number(image.OriginalHeight), mimeType: scalar(image.Format) ? `image/${scalar(image.Format)!.toLowerCase()}` : undefined,
      checksum: scalar(image.MD5Sum), checksumAlgorithm: scalar(image.MD5Sum) ? 'md5' : undefined, originalAvailable: Boolean(sourceUrl) && image.CanDownload !== false, sourceUrl,
      privacy: { visibility: image.Privacy, hidden: image.Hidden }, licence: { copyright: image.Copyright, licence: image.License }, exif: record(image.EXIF)
    };
  }

  private async apiGet(path: string, credential: SmugMugOAuthCredential) {
    const url = path.startsWith('http') ? path : `${this.apiOrigin}${path}`;
    const response = await this.signedFetch('GET', url, credential, { Accept: 'application/json' });
    if (!response.ok) throw new Error(`SmugMug API request failed (${response.status}).`);
    return await response.json() as Record<string, unknown>;
  }

  private encodeCursor(queue: string[]) {
    return `smugmug:v1:${Buffer.from(JSON.stringify(queue), 'utf8').toString('base64url')}`;
  }

  private decodeCursor(cursor: string): string[] {
    if (!cursor.startsWith('smugmug:v1:')) throw new Error('SmugMug inventory cursor is invalid.');
    try {
      const parsed = JSON.parse(Buffer.from(cursor.slice('smugmug:v1:'.length), 'base64url').toString('utf8'));
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.startsWith('/api/v2'))) throw new Error();
      return parsed;
    } catch {
      throw new Error('SmugMug inventory cursor is invalid.');
    }
  }

  private async signedFetch(method: string, url: string, credential: SmugMugOAuthCredential, headers: Record<string, string> = {}, body?: Buffer) {
    const parsed = new URL(url);
    const query = Object.fromEntries(parsed.searchParams.entries());
    parsed.search = '';
    const oauth = this.oauthParameters(credential.token);
    const requestBody = body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer : undefined;
    return this.request(url, { method, headers: { ...headers, Authorization: oauthHeader(method, parsed.toString(), this.options.apiSecret, credential.tokenSecret, { ...query, ...oauth }) }, body: requestBody });
  }

  private async oauthRequest(method: string, url: string, credential?: SmugMugOAuthCredential, extra: Record<string, string> = {}, json = true) {
    const oauth = { ...this.oauthParameters(credential?.token), ...extra };
    const response = await this.request(url, { method, headers: { Authorization: oauthHeader(method, url, this.options.apiSecret, credential?.tokenSecret || '', oauth), ...(json ? { Accept: 'application/json' } : {}) } });
    if (!response.ok) throw new Error(`SmugMug OAuth request failed (${response.status}).`);
    return new URLSearchParams(await response.text());
  }

  private oauthParameters(token?: string): Record<string, string> {
    return { oauth_consumer_key: this.options.apiKey, oauth_nonce: randomBytes(18).toString('base64url'), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: Math.floor(Date.now() / 1000).toString(), oauth_version: '1.0', ...(token ? { oauth_token: token } : {}) };
  }

  private async requiredCredential(reference: string) {
    const credential = await this.options.vault.get(reference);
    if (!credential) throw new Error('SmugMug credential reference is unavailable.');
    return credential;
  }
}
