import { projectIntegrationAccountHealth, type IntegrationHealthConnection } from './account-health.js';
import type { ActivityEvent } from './activity-workflows.js';
/** Emit only health transitions. Persist the returned signature alongside the account
 * checkpoint after durable ingestion; reuse observationId when retrying an observation.
 */
export function integrationHealthActivity(input: {
  creatorId: string; platform: string; accountId: string; observationId: string;
  account: IntegrationHealthConnection; previousSignature?: string;
  nowMs: number; expiryWarningMs: number; syncStaleMs: number; publicationFailed?: boolean;
}): { signature: string; events: ActivityEvent[] } {
  if (!Number.isFinite(input.syncStaleMs) || input.syncStaleMs <= 0) throw new Error('Positive sync freshness window required.');
  const projected = projectIntegrationAccountHealth(input.account, { nowMs: input.nowMs, expiryWarningWindowMs: input.expiryWarningMs });
  const issues: NonNullable<ActivityEvent['health']>[] = [];
  if (projected.token.status === 'expired' || projected.state === 'authentication_required') issues.push('authorization_expired');
  else if (projected.token.status === 'expires_soon') issues.push('authorization_expiring');
  if (input.publicationFailed) issues.push('publish_failed');
  const success = Date.parse(input.account.lastSuccessfulSyncAt ?? '');
  const attempt = Date.parse(input.account.lastSyncAttemptAt ?? '');
  if ((Number.isFinite(success) && input.nowMs - success >= input.syncStaleMs) ||
      (!Number.isFinite(success) && Number.isFinite(attempt) && input.nowMs - attempt >= input.syncStaleMs)) issues.push('sync_stalled');
  const signature = issues.length ? issues.join(',') : projected.state === 'connected' ? '' : `state:${projected.state}`;
  if (signature === input.previousSignature || (!signature && !input.previousSignature)) return { signature, events: [] };
  return { signature, events: (issues.length ? issues : projected.state === 'connected' ? ['recovered'] as const : []).map(health => ({
    id: `${input.observationId}:${health}`, creatorId: input.creatorId, platform: input.platform,
    accountId: input.accountId, sourceAt: new Date(input.nowMs).toISOString(), kind: 'health', health
  })) };
}
