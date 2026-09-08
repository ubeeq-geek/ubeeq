import { normalizeVimeoAccount, normalizeVimeoVideoPage, type VimeoAccount, type VimeoRemoteVideo } from './vimeo-metadata.js';
import { requestVimeo, VimeoApiError } from './vimeo-request.js';

/** Metadata reads only. Callers select credentials, admission and scan budgets. */
export class VimeoReadClient {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly apiBase = 'https://api.vimeo.com') {}

  private request(path: string, accessToken: string): Promise<Response> {
    return requestVimeo(this.fetcher, `${this.apiBase}${path}`, { headers: {
      authorization: `Bearer ${accessToken}`, accept: 'application/vnd.vimeo.*+json;version=3.4', 'content-type': 'application/json'
    } });
  }

  async account(accessToken: string): Promise<VimeoAccount> {
    const response = await this.request('/me', accessToken);
    try { return normalizeVimeoAccount(await response.json()); }
    catch { throw new VimeoApiError('Vimeo returned invalid account metadata', 502, false); }
  }

  async listVideos(accessToken: string, page = 1, perPage = 50): Promise<{ videos: VimeoRemoteVideo[]; nextPage?: number }> {
    if (!Number.isSafeInteger(page) || page < 1 || page === Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(perPage)) throw new VimeoApiError('Invalid Vimeo page request', 400, false);
    const query = new URLSearchParams({ page: String(page), per_page: String(Math.min(100, Math.max(1, perPage))) });
    const response = await this.request(`/me/videos?${query}`, accessToken);
    try { return normalizeVimeoVideoPage(await response.json(), page); }
    catch { throw new VimeoApiError('Vimeo returned an invalid video page', 502, false); }
  }

  async video(accessToken: string, videoUri: string): Promise<Record<string, unknown>> {
    if (!/^\/videos\/[0-9]+$/.test(videoUri)) throw new VimeoApiError('Invalid Vimeo video URI', 400, false);
    const response = await this.request(videoUri, accessToken);
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VimeoApiError('Vimeo returned invalid video metadata', 502, false);
    return value as Record<string, unknown>;
  }
}
