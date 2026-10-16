import { createHash } from 'node:crypto';
import { assertPublicationCopyIdentity, type PublicationCopyIdentity } from '@ubeeq/core';

export interface CopyPublication {
  tenantId: string; creatorId: string; workId: string; publicationId: string;
  destination: string; copy?: PublicationCopyIdentity; revision?: number;
  status: string; remoteId?: string; createdAt: string; updatedAt: string;
}
export interface PublicationClaim {
  tenantId: string; key: string; publicationId: string; fingerprint: string;
}
export class PublicationCopyConflict extends Error {
  readonly code = 'publication_copy_conflict';
}
export interface CopyCreation<P extends CopyPublication> {
  publication: P; request: PublicationClaim; slot: PublicationClaim;
  /** Attach a new request receipt to an already allocated slot, without editing it. */
  existing: boolean;
}
/** All three records must commit atomically, with absent/unchanged conditions.
 * Implementations additionally guard current Work ownership and Creator lifecycle.
 * Reads are strong; this capability does not dispatch provider operations.
 */
export interface PublicationCopyRepository<P extends CopyPublication> {
  getPublication(tenantId: string, publicationId: string): Promise<P | null>;
  getPublicationClaim(tenantId: string, key: string): Promise<PublicationClaim | null>;
  commitPublicationCopy(input: CopyCreation<P>): Promise<void>;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : value;
export const publicationIdentityHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
export const copyClaimKeys = (p: CopyPublication): { request: string; slot: string } => {
  if (!p.copy) throw new PublicationCopyConflict('Copy identity is required.');
  return {
    request: `REQUEST#${publicationIdentityHash([p.tenantId, p.creatorId, p.copy.creationRequestId])}`,
    slot: `SLOT#${publicationIdentityHash([p.tenantId, p.creatorId, p.workId, p.destination, p.copy.account, p.copy.slotId])}`
  };
};

/** Allocate an independent draft. A repeated slot/request cannot mutate later edits. */
export async function createPublicationCopy<P extends CopyPublication>(repository: PublicationCopyRepository<P>, input: P, requestParameters: Readonly<Record<string, unknown>> = {}): Promise<{ publication: P; created: boolean }> {
  const p = structuredClone(input);
  assertPublicationCopyIdentity(p.copy!);
  if (![p.tenantId, p.creatorId, p.workId, p.publicationId, p.destination].every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)
    || p.revision !== 1 || p.status !== 'draft' || p.remoteId) throw new PublicationCopyConflict('New copies must be independent revision-one drafts without a remote object.');
  const keys = copyClaimKeys(p);
  const { creationRequestId: _request, ...identity } = p.copy!;
  // Compare explicit intent, never mutable source metadata or credential references.
  const fingerprint = publicationIdentityHash({ tenantId: p.tenantId, creatorId: p.creatorId, workId: p.workId, destination: p.destination, copy: identity, requestParameters });
  const receipt = (key: string, publicationId: string): PublicationClaim => ({ tenantId: p.tenantId, key, publicationId, fingerprint });
  for (let attempt = 0; attempt < 4; attempt++) {
    const request = await repository.getPublicationClaim(p.tenantId, keys.request);
    const slot = await repository.getPublicationClaim(p.tenantId, keys.slot);
    const existing = request || slot;
    if (existing) {
      if (existing.fingerprint !== fingerprint || (request && slot && request.publicationId !== slot.publicationId)) throw new PublicationCopyConflict('The request or slot already belongs to a different publication configuration.');
      const saved = await repository.getPublication(p.tenantId, existing.publicationId);
      if (!saved || !saved.copy || copyClaimKeys(saved).slot !== keys.slot) throw new PublicationCopyConflict('The publication receipt needs reconciliation.');
      if (!request) {
        try { await repository.commitPublicationCopy({ publication: saved, request: receipt(keys.request, saved.publicationId), slot: receipt(keys.slot, saved.publicationId), existing: true }); }
        catch (error) { if (error instanceof PublicationCopyConflict && attempt < 3) continue; throw error; }
      }
      return { publication: structuredClone(saved), created: false };
    }
    try {
      await repository.commitPublicationCopy({ publication: p, request: receipt(keys.request, p.publicationId), slot: receipt(keys.slot, p.publicationId), existing: false });
      return { publication: structuredClone(p), created: true };
    } catch (error) {
      if (error instanceof PublicationCopyConflict && attempt < 3) continue;
      throw error;
    }
  }
  throw new PublicationCopyConflict('Publication allocation changed concurrently. Refresh and retry.');
}

