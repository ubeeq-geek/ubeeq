import { SoundCloudTransport, soundCloudResponseError } from './soundcloud-transport.js';
import { createMultipartStream, type MultipartFile } from './multipart-stream.js';
import { readBoundedResponseText } from './bounded-response-text.js';
import { ExternalProviderError } from './provider-errors.js';

export interface SoundCloudUploadSource {
  filename: string; contentType: string;
  openReadStream(): Promise<MultipartFile['source']>;
}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Explicit upload execution; caller owns field admission, source selection and reconciliation. */
export class SoundCloudUploadClient {
  constructor(private readonly transport: SoundCloudTransport, private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}

  async upload(accessToken: string, fields: ReadonlyArray<readonly [string, string]>, uploadSource: SoundCloudUploadSource) {
    if (!this.transport.isConfigured()) throw new ExternalProviderError('SoundCloud is disabled or OAuth is not configured', 'unsupported');
    const source = await uploadSource.openReadStream();
    const multipart = createMultipartStream(fields, { fieldName: 'track[asset_data]', filename: uploadSource.filename,
      contentType: uploadSource.contentType, source });
    let response: Response;
    try {
      response = await this.fetcher('https://api.soundcloud.com/tracks', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300_000),
        headers: { Authorization: `OAuth ${accessToken}`, Accept: 'application/json', 'Content-Type': multipart.contentType },
        body: multipart.body, duplex: 'half'
      } as unknown as RequestInit & { duplex: 'half' });
    } catch {
      throw new ExternalProviderError('SoundCloud upload outcome is unknown; reconcile the account before retrying', 'ambiguous_submission');
    } finally { multipart.dispose(); }
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readBoundedResponseText(response, 4 * 1024 * 1024));
      payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      if (!response.ok) throw soundCloudResponseError(response.status, {}, response.headers.get('retry-after'));
      throw new ExternalProviderError('SoundCloud upload receipt could not be verified; reconcile the account before retrying', 'ambiguous_submission');
    }
    if (!response.ok) throw soundCloudResponseError(response.status, payload, response.headers.get('retry-after'));
    const externalContentId = string(payload.urn) || string(payload.id) ||
      (typeof payload.id === 'number' && Number.isSafeInteger(payload.id) && payload.id >= 0 ? String(payload.id) : undefined);
    if (!externalContentId) throw new ExternalProviderError('SoundCloud upload response did not identify the track', 'ambiguous_submission');
    return { externalContentId, externalUrl: string(payload.permalink_url), rawMetadata: payload };
  }
}
