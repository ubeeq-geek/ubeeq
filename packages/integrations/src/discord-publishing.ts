import { resolveUserAgent, type HttpClientOptions } from './connector-credentials.js';

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  image?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

export class DiscordWebhookClient {
  constructor(
    private readonly options?: HttpClientOptions,
    private readonly request: typeof fetch = fetch
  ) {}

  async sendWebhook(webhookUrl: string, payload: DiscordMessagePayload): Promise<{ id?: string }> {
    const url = new URL(webhookUrl);
    if (!['https:'].includes(url.protocol) || !['discord.com', 'discordapp.com'].includes(url.hostname)) {
      throw new Error('Invalid Discord webhook URL');
    }

    url.searchParams.set('wait', 'true');
    const res = await this.request(url.href, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': resolveUserAgent(this.options),
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Discord webhook delivery failed with HTTP ${res.status}`);
    }

    const data = await res.json() as { id?: string };
    return { id: data.id };
  }
}