/** Identity fields cannot be replaced by generic/legacy upserts. */
export function assertCopyIdentityUnchanged(previous: CopyPublication | null, next: CopyPublication): void {
  if (previous?.copy && (publicationIdentityHash(previous.copy) !== publicationIdentityHash(next.copy)
    || previous.workId !== next.workId || previous.creatorId !== next.creatorId || previous.destination !== next.destination)) {
    throw new PublicationCopyConflict('Publication copy identity is immutable.');
  }
  if (previous?.copy && (next.revision !== previous.revision || publicationIdentityHash(previous) !== publicationIdentityHash(next))) {
    throw new PublicationCopyConflict('Copy-aware publications require a revision-checked operation.');
  }
}

export interface PublicationRemoteBinding {
  providerNamespace: string;
  objectType: string;
  /** Use the provider's actual namespace: e.g. global UUIDs versus account-local IDs. */
  ownershipBoundary: string;
  remoteId: string;
}
export interface CopyOperationCommit<P extends CopyPublication> {
  previous: P; next: P;
  operation: import('@ubeeq/core').PublicationOperation;
  previousOperation: import('@ubeeq/core').PublicationOperation | null;
  remoteClaim?: PublicationClaim;
}
export interface PublicationOperationRepository<P extends CopyPublication> {
  getPublication(tenantId: string, publicationId: string): Promise<P | null>;
  getPublicationOperation(tenantId: string, operationId: string): Promise<import('@ubeeq/core').PublicationOperation | null>;
  commitPublicationOperation(input: CopyOperationCommit<P>): Promise<void>;
}
export const remotePublicationClaim = (p: CopyPublication, binding: PublicationRemoteBinding): PublicationClaim => {
  if (!p.copy || binding.providerNamespace !== p.copy.account.providerNamespace
    || ![binding.objectType, binding.ownershipBoundary, binding.remoteId].every(value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200)
    || binding.remoteId.startsWith('pending:')) throw new PublicationCopyConflict('A confirmed provider object in its actual namespace is required.');
  return { tenantId: p.tenantId, key: `REMOTE#${publicationIdentityHash(binding)}`, publicationId: p.publicationId, fingerprint: publicationIdentityHash(binding) };
};
export interface OperationPublication extends CopyPublication { activeOperationId?: string; }
/** Approve one exact source revision. Approval never calls a provider or grants buyer access. */
export async function approvePublicationOperation<P extends OperationPublication>(repository: PublicationOperationRepository<P>, p: P,
  input: { kind: import('@ubeeq/core').PublicationOperation['kind']; sourceRevision: number; now: string }): Promise<import('@ubeeq/core').PublicationOperation> {
  if (!p.copy || !Number.isSafeInteger(p.revision) || p.revision! < 1 || !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1
    || !['CREATE', 'UPDATE', 'REMOVE', 'DETACH'].includes(input.kind)) throw new PublicationCopyConflict('A copy and exact source/publication revision are required.');
  if (input.kind === 'CREATE' ? Boolean(p.remoteId) : !p.remoteId && input.kind !== 'DETACH') throw new PublicationCopyConflict('Choose an operation matching the copy’s current remote binding.');
  if (p.activeOperationId) {
    const active = await repository.getPublicationOperation(p.tenantId, p.activeOperationId);
    if (!active || !['CONFIRMED', 'FAILED', 'CANCELLED'].includes(active.state)) throw new PublicationCopyConflict('Resolve the existing operation before approving another one.');
  }
  const revision = p.revision! + 1;
  const operation = { operationId: `operation-${publicationIdentityHash([p.tenantId, p.publicationId, revision])}`,
    tenantId: p.tenantId, creatorId: p.creatorId, publicationId: p.publicationId, intendedRevision: revision,
    sourceRevision: input.sourceRevision, kind: input.kind, state: 'PREPARED' as const, version: 1, createdAt: input.now, updatedAt: input.now };
  const next = { ...p, revision, activeOperationId: operation.operationId, updatedAt: input.now };
  await repository.commitPublicationOperation({ previous: p, next, operation, previousOperation: null });
  return structuredClone(operation);
}
const operationTransitions: Record<string, readonly string[]> = { PREPARED: ['IN_FLIGHT', 'CANCELLED'], IN_FLIGHT: ['AMBIGUOUS', 'CONFIRMED', 'FAILED'], AMBIGUOUS: ['CONFIRMED'] };
/** Only PREPARED may begin a provider call. AMBIGUOUS is never automatically retried.
 * Resolving AMBIGUOUS to CONFIRMED requires the adapter's verified remote binding.
 */
