import type { ConnectorAppCredentialsPort, ResolvedOAuthClientCredentials } from '@ubeeq/extension-sdk';
import { ExternalProviderError } from './provider-errors.js';

export type ConnectorAppMode = 'PlatformManagedApp' | 'CreatorOwnedApp';
export type VimeoAppMode = 'PLATFORM_MANAGED' | 'CREATOR_OWNED';

export interface HttpClientOptions {
  instanceUserAgent?: string;
}

export const resolveUserAgent = (options?: HttpClientOptions): string =>
  options?.instanceUserAgent?.trim() || 'Ubeeq/1.0';

export async function resolveConnectorCredentials(
  port: ConnectorAppCredentialsPort,
  provider: string,
  creatorId: string
): Promise<ResolvedOAuthClientCredentials> {
  const credentials = await port.resolveOAuthClient(provider, creatorId);
  if (!credentials) {
    throw new ExternalProviderError(
      `No credentials configured for provider '${provider}'. Configure instance environment variables or creator secret.`,
      'authentication_required'
    );
  }
  return credentials;
}
