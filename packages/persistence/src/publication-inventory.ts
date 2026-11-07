import { PublicationImageError, isPublicationIdentifier, type PublicationImageSelection } from '@ubeeq/core';
import { publicationIdentityHash } from './publication-copies.js';
import { repositoryItems } from './index.js';
import type { PublicationCommandRepositories, PublicationCommandService, PublicationCommandScope } from './publication-commands.js';

/** Explicit bounded per-Publication commands. Item receipts survive retries and reordering. */
export async function savePublicationImageSelectionBatch(service: PublicationCommandService, input: {
  instanceId: string; creatorId: string; requestId: string;
  items: readonly { workId: string; publicationId: string; expectedConfigurationRevision: number; selection: PublicationImageSelection }[];
}) {
  input = structuredClone(input);
  if (![input.instanceId, input.creatorId, input.requestId].every(isPublicationIdentifier) || !Array.isArray(input.items)
    || !input.items.length || input.items.length > 100 || input.items.some(item => !isPublicationIdentifier(item.workId) || !isPublicationIdentifier(item.publicationId))
    || new Set(input.items.map(item => item.publicationId)).size !== input.items.length) throw new PublicationImageError('invalid_request', 'Select up to 100 explicit Publication IDs and revisions.');
  const results = [];
  for (const item of input.items) {
    try {
      const result = await service.saveImageSelection({ instanceId: input.instanceId, creatorId: input.creatorId, ...item,
        requestId: `batch-${publicationIdentityHash([input.requestId, item.publicationId])}` });
      results.push({ publicationId: item.publicationId, workId: item.workId, status: 'saved' as const, appliedRevision: result.appliedRevision, replayed: result.replayed });
    } catch (error) {
      results.push({ publicationId: item.publicationId, workId: item.workId, status: 'blocked' as const,
        code: error instanceof PublicationImageError ? error.code : 'publication_reconciliation_required' as const });
    }
  }
  return { workCount: new Set(input.items.map(item => item.workId)).size, publicationCount: input.items.length, results };
}

/** Read-only operator inventory. The caller must authorize Creator inventory before calling.
 * Consumer-only external rows, old command stores and pending jobs must supplement this inventory.
 */
export async function inventoryPublicationCommands(repositories: PublicationCommandRepositories, scope: Pick<PublicationCommandScope, 'instanceId' | 'creatorId'>, now = new Date()) {
  if (![scope.instanceId, scope.creatorId].every(isPublicationIdentifier) || !Number.isFinite(now.getTime())) throw new PublicationImageError('invalid_request', 'An authorized inventory scope is required.');
  const groups = new Map<string, { workId: string; operationalPublicationIds: string[]; legacyCopyDraftIds: string[]; unmanagedPublicationIds: string[];
    reconciliationPublicationIds: string[]; pendingOperationIds: string[]; conflictPublicationIds: string[] }>();
  const works = new Set<string>(), publications = new Map<string, { currentTargetKey?: string }>();
  for await (const work of repositoryItems(request => repositories.works.list(request))) {
    if (work.instanceId !== scope.instanceId || work.creatorId !== scope.creatorId) continue;
    works.add(work.id); groups.set(work.id, { workId: work.id, operationalPublicationIds: [], legacyCopyDraftIds: [], unmanagedPublicationIds: [], reconciliationPublicationIds: [], pendingOperationIds: [], conflictPublicationIds: [] });
  }
  for await (const p of repositoryItems(request => repositories.publications.list(request))) {
    if (p.instanceId !== scope.instanceId || !works.has(p.workId)) continue;
    publications.set(p.id, p); const group = groups.get(p.workId)!;
    if (p.copy && p.preparationVersion !== 1) {
      if (p.status === 'draft' && !p.remoteId && !p.activeOperationId) group.legacyCopyDraftIds.push(p.id);
      else group.reconciliationPublicationIds.push(p.id);
    }
    else if (p.preparationVersion === 1) group.operationalPublicationIds.push(p.id);
    else group.unmanagedPublicationIds.push(p.id);
  }
  const counts = { preparationReceipts: 0, currentTargetReservations: 0, historicalTargetReservations: 0, remoteClaims: 0, pendingOutbox: 0, oldestPendingOutboxSeconds: 0,
    uncertainOperations: 0, expiredLeases: 0, needsReview: 0, identityConflicts: 0 };
  for await (const claim of repositoryItems(request => repositories.claims.list(request))) {
    if (claim.instanceId !== scope.instanceId || claim.creatorId !== scope.creatorId) continue;
    if (claim.kind === 'preparation') counts.preparationReceipts++;
    if (claim.kind === 'target') {
      if (claim.targetKey && publications.get(claim.publicationId)?.currentTargetKey === claim.targetKey) counts.currentTargetReservations++;
      else counts.historicalTargetReservations++;
    }
    if (claim.kind === 'remote') counts.remoteClaims++;
    if (!publications.has(claim.publicationId)) {
      counts.identityConflicts++;
      groups.get(claim.workId)?.conflictPublicationIds.push(claim.publicationId);
    }
  }
  for await (const record of repositoryItems(request => repositories.operations.list(request))) {
    if (record.instanceId !== scope.instanceId || record.creatorId !== scope.creatorId) continue;
    const op = record.operation;
    if (!['CONFIRMED', 'FAILED', 'CANCELLED'].includes(op.state)) groups.get(record.workId)?.pendingOperationIds.push(op.operationId);
    if (op.state === 'AMBIGUOUS') counts.uncertainOperations++;
    if (op.blockedCode === 'publication_identity_conflict') counts.identityConflicts++;
    if (op.blockedCode === 'publication_review_stale') counts.needsReview++;
    if (['IN_FLIGHT', 'AMBIGUOUS'].includes(op.state) && op.lease && Date.parse(op.lease.expiresAt) <= now.getTime()) counts.expiredLeases++;
  }
  for await (const entry of repositoryItems(request => repositories.outbox.list(request))) {
    if (entry.instanceId !== scope.instanceId || entry.creatorId !== scope.creatorId || entry.state !== 'pending') continue;
    counts.pendingOutbox++;
    counts.oldestPendingOutboxSeconds = Math.max(counts.oldestPendingOutboxSeconds, Math.max(0, Math.floor((now.getTime() - Date.parse(entry.createdAt)) / 1000)));
  }
  return { ...scope, counts, works: [...groups.values()], providerRequests: 0 as const };
}
