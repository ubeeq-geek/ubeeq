import { resolveUserAgent, type HttpClientOptions } from './connector-credentials.js';


export interface WordPressCredentials {
  siteUrl: string;
  username: string;
  applicationPassword?: string;
  bearerToken?: string;
}

export class WordPressClient {
  constructor(
    private readonly credentials: WordPressCredentials,
    private readonly options?: HttpClientOptions,
    private readonly request: typeof fetch = fetch
  ) {}

  private authHeader(): string {
    if (this.credentials.bearerToken) {
      return `Bearer ${this.credentials.bearerToken}`;
    }
    const token = Buffer.from(`${this.credentials.username}:${this.credentials.applicationPassword || ''}`).toString('base64');
    return `Basic ${token}`;
  }

  async createPost(post: { title: string; content: string; status?: 'publish' | 'draft' | 'pending' | 'private' }): Promise<{ id: number; link: string }> {
    const url = `${this.credentials.siteUrl.replace(/\/$/, '')}/wp-json/wp/v2/posts`;
    const res = await this.request(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        'User-Agent': resolveUserAgent(this.options),
      },
      body: JSON.stringify(post),
    });

    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || typeof data.id !== 'number') {
      throw new Error(String(data.message || 'WordPress post creation failed'));
    }
    return {
      id: data.id,
      link: String(data.link || ''),
    };
  }
}
