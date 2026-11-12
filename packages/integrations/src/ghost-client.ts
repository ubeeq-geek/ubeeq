import { createHmac } from 'node:crypto';
import { resolveUserAgent, type HttpClientOptions } from './connector-credentials.js';

export interface GhostAdminCredentials {
  apiUrl: string;
  adminApiKey: string; // id:secret
}

export class GhostClient {
  constructor(
    private readonly credentials: GhostAdminCredentials,
    private readonly options?: HttpClientOptions,
    private readonly request: typeof fetch = fetch
  ) {}

  private generateToken(): string {
    const [id, secret] = this.credentials.adminApiKey.split(':');
    if (!id || !secret) throw new Error('Invalid Ghost Admin API key format (expected id:secret)');

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).toString('base64url');
    const secretBuffer = Buffer.from(secret, 'hex');
    const signature = createHmac('sha256', secretBuffer).update(`${header}.${payload}`).digest('base64url');

    return `${header}.${payload}.${signature}`;
  }

  async createPost(post: { title: string; lexical?: string; html?: string; status?: 'published' | 'draft' }): Promise<{ id: string; url?: string }> {
    const url = `${this.credentials.apiUrl.replace(/\/$/, '')}/ghost/api/admin/posts/`;
    const token = this.generateToken();

    const res = await this.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Ghost ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': resolveUserAgent(this.options),
      },
      body: JSON.stringify({ posts: [post] }),
    });

    const data = await res.json() as { posts?: Array<{ id: string; url?: string }>; errors?: Array<{ message: string }> };
    if (!res.ok || !data.posts?.[0]?.id) {
      const errorMsg = data.errors?.map((e) => e.message).join(', ') || 'Failed to create Ghost post';
      throw new Error(errorMsg);
    }
    return {
      id: data.posts[0].id,
      url: data.posts[0].url,
    };
  }
}