export async function transitionPublicationOperation<P extends OperationPublication>(repository: PublicationOperationRepository<P>,
  input: { tenantId: string; publicationId: string; operationId: string; expectedVersion: number;
    state: import('@ubeeq/core').PublicationOperation['state']; now: string; binding?: PublicationRemoteBinding }): Promise<import('@ubeeq/core').PublicationOperation> {
  const p = await repository.getPublication(input.tenantId, input.publicationId);
  const previous = await repository.getPublicationOperation(input.tenantId, input.operationId);
  if (!p?.copy || !previous || previous.publicationId !== p.publicationId || previous.creatorId !== p.creatorId || p.activeOperationId !== previous.operationId
    || previous.version !== input.expectedVersion) throw new PublicationCopyConflict('Operation or publication changed. Refresh before retrying.');
  if (!operationTransitions[previous.state]?.includes(input.state)) throw new PublicationCopyConflict('This operation transition requires reconciliation or fresh approval.');
  const createsOrUpdates = previous.kind === 'CREATE' || previous.kind === 'UPDATE';
  if (input.state === 'CONFIRMED' && createsOrUpdates && !input.binding) throw new PublicationCopyConflict('Remote readback is required to confirm delivery.');
  if (input.binding && (input.state !== 'CONFIRMED' || !createsOrUpdates || (p.remoteId && p.remoteId !== input.binding.remoteId))) throw new PublicationCopyConflict('An update cannot silently replace a remote object.');
  const operation = { ...previous, state: input.state, version: previous.version + 1, updatedAt: input.now, ...(input.binding ? { remoteId: input.binding.remoteId } : {}) };
  const next = { ...p, revision: p.revision! + 1, updatedAt: input.now,
    ...(input.binding ? { remoteId: input.binding.remoteId } : {}),
    ...(input.state === 'CONFIRMED' ? { status: createsOrUpdates ? 'live' : 'removed' } : {}) };
  await repository.commitPublicationOperation({ previous: p, next, previousOperation: previous, operation,
    ...(input.binding ? { remoteClaim: remotePublicationClaim(p, input.binding) } : {}) });
  return structuredClone(operation);
}

/** Adapter boundary checks; callers cannot smuggle claims or overwrite a sibling. */
export function validateCopyCreation<P extends CopyPublication>(input: CopyCreation<P>): void {
  const p = input.publication;
  assertPublicationCopyIdentity(p.copy!);
  const keys = copyClaimKeys(p);
  // A receipt for a later request uses the same slot but a different request ID.
  if (input.slot.key !== keys.slot || !input.request.key.startsWith('REQUEST#')
    || (!input.existing && input.request.key !== keys.request)
    || [input.request, input.slot].some(claim => claim.tenantId !== p.tenantId || claim.publicationId !== p.publicationId || !/^[a-f0-9]{64}$/.test(claim.fingerprint))
    || input.request.fingerprint !== input.slot.fingerprint
    || (!input.existing && (p.status !== 'draft' || p.revision !== 1 || p.remoteId))) throw new PublicationCopyConflict('Invalid publication creation transaction.');
}
export function validateCopyOperation<P extends CopyPublication>(input: CopyOperationCommit<P>): void {
  const { previous: p, next, operation: op, previousOperation: before, remoteClaim } = input;
  if (!p.copy || !next.copy || !Number.isSafeInteger(p.revision) || p.revision! < 1 || !Number.isSafeInteger(op.sourceRevision) || op.sourceRevision < 1
    || (next as OperationPublication).activeOperationId !== op.operationId
    || publicationIdentityHash(p.copy) !== publicationIdentityHash(next.copy)
    || ['tenantId', 'creatorId', 'workId', 'publicationId', 'destination', 'createdAt'].some(key => p[key as keyof P] !== next[key as keyof P])
    || next.revision !== p.revision! + 1 || op.tenantId !== p.tenantId || op.creatorId !== p.creatorId || op.publicationId !== p.publicationId
    || (before ? (p as OperationPublication).activeOperationId !== op.operationId || !operationTransitions[before.state]?.includes(op.state) || op.createdAt !== before.createdAt || op.version !== before.version + 1 || op.operationId !== before.operationId || op.intendedRevision !== before.intendedRevision || op.sourceRevision !== before.sourceRevision || op.kind !== before.kind
      : op.version !== 1 || op.state !== 'PREPARED' || op.intendedRevision !== next.revision)
    || (op.state === 'CONFIRMED' && ['CREATE', 'UPDATE'].includes(op.kind) && (!remoteClaim || !op.remoteId || next.remoteId !== op.remoteId))
    || (remoteClaim && (op.state !== 'CONFIRMED' || !['CREATE', 'UPDATE'].includes(op.kind) || remoteClaim.key !== `REMOTE#${remoteClaim.fingerprint}` || remoteClaim.tenantId !== p.tenantId || remoteClaim.publicationId !== p.publicationId || !remoteClaim.key.startsWith('REMOTE#')))) {
    throw new PublicationCopyConflict('Invalid publication operation transaction.');
  }
}
