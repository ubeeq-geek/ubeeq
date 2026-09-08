import { ExternalProviderError, parseRetryAfterSeconds } from './provider-errors.js';
export interface SoundCloudCredentials { clientId: string; clientSecret: string; redirectUri: string; enabled?: boolean }
export interface SoundCloudRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: URLSearchParams; emptyResponse?: boolean; ignoreNotFound?: boolean;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const apiOrigin = 'https://api.soundcloud.com';
export const soundCloudResponseError = (status: number, payload: Record<string, unknown>, retryAfter?: string | null): ExternalProviderError => {
  const message = string(payload.message) || string(payload.error_description) || `SoundCloud request failed (${status})`;
  if (status === 401) return new ExternalProviderError(message, 'authentication_required');
  if (status === 429) return new ExternalProviderError(message, 'rate_limited', parseRetryAfterSeconds(retryAfter));
  if (status >= 500) return new ExternalProviderError(message, 'temporarily_unavailable');
  return new ExternalProviderError(message, 'invalid_response');
};

/** Explicitly invoked transport. No automatic retry, publication or persistence. */
export class SoundCloudTransport {
  constructor(private readonly credentials?: SoundCloudCredentials, private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}
  isConfigured(): boolean { return this.credentials?.enabled !== false && Boolean(this.credentials?.clientId && this.credentials.clientSecret && this.credentials.redirectUri); }
  private admit(): void { if (!this.isConfigured()) throw new ExternalProviderError('SoundCloud is disabled or OAuth is not configured', 'unsupported'); }
  safeNextHref(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const href = string(value);
    if (href) {
      try { const url = new URL(href); if (url.origin === apiOrigin && !url.username && !url.password && !url.hash) return url.toString(); } catch { /* Reject invalid continuation. */ }
    }
    throw new ExternalProviderError('SoundCloud pagination URL was invalid', 'invalid_response');
  }
  async exchangeToken(params: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
    this.admit();
    const response = await this.fetcher('https://secure.soundcloud.com/oauth/token', { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: this.credentials!.clientId, client_secret: this.credentials!.clientSecret }).toString() });
    const payload = record(await response.json().catch(() => ({})));
    if (!response.ok) throw soundCloudResponseError(response.status, payload, response.headers.get('retry-after'));
    const accessToken = string(payload.access_token);
    if (!accessToken) throw new ExternalProviderError('SoundCloud did not return an access token', 'invalid_response');
    const numeric = Number(payload.expires_in), expiresIn = Number.isFinite(numeric) ? numeric : undefined;
    return { accessToken, refreshToken: string(payload.refresh_token), expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined };
  }
  async request(pathOrUrl: string, accessToken: string, options: SoundCloudRequestOptions = {}): Promise<Record<string, unknown>> {
    this.admit();
    const url = pathOrUrl.startsWith('/') ? `${apiOrigin}${pathOrUrl}` : this.safeNextHref(pathOrUrl);
    if (!url) throw new ExternalProviderError('SoundCloud pagination URL was invalid', 'invalid_response');
    const response = await this.fetcher(url, { method: options.method || 'GET', redirect: 'error',
      headers: { Authorization: `OAuth ${accessToken}`, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(options.body ? { body: options.body.toString() } : {}) });
    if (options.ignoreNotFound && response.status === 404) return {};
    const payload = options.emptyResponse && response.ok ? {} : record(await response.json().catch(() => ({})));
    if (!response.ok) throw soundCloudResponseError(response.status, payload, response.headers.get('retry-after'));
    return payload;
  }
}
