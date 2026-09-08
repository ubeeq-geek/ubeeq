import { requestVimeo, VimeoApiError } from './vimeo-request.js';

export interface VimeoTokens { accessToken: string; refreshToken?: string; expiresAt?: string; scopes: string[]; }
export interface VimeoCodeExchange { code: string; clientId: string; clientSecret: string; redirectUri: string; }

/** Caller owns state replay prevention, credential selection and token storage. */
export class VimeoOAuthClient {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly apiBase = 'https://api.vimeo.com') {}

  async exchangeCode(input: VimeoCodeExchange): Promise<VimeoTokens> {
    const response = await requestVimeo(this.fetcher, `${this.apiBase}/oauth/access_token`, {
      method: 'POST', headers: {
        authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded', accept: 'application/vnd.vimeo.*+json;version=3.4'
      }, body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri })
    });
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new VimeoApiError('Vimeo returned no access token', 502, false);
    const value = payload as Record<string, unknown>;
    if (typeof value.access_token !== 'string' || !value.access_token.trim()) throw new VimeoApiError('Vimeo returned no access token', 502, false);
    const seconds = typeof value.expires_in === 'number' || typeof value.expires_in === 'string' ? Number(value.expires_in) : NaN;
    const expiry = new Date(Date.now() + seconds * 1000);
    return {
      accessToken: value.access_token,
      refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : undefined,
      expiresAt: Number.isFinite(seconds) && seconds > 0 && Number.isFinite(expiry.getTime()) ? expiry.toISOString() : undefined,
      scopes: typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : []
    };
  }
}
