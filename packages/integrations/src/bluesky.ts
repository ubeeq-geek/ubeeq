import { resolveUserAgent, type HttpClientOptions } from './connector-credentials.js';

export interface BlueskyPostRecord {
  text: string;
  createdAt: string;
  facets?: Array<{
    index: { byteStart: number; byteEnd: number };
    features: Array<{ $type: string; uri?: string; did?: string; tag?: string }>;
  }>;
  embed?: {
    $type: string;
    images?: Array<{
      alt: string;
      image: { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number };
    }>;
  };
}

export class BlueskyClient {
  private readonly serviceUrl: string;

  constructor(
    serviceUrl = 'https://bsky.social',
    private readonly options?: HttpClientOptions,
    private readonly request: typeof fetch = fetch
  ) {
    this.serviceUrl = serviceUrl.replace(/\/$/, '');
  }

  async createSession(identifier: string, password: string): Promise<{ accessJwt: string; did: string; handle: string }> {
    const res = await this.request(`${this.serviceUrl}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': resolveUserAgent(this.options),
      },
      body: JSON.stringify({ identifier, password }),
    });

    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || typeof data.accessJwt !== 'string' || typeof data.did !== 'string') {
      throw new Error(String(data.message || 'Failed to authenticate with Bluesky / AT Protocol'));
    }
    return {
      accessJwt: data.accessJwt,
      did: data.did,
      handle: String(data.handle || ''),
    };
  }

  async post(did: string, accessJwt: string, record: BlueskyPostRecord): Promise<{ uri: string; cid: string }> {
    const res = await this.request(`${this.serviceUrl}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessJwt}`,
        'Content-Type': 'application/json',
        'User-Agent': resolveUserAgent(this.options),
      },
      body: JSON.stringify({
        repo: did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          ...record,
        },
      }),
    });

    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || typeof data.uri !== 'string') {
      throw new Error(String(data.message || 'Failed to post to Bluesky'));
    }
    return {
      uri: data.uri,
      cid: String(data.cid || ''),
    };
  }
}
