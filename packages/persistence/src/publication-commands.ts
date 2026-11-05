import {
  assertPublicationConfigurationRevision, assertPublicationCopyIdentity, inheritedPublicationImageSelection, isPublicationIdentifier,
  PublicationImageError, publicationImageCanonicalJson, publicationImageFingerprint, validatePublicationImageReviewSnapshot,
  validatePublicationImageSelection, type PublicationAccountIdentity, type PublicationDeliveryOperation,
  type PublicationImageDeliveryEvidence, type PublicationImageReviewSnapshot, type PublicationImageSelection, type PublicationWatermarkSettings
} from '@ubeeq/core';
import { publicationIdentityHash, type PublicationRemoteBinding } from './publication-copies.js';
import { OptimisticConcurrencyError, repositoryItems, type AuditEventRecord, type CellOwnedRecord, type PersistenceTransaction,
  type PublicationRecord, type RevisionedRecord, type RevisionedRepository, type TransactionRunner, type WorkRecord } from './index.js';

export interface ManagedPublicationRecord extends PublicationRecord {
  copy?: import('@ubeeq/core').PublicationCopyIdentity;
  executionPolicy?: { schemaVersion: 1; adaptationReceiptId: string };
  creatorId?: string;
  connectionId?: string;
  account?: PublicationAccountIdentity;
  currentTargetKey?: string;
  preparationVersion?: 1;
  activeOperationId?: string;
  lastConfirmedImage?: PublicationImageDeliveryEvidence;
}
export interface PublicationCommandClaim extends RevisionedRecord, CellOwnedRecord {
  instanceId: string; creatorId: string; workId: string; publicationId: string;
  kind: 'identity' | 'preparation' | 'target' | 'configuration' | 'approval' | 'remote' | 'adaptation';
  fingerprint: string;
  targetKey?: string;
  configurationRevision?: number;
  operationId?: string;
}
export interface PublicationDeliveryRecord extends RevisionedRecord, CellOwnedRecord {
  instanceId: string; creatorId: string; workId: string;
  operation: PublicationDeliveryOperation;
}
export interface PublicationOutboxRecord extends RevisionedRecord, CellOwnedRecord {
  instanceId: string; creatorId: string; workId: string; publicationId: string; operationId: string;
  state: 'pending' | 'submitted' | 'paused';
}
/** Separate additive capability. Existing repository compositions need not advertise image controls. */
export interface PublicationCommandRepositories extends TransactionRunner {
  works: RevisionedRepository<WorkRecord>;
  publications: RevisionedRepository<ManagedPublicationRecord>;
  claims: RevisionedRepository<PublicationCommandClaim>;
  operations: RevisionedRepository<PublicationDeliveryRecord>;
  outbox: RevisionedRepository<PublicationOutboxRecord>;
  auditEvents: RevisionedRepository<AuditEventRecord>;
}
export interface PublicationCommandScope { instanceId: string; creatorId: string; workId: string; }
export type PublicationCommandAction = 'read' | 'prepare' | 'adapt' | 'configure' | 'approve' | 'dispatch' | 'record-result' | 'reconcile';
/** Product policy is mandatory: these primitives never turn supplied IDs into authority. */
export interface PublicationCommandPolicy {
  authorize(scope: PublicationCommandScope, work: WorkRecord, publication: ManagedPublicationRecord | undefined, action: PublicationCommandAction, transaction: PersistenceTransaction): Promise<void>;
  validateWatermark(value: unknown): PublicationWatermarkSettings;
  validateSelection(work: WorkRecord, publication: ManagedPublicationRecord, selection: PublicationImageSelection, transaction: PersistenceTransaction): Promise<void>;
  /** Loads authorized files, current membership/access, metadata, stable principal and safety policy.
   * For a custom operation image, retain its trusted file reference from approved rather than reinterpreting it.
   * Guard external dependencies with commit-time checks in the same transaction.
   */
  review(work: WorkRecord, publication: ManagedPublicationRecord, transaction: PersistenceTransaction, approved?: PublicationImageReviewSnapshot): Promise<PublicationImageReviewSnapshot>;
  /** Adapter normalizes the provider's actual object namespace and verifies read-back evidence. */
  verifyRemoteResult(operation: PublicationDeliveryOperation, binding: PublicationRemoteBinding, transaction: PersistenceTransaction): Promise<PublicationRemoteBinding>;
  /** Required before a dispatched operation can be called a final failure and approved again. */
  verifyFinalFailure?(operation: PublicationDeliveryOperation, evidence: { code: string; providerRequestId?: string }, transaction: PersistenceTransaction): Promise<void>;
  /** Product compatibility rows/intents/assets must join this transaction. No provider calls. */
  commitPreparation?(work: WorkRecord, publication: ManagedPublicationRecord, intent: Readonly<Record<string, unknown>>, transaction: PersistenceTransaction): Promise<void>;
  /** Must guard the original command/slot/remote claims, compatibility rows and all legacy jobs.
   * Missing capability, any dispatched/ambiguous operation or inconsistent projection blocks adaptation.
   */
  validateLegacyAdaptation?(work: WorkRecord, publication: ManagedPublicationRecord, transaction: PersistenceTransaction): Promise<void>;
}
const cell = (work: WorkRecord) => ({ homeCellId: work.homeCellId, dataHomeRegion: work.dataHomeRegion,
  dataHomeAssignedAt: work.dataHomeAssignedAt, routingRevision: work.routingRevision });
