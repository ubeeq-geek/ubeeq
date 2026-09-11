import { requestVimeo, VimeoApiError } from './vimeo-request.js';

export interface VimeoPrivacyUpdate { privacy: string; embedDomains: string[]; downloadsAllowed: boolean; }
export interface VimeoVideoUpdate extends VimeoPrivacyUpdate { title: string; description?: string; }

/** One-shot operations. Caller owns confirmation, policy and uncertain-write recovery. */
export class VimeoWriteClient {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly apiBase = 'https://api.vimeo.com') {}

  private async write(path: string, accessToken: string, method: 'DELETE' | 'PATCH', body?: object): Promise<void> {
    if (path !== '/tokens' && !/^\/videos\/[0-9]+$/.test(path)) throw new VimeoApiError('Invalid Vimeo video URI', 400, false);
    await requestVimeo(this.fetcher, `${this.apiBase}${path}`, { method,
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.vimeo.*+json;version=3.4', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }

  revokeAccessToken(accessToken: string): Promise<void> { return this.write('/tokens', accessToken, 'DELETE'); }
  deleteVideo(accessToken: string, videoUri: string): Promise<void> {
    if (!/^\/videos\/[0-9]+$/.test(videoUri)) return Promise.reject(new VimeoApiError('Invalid Vimeo video URI', 400, false));
    return this.write(videoUri, accessToken, 'DELETE');
  }
  configurePrivacy(accessToken: string, videoUri: string, input: VimeoPrivacyUpdate): Promise<void> {
    return this.configure(accessToken, videoUri, input);
  }
  configureVideo(accessToken: string, videoUri: string, input: VimeoVideoUpdate): Promise<void> {
    return this.configure(accessToken, videoUri, input, { name: input.title, description: input.description });
  }
  private async configure(accessToken: string, videoUri: string, input: VimeoPrivacyUpdate, metadata: object = {}): Promise<void> {
    if (!/^\/videos\/[0-9]+$/.test(videoUri)) throw new VimeoApiError('Invalid Vimeo video URI', 400, false);
    await this.write(videoUri, accessToken, 'PATCH', { ...metadata,
      privacy: { view: input.privacy, download: input.downloadsAllowed }, embed: { domains: input.embedDomains }
    });
  }
}