const identity = (scope: PublicationCommandScope) => [scope.instanceId, scope.creatorId, scope.workId];
const key = (kind: string, value: unknown) => `${kind}-${publicationIdentityHash(value)}`;
function fail(code: ConstructorParameters<typeof PublicationImageError>[0], message: string): never { throw new PublicationImageError(code, message); }
const validRequest = (value: string) => { if (!isPublicationIdentifier(value)) fail('invalid_request', 'A stable request ID is required.'); };
const retryable = (error: unknown): boolean => error instanceof OptimisticConcurrencyError || (error as { name?: string })?.name === 'TransactionCanceledException'
  && Boolean((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons?.every(reason => ['None', 'ConditionalCheckFailed'].includes(reason.Code ?? '')));

/** Shared preparation/configuration/review state machine. Provider dispatch remains in the adapter. */
export class PublicationCommandService {
  constructor(readonly repositories: PublicationCommandRepositories, private readonly policy: PublicationCommandPolicy,
    private readonly clock: () => Date = () => new Date()) {}

  private async transaction<T>(run: (transaction: PersistenceTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.repositories.transaction(run); }
      catch (error) { if (!retryable(error) || attempt >= 3) throw error; }
    }
  }
  private async load(scope: PublicationCommandScope, publicationId: string | undefined, action: PublicationCommandAction, transaction: PersistenceTransaction) {
    if (!identity(scope).every(isPublicationIdentifier) || publicationId !== undefined && !isPublicationIdentifier(publicationId)) fail('publication_not_found', 'Publication not found.');
    const work = await this.repositories.works.get(scope.workId, { transaction });
    const publication = publicationId ? await this.repositories.publications.get(publicationId, { transaction }) : undefined;
    if (!work || work.instanceId !== scope.instanceId || work.creatorId !== scope.creatorId
      || publicationId && (!publication || publication.instanceId !== scope.instanceId || publication.workId !== scope.workId
        || publication.creatorId !== undefined && publication.creatorId !== scope.creatorId)) fail('publication_not_found', 'Publication not found.');
    await this.policy.authorize(scope, work, publication, action, transaction);
    if (!['read', 'record-result', 'reconcile'].includes(action) && ['archived', 'deleted'].includes(work.status)) fail('publication_image_unavailable', 'The source Work is unavailable.');
    return { work, publication };
  }
  private async guardWork(work: WorkRecord, transaction: PersistenceTransaction) {
    if (!this.repositories.works.checkRevision) throw new Error('Publication commands require commit-time Work revision guards.');
    await this.repositories.works.checkRevision(work.id, work.revision, { transaction });
  }
  private claim(work: WorkRecord, publicationId: string, id: string, kind: PublicationCommandClaim['kind'], fingerprint: string) {
    return { id, ...cell(work), instanceId: work.instanceId, creatorId: work.creatorId, workId: work.id, publicationId, kind, fingerprint };
  }
  private async audit(work: WorkRecord, publicationId: string, action: string, payload: Readonly<Record<string, unknown>>, transaction: PersistenceTransaction) {
    await this.repositories.auditEvents.create({ id: key('publication-audit', [action, work.instanceId, publicationId, payload]), ...cell(work),
      instanceId: work.instanceId, action, subjectId: publicationId, payload }, { transaction });
  }
  private adaptationFingerprint(p: ManagedPublicationRecord) {
    return publicationIdentityHash([p.instanceId, p.creatorId, p.workId, p.id, p.copy, p.account, p.connectionId, p.currentTargetKey]);
  }
  private async assertManaged(p: ManagedPublicationRecord, transaction: PersistenceTransaction) {
    if (p.copy) {
      const receipt = p.executionPolicy?.schemaVersion === 1 ? await this.repositories.claims.get(p.executionPolicy.adaptationReceiptId, { transaction }) : undefined;
      if (!receipt || receipt.kind !== 'adaptation' || receipt.publicationId !== p.id || receipt.instanceId !== p.instanceId
        || receipt.fingerprint !== this.adaptationFingerprint(p)) fail('publication_reconciliation_required', 'This legacy copy requires explicit product adaptation before execution.');
    }
    if (p.preparationVersion !== 1 || !p.account || !p.connectionId) fail('publication_reconciliation_required', 'Publication setup requires verified account and target information.');
  }

  async get(scope: PublicationCommandScope, publicationId: string): Promise<ManagedPublicationRecord> {
    return this.transaction(async transaction => structuredClone((await this.load(scope, publicationId, 'read', transaction)).publication!));
  }

  async prepare(input: PublicationCommandScope & { publicationId: string; requestId: string; expectedWorkRevision: number;
    destination: string; connectionId: string; account: PublicationAccountIdentity; targetKey: string;
    intent: Readonly<Record<string, unknown>>; imageSelection?: PublicationImageSelection }): Promise<{ publication: ManagedPublicationRecord; created: boolean }> {
    input = structuredClone(input);
    validRequest(input.requestId);
    if (![input.publicationId, input.destination, input.connectionId, input.targetKey, input.account?.providerNamespace, input.account?.remoteAccountId].every(isPublicationIdentifier)) fail('invalid_request', 'Verified destination and target identity are required.');
    const selection = input.imageSelection === undefined ? undefined : validatePublicationImageSelection(input.imageSelection, value => this.policy.validateWatermark(value));
    const fingerprint = publicationIdentityHash({ scope: identity(input), destination: input.destination, account: input.account, targetKey: input.targetKey, intent: input.intent, imageSelection: selection });
    const requestId = key('preparation', [input.instanceId, input.creatorId, input.requestId]);
    const targetId = key('target', [identity(input), input.destination, input.account, input.targetKey]);
    return this.transaction(async transaction => {
      const { work } = await this.load(input, undefined, 'prepare', transaction);
      const receipt = await this.repositories.claims.get(requestId, { transaction });
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('idempotency_conflict', 'This request ID has different preparation settings.');
        const p = (await this.load(input, receipt.publicationId, 'prepare', transaction)).publication!;
        return { publication: p, created: false };
      }
      if (work.revision !== input.expectedWorkRevision) fail('publication_revision_conflict', 'The Work changed. Refresh preparation.');
      await this.guardWork(work, transaction);
      const target = await this.repositories.claims.get(targetId, { transaction });
      if (target) {
        if (target.fingerprint !== publicationIdentityHash(input.intent)) fail('publication_identity_conflict', 'This target has a different publication intent.');
        const p = (await this.load(input, target.publicationId, 'prepare', transaction)).publication!;
        if (p.currentTargetKey !== input.targetKey || publicationIdentityHash(p.account) !== publicationIdentityHash(input.account)) fail('publication_identity_conflict', 'The historical target mapping needs reconciliation.');
        await this.repositories.claims.create(this.claim(work, p.id, requestId, 'preparation', fingerprint), { transaction });
        return { publication: p, created: false };
      }
      const publicationIdentityId = key('publication-identity', [input.instanceId, input.publicationId]);
      if (await this.repositories.publications.get(input.publicationId, { transaction }) || await this.repositories.claims.get(publicationIdentityId, { transaction })) fail('publication_identity_conflict', 'This Publication ID is already allocated; its current target must be reconciled.');
      const p = await this.repositories.publications.create({ id: input.publicationId, ...cell(work), instanceId: work.instanceId,
        creatorId: work.creatorId, workId: work.id, destination: input.destination, connectionId: input.connectionId,
        account: input.account, currentTargetKey: input.targetKey, preparationVersion: 1, configurationRevision: selection ? 1 : 0,
        ...(selection ? { imageSelection: selection } : {}), status: 'draft' }, { transaction });
      await this.policy.validateSelection(work, p, selection ?? inheritedPublicationImageSelection(), transaction);
      await this.policy.commitPreparation?.(work, p, input.intent, transaction);
      await this.repositories.claims.create(this.claim(work, p.id, requestId, 'preparation', fingerprint), { transaction });
      await this.repositories.claims.create({ ...this.claim(work, p.id, targetId, 'target', publicationIdentityHash(input.intent)), targetKey: input.targetKey }, { transaction });
      await this.repositories.claims.create(this.claim(work, p.id, publicationIdentityId, 'identity', publicationIdentityHash([identity(input), p.id])), { transaction });
      await this.audit(work, p.id, 'publication.prepared', { requestId, targetId }, transaction);
      return { publication: p, created: true };
    });
  }

  async saveImageSelection(input: PublicationCommandScope & { publicationId: string; expectedConfigurationRevision: number; requestId: string; selection: PublicationImageSelection }): Promise<{ publication: ManagedPublicationRecord; appliedRevision: number; replayed: boolean }> {
    input = structuredClone(input);
    validRequest(input.requestId);
    assertPublicationConfigurationRevision(input.expectedConfigurationRevision);
    if (input.expectedConfigurationRevision === undefined) fail('invalid_request', 'An expected configuration revision is required.');
    const selection = validatePublicationImageSelection(input.selection, value => this.policy.validateWatermark(value));
    const fingerprint = publicationIdentityHash([identity(input), input.publicationId, input.expectedConfigurationRevision, selection]);
    const receiptId = key('configuration', [input.instanceId, input.creatorId, input.requestId]);
    return this.transaction(async transaction => {
      const { work, publication: p } = await this.load(input, input.publicationId, 'configure', transaction);
      const receipt = await this.repositories.claims.get(receiptId, { transaction });
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('idempotency_conflict', 'This request ID has different image settings.');
        return { publication: p!, appliedRevision: receipt.configurationRevision!, replayed: true };
      }
      assertPublicationConfigurationRevision(p!.configurationRevision);
      const currentRevision = p!.configurationRevision ?? 0;
      if (currentRevision !== input.expectedConfigurationRevision) fail('publication_revision_conflict', 'Image settings changed. Reload this Publication.');
      await this.policy.validateSelection(work, { ...p!, imageSelection: selection, unresolvedImageContext: undefined }, selection, transaction);
      await this.guardWork(work, transaction);
      const changed = Boolean(p!.unresolvedImageContext) || publicationImageCanonicalJson(p!.imageSelection ?? inheritedPublicationImageSelection()) !== publicationImageCanonicalJson(selection);
      if (changed && currentRevision === Number.MAX_SAFE_INTEGER) fail('publication_revision_conflict', 'Configuration revision is exhausted.');
      const appliedRevision = currentRevision + (changed ? 1 : 0);
      const publication = changed ? await this.repositories.publications.update(p!.id, p!.revision, { imageSelection: selection, configurationRevision: appliedRevision, unresolvedImageContext: undefined }, { transaction }) : p!;
      if (!changed) {
        if (!this.repositories.publications.checkRevision) throw new Error('Publication revision guards are required.');
        await this.repositories.publications.checkRevision(p!.id, p!.revision, { transaction });
      }
      await this.repositories.claims.create({ ...this.claim(work, p!.id, receiptId, 'configuration', fingerprint), configurationRevision: appliedRevision }, { transaction });
      await this.audit(work, p!.id, 'publication.image-configured', { receiptId, configurationRevision: appliedRevision }, transaction);
      return { publication, appliedRevision, replayed: false };
    });
  }

  /** Explicit, currently authorized setup of an untouched legacy draft. Never removes its copy identity. */
  async adaptLegacyDraft(input: PublicationCommandScope & { publicationId: string; requestId: string; expectedPublicationRevision: number;
    expectedWorkRevision: number; connectionId: string; account: PublicationAccountIdentity; targetKey: string; intent: Readonly<Record<string, unknown>> }) {
    input = structuredClone(input); validRequest(input.requestId);
    if (![input.connectionId, input.targetKey, input.account?.providerNamespace, input.account?.remoteAccountId].every(isPublicationIdentifier)) fail('invalid_request', 'Explicit verified gallery setup is required.');
    const requestId = key('adaptation-request', [input.instanceId, input.creatorId, input.requestId]);
    const fingerprint = publicationIdentityHash(input);
    return this.transaction(async transaction => {
      const { work, publication: p } = await this.load(input, input.publicationId, 'adapt', transaction);
      const receipt = await this.repositories.claims.get(requestId, { transaction });
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('idempotency_conflict', 'This request ID has different adaptation settings.');
        await this.assertManaged(p!, transaction); return p!;
      }
      if (!this.policy.validateLegacyAdaptation) fail('publication_reconciliation_required', 'This consumer must provide legacy job and claim inventory before adaptation.');
      if (!p!.copy || p!.preparationVersion || p!.executionPolicy || p!.status !== 'draft' || p!.remoteId || p!.activeOperationId
        || publicationIdentityHash(p!.copy.account) !== publicationIdentityHash(input.account)) fail('publication_reconciliation_required', 'Only an untouched, unbound draft on the verified original account can be adapted.');
      assertPublicationCopyIdentity(p!.copy!);
      if (p!.revision !== input.expectedPublicationRevision || work.revision !== input.expectedWorkRevision) fail('publication_revision_conflict', 'The Work or legacy draft changed.');
      await this.policy.validateLegacyAdaptation(work, p!, transaction);
      await this.guardWork(work, transaction);
      const targetId = key('target', [identity(input), p!.destination, input.account, input.targetKey]);
      if (await this.repositories.claims.get(targetId, { transaction })) fail('publication_identity_conflict', 'This target is already reserved. Retain or explicitly archive the unused draft.');
      const adaptationId = key('adaptation', [requestId, p!.id]);
      const next = { ...p!, creatorId: work.creatorId, account: input.account, connectionId: input.connectionId, currentTargetKey: input.targetKey,
        preparationVersion: 1 as const, executionPolicy: { schemaVersion: 1 as const, adaptationReceiptId: adaptationId } };
      await this.policy.validateSelection(work, next, next.imageSelection ?? inheritedPublicationImageSelection(), transaction);
      const saved = await this.repositories.publications.update(p!.id, p!.revision, { creatorId: next.creatorId, account: next.account,
        connectionId: next.connectionId, currentTargetKey: next.currentTargetKey, preparationVersion: next.preparationVersion, executionPolicy: next.executionPolicy }, { transaction });
      await this.policy.commitPreparation?.(work, saved, input.intent, transaction);
      await this.repositories.claims.create({ ...this.claim(work, p!.id, targetId, 'target', publicationIdentityHash(input.intent)), targetKey: input.targetKey }, { transaction });
      await this.repositories.claims.create(this.claim(work, p!.id, key('publication-identity', [input.instanceId, p!.id]), 'identity', publicationIdentityHash([identity(input), p!.id])), { transaction });
      await this.repositories.claims.create(this.claim(work, p!.id, adaptationId, 'adaptation', this.adaptationFingerprint(saved)), { transaction });
      await this.repositories.claims.create(this.claim(work, p!.id, requestId, 'adaptation', fingerprint), { transaction });
      await this.audit(work, p!.id, 'publication.legacy-adapted', { requestId, adaptationId }, transaction);
      return saved;
    });
  }

  private async review(work: WorkRecord, p: ManagedPublicationRecord, transaction: PersistenceTransaction, approved?: PublicationImageReviewSnapshot) {
    await this.assertManaged(p, transaction);
    const snapshot = structuredClone(await this.policy.review(work, p, transaction, approved));
    validatePublicationImageReviewSnapshot(snapshot);
    if (snapshot.publicationId !== p.id || snapshot.workId !== work.id || snapshot.workRevision !== work.revision
      || snapshot.configurationRevision !== (p.configurationRevision ?? 0) || snapshot.connectionId !== p.connectionId
      || publicationIdentityHash(snapshot.account) !== publicationIdentityHash(p.account)) fail('publication_review_stale', 'Review identity or configuration changed.');
    return { snapshot, fingerprint: await publicationImageFingerprint(snapshot) };
  }

  async reviewImage(scope: PublicationCommandScope, publicationId: string) {
    return this.transaction(async transaction => {
      const { work, publication } = await this.load(scope, publicationId, 'read', transaction);
      return this.review(work, publication!, transaction);
    });
  }

  async approve(input: PublicationCommandScope & { publicationId: string; requestId: string; expectedReviewFingerprint: string; kind: 'CREATE' | 'UPDATE' }): Promise<PublicationDeliveryRecord> {
    input = structuredClone(input);
    validRequest(input.requestId);
    if (!['CREATE', 'UPDATE'].includes(input.kind) || !/^[a-f0-9]{64}$/.test(input.expectedReviewFingerprint)) fail('invalid_request', 'An exact reviewed operation is required.');
    const fingerprint = publicationIdentityHash([identity(input), input.publicationId, input.kind, input.expectedReviewFingerprint]);
    const requestId = key('approval', [input.instanceId, input.creatorId, input.requestId]);
    return this.transaction(async transaction => {
      const { work, publication: p } = await this.load(input, input.publicationId, 'approve', transaction);
      const receipt = await this.repositories.claims.get(requestId, { transaction });
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('idempotency_conflict', 'This request ID has different approval inputs.');
        const saved = await this.repositories.operations.get(receipt.operationId!, { transaction });
        if (!saved) fail('publication_reconciliation_required', 'The accepted operation receipt is incomplete.');
        return saved;
      }
      if (input.kind === 'CREATE' ? Boolean(p!.remoteId) : !p!.remoteId) fail('publication_identity_conflict', 'The operation does not match the current remote binding.');
      if (p!.activeOperationId) {
        const active = await this.repositories.operations.get(p!.activeOperationId, { transaction });
        if (!active || !['CONFIRMED', 'FAILED', 'CANCELLED'].includes(active.operation.state)) fail('publication_busy', 'Resolve the existing Publication operation first.');
      }
      const { snapshot, fingerprint: reviewFingerprint } = await this.review(work, p!, transaction);
      if (reviewFingerprint !== input.expectedReviewFingerprint) fail('publication_review_stale', 'The image, metadata or target changed. Review this Publication again.');
      await this.guardWork(work, transaction);
      const operationId = key('delivery', [requestId, fingerprint]);
      const record = await this.repositories.operations.create({ id: operationId, ...cell(work), instanceId: work.instanceId, creatorId: work.creatorId, workId: work.id,
        operation: { operationId, publicationId: p!.id, schemaVersion: 1, kind: input.kind, state: 'PREPARED', snapshot, reviewFingerprint, fencingGeneration: 0 } }, { transaction });
      await this.repositories.publications.update(p!.id, p!.revision, { activeOperationId: operationId }, { transaction });
      await this.repositories.claims.create({ ...this.claim(work, p!.id, requestId, 'approval', fingerprint), operationId }, { transaction });
      await this.repositories.outbox.create({ id: operationId, ...cell(work), instanceId: work.instanceId, creatorId: work.creatorId,
        workId: work.id, publicationId: p!.id, operationId, state: 'pending' }, { transaction });
      await this.audit(work, p!.id, 'publication.approved', { operationId, reviewFingerprint }, transaction);
      return record;
    });
  }

  /** Commits dispatch authority before returning approved inputs. Only a successful caller may write remotely. */
  async beginDispatch(input: PublicationCommandScope & { publicationId: string; operationId: string; workerId: string; leaseSeconds: number }): Promise<PublicationDeliveryRecord> {
    input = structuredClone(input);
    if (!isPublicationIdentifier(input.workerId) || !Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 3600) fail('invalid_request', 'Invalid worker lease.');
    return this.transaction(async transaction => {
      const { work, publication: p } = await this.load(input, input.publicationId, 'dispatch', transaction);
      const saved = await this.loadOperation(input, p!, transaction);
      if (saved.operation.state !== 'PREPARED') fail(saved.operation.dispatchedAt ? 'publication_reconciliation_required' : 'publication_busy', 'This operation cannot start another provider request.');
      const current = await this.review(work, p!, transaction, saved.operation.snapshot);
      await this.guardWork(work, transaction);
      if (current.fingerprint !== saved.operation.reviewFingerprint) {
        const paused = await this.repositories.operations.update(saved.id, saved.revision, { operation: { ...saved.operation, state: 'CANCELLED', blockedCode: 'publication_review_stale' } }, { transaction });
        const outbox = await this.repositories.outbox.get(saved.id, { transaction });
        if (!outbox) fail('publication_reconciliation_required', 'Accepted operation has no outbox record.');
        await this.repositories.outbox.update(outbox.id, outbox.revision, { state: 'paused' }, { transaction });
        await this.audit(work, p!.id, 'publication.review-stale', { operationId: saved.id }, transaction);
        return paused;
      }
      const now = this.clock();
      const next = await this.repositories.operations.update(saved.id, saved.revision, { operation: { ...saved.operation, state: 'IN_FLIGHT',
        dispatchedAt: now.toISOString(), fencingGeneration: saved.operation.fencingGeneration + 1,
        lease: { owner: input.workerId, expiresAt: new Date(now.getTime() + input.leaseSeconds * 1000).toISOString() } } }, { transaction });
      // Configuration/status races cannot authorize dispatch using a stale publication read.
      if (!this.repositories.publications.checkRevision) throw new Error('Publication revision guards are required.');
      await this.repositories.publications.checkRevision(p!.id, p!.revision, { transaction });
      await this.audit(work, p!.id, 'publication.dispatched', { operationId: saved.id, fencingGeneration: next.operation.fencingGeneration }, transaction);
      return next;
    });
  }

  private async loadOperation(input: PublicationCommandScope & { operationId: string }, p: ManagedPublicationRecord, transaction: PersistenceTransaction, requireActive = true) {
    const saved = await this.repositories.operations.get(input.operationId, { transaction });
    if (!saved || saved.instanceId !== input.instanceId || saved.creatorId !== input.creatorId || saved.workId !== input.workId
      || saved.operation.publicationId !== p.id || saved.operation.schemaVersion !== 1 || requireActive && p.activeOperationId !== saved.id) fail('publication_reconciliation_required', 'Operation identity requires reconciliation.');
    return saved;
  }

  /** Acquiring reconciliation authority never authorizes another upload. */
  async beginReconciliation(input: PublicationCommandScope & { publicationId: string; operationId: string; workerId: string; leaseSeconds: number }) {
    if (!isPublicationIdentifier(input.workerId) || !Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 3600) fail('invalid_request', 'Invalid reconciliation lease.');
    return this.transaction(async transaction => {
      const { work, publication: p } = await this.load(input, input.publicationId, 'reconcile', transaction);
      const saved = await this.loadOperation(input, p!, transaction), now = this.clock();
      if (!['IN_FLIGHT', 'AMBIGUOUS'].includes(saved.operation.state) || !saved.operation.dispatchedAt) fail('publication_reconciliation_required', 'No dispatched operation is available for reconciliation.');
      if (saved.operation.lease && Date.parse(saved.operation.lease.expiresAt) > now.getTime()) fail('publication_busy', 'The current operation lease is still active.');
      const record = await this.repositories.operations.update(saved.id, saved.revision, { operation: { ...saved.operation, state: 'AMBIGUOUS',
        fencingGeneration: saved.operation.fencingGeneration + 1, blockedCode: 'publication_reconciliation_required',
        lease: { owner: input.workerId, expiresAt: new Date(now.getTime() + input.leaseSeconds * 1000).toISOString() } } }, { transaction });
      await this.audit(work, p!.id, 'publication.reconciliation-started', { operationId: saved.id, fencingGeneration: record.operation.fencingGeneration }, transaction);
      return record;
    });
  }

  /** The result always describes the dispatched snapshot, even after desired configuration changes. */
  async recordResult(input: PublicationCommandScope & { publicationId: string; operationId: string; fencingGeneration: number; workerId: string;
    result: 'confirmed' | 'failed' | 'uncertain'; binding?: PublicationRemoteBinding; failureEvidence?: { code: string; providerRequestId?: string } }): Promise<{ quarantined: boolean; record: PublicationDeliveryRecord }> {
    input = structuredClone(input);
    if (!['confirmed', 'failed', 'uncertain'].includes(input.result) || input.result === 'confirmed' && !input.binding
      || !isPublicationIdentifier(input.workerId) || !Number.isSafeInteger(input.fencingGeneration) || input.fencingGeneration < 1
      || input.binding && ![input.binding.providerNamespace, input.binding.objectType, input.binding.ownershipBoundary, input.binding.remoteId].every(isPublicationIdentifier)) {
      fail('invalid_request', 'A valid fenced provider result is required.');
    }
    const result = await this.transaction(async transaction => {
      const { work, publication: p } = await this.load(input, input.publicationId, 'record-result', transaction);
      const saved = await this.loadOperation(input, p!, transaction, false), op = saved.operation;
      const evidence = { operationId: saved.id, fencingGeneration: input.fencingGeneration, result: input.result,
        ...(input.binding ? { binding: { providerNamespace: input.binding.providerNamespace, objectType: input.binding.objectType,
          ownershipBoundary: input.binding.ownershipBoundary, remoteId: input.binding.remoteId } } : {}),
        ...(input.failureEvidence ? { failureCode: input.failureEvidence.code } : {}) };
      if (p!.activeOperationId !== saved.id || op.fencingGeneration !== input.fencingGeneration || op.lease?.owner !== input.workerId || !op.lease || Date.parse(op.lease.expiresAt) <= this.clock().getTime()) {
        const id = key('publication-audit', ['quarantined', work.instanceId, p!.id, evidence]);
        if (!await this.repositories.auditEvents.get(id, { transaction })) await this.repositories.auditEvents.create({ id, ...cell(work), instanceId: work.instanceId,
          action: 'publication.result-quarantined', subjectId: p!.id, payload: evidence }, { transaction });
        return { quarantined: true, record: saved };
      }
      if (!['IN_FLIGHT', 'AMBIGUOUS'].includes(op.state)) {
        if (op.state === 'CONFIRMED' && input.result === 'confirmed' && op.remoteId === input.binding?.remoteId) return { quarantined: false, record: saved };
        if (op.state === 'FAILED' && input.result === 'failed') return { quarantined: false, record: saved };
        fail('publication_reconciliation_required', 'The operation already has a final outcome.');
      }
      if (op.state === 'AMBIGUOUS' && input.result === 'uncertain') return { quarantined: false, record: saved };
      if (op.state === 'AMBIGUOUS' && input.result === 'failed') fail('publication_reconciliation_required', 'An uncertain provider write requires verified reconciliation.');
      if (input.result === 'failed') {
        if (!this.policy.verifyFinalFailure || !input.failureEvidence || !isPublicationIdentifier(input.failureEvidence.code)
          || input.failureEvidence.providerRequestId !== undefined && !isPublicationIdentifier(input.failureEvidence.providerRequestId)) {
          fail('publication_reconciliation_required', 'A verified final provider failure is required before retrying.');
        }
        await this.policy.verifyFinalFailure(structuredClone(op), input.failureEvidence, transaction);
      }
      let confirmedImage: PublicationImageDeliveryEvidence | undefined;
      let remoteId: string | undefined;
      if (input.result === 'confirmed') {
        const binding = await this.policy.verifyRemoteResult(structuredClone(op), input.binding!, transaction);
        if (binding.providerNamespace !== op.snapshot.account.providerNamespace || ![binding.objectType, binding.ownershipBoundary, binding.remoteId].every(isPublicationIdentifier)
          || binding.remoteId.startsWith('pending:')) fail('publication_identity_conflict', 'Verified result does not match this Publication.');
        remoteId = binding.remoteId;
        const remoteKey = key('remote', [input.instanceId, binding]);
        const claimed = await this.repositories.claims.get(remoteKey, { transaction });
        if (p!.remoteId && p!.remoteId !== binding.remoteId || claimed && claimed.publicationId !== p!.id) {
          if (op.blockedCode === 'publication_identity_conflict') return { quarantined: true, record: saved, identityConflict: true };
          const record = await this.repositories.operations.update(saved.id, saved.revision, { operation: { ...op, state: 'AMBIGUOUS', blockedCode: 'publication_identity_conflict' } }, { transaction });
          await this.audit(work, p!.id, 'publication.identity-conflict', evidence, transaction);
          return { quarantined: true, record, identityConflict: true };
        }
        if (!claimed) await this.repositories.claims.create(this.claim(work, p!.id, remoteKey, 'remote', publicationIdentityHash(binding)), { transaction });
        const s = op.snapshot;
        confirmedImage = { operationId: saved.id, confirmedAt: this.clock().toISOString(), imageFingerprint: s.imageFingerprint,
          sourceAssetId: s.source.assetId, sourceChecksum: s.source.checksum, fileChecksum: s.file.checksum, sizeBytes: s.file.sizeBytes,
          mimeType: s.file.mimeType, width: s.file.width, height: s.file.height, variant: s.variant, recipeFingerprint: s.recipeFingerprint,
          ...(s.watermarkFingerprint ? { watermarkFingerprint: s.watermarkFingerprint } : {}) };
      }
      const record = await this.repositories.operations.update(saved.id, saved.revision, { operation: { ...op,
        state: input.result === 'confirmed' ? 'CONFIRMED' : input.result === 'failed' ? 'FAILED' : 'AMBIGUOUS',
        blockedCode: input.result === 'uncertain' ? 'publication_reconciliation_required' : undefined,
        ...(remoteId ? { remoteId, confirmedImage } : {}) } }, { transaction });
      if (confirmedImage) await this.repositories.publications.update(p!.id, p!.revision, { remoteId, lastConfirmedImage: confirmedImage, status: 'live' }, { transaction });
      await this.audit(work, p!.id, `publication.${input.result}`, evidence, transaction);
      return { quarantined: false, record };
    });
    if ('identityConflict' in result) fail('publication_identity_conflict', 'The provider result conflicts with an existing Publication binding. Its evidence is retained for reconciliation.');
    return result;
  }
}

/** At-least-once queue submission. A crash after enqueue retries the same durable operation ID. */
export async function recoverPublicationOutbox(repositories: PublicationCommandRepositories,
  enqueue: (job: { operationId: string; publicationId: string; instanceId: string; schemaVersion: 1 }) => Promise<void>, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('invalid_request', 'Invalid outbox recovery limit.');
  let submitted = 0, failed = 0;
  for await (const entry of repositoryItems(request => repositories.outbox.list(request))) {
    if (entry.state !== 'pending') continue;
    if (submitted + failed >= limit) break;
    try {
      const op = await repositories.operations.get(entry.operationId);
      if (!op || op.instanceId !== entry.instanceId || op.operation.publicationId !== entry.publicationId || op.operation.schemaVersion !== 1) fail('publication_reconciliation_required', 'Outbox operation is invalid.');
      await enqueue({ operationId: entry.operationId, publicationId: entry.publicationId, instanceId: entry.instanceId, schemaVersion: 1 });
      await repositories.outbox.update(entry.id, entry.revision, { state: 'submitted' });
      submitted++;
    } catch { failed++; }
  }
  return { submitted, failed };
}
