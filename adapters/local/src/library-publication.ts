import { CreatorWorkError, type CreatorAssetAttachment, type CreatorAssetRecord, type CreatorWorkRecord } from '@ubeeq/core';
import { OptimisticConcurrencyError, type AssetRecord, type CreatorRecord, type PageRequest, type PersistenceTransaction, type WorkRecord } from '@ubeeq/persistence';
import { createLocalRepositories, type LocalSqliteDatabase } from './index.js';

type AttachedAsset = CreatorAssetRecord & { attachment: CreatorAssetAttachment };
type Snapshot = { work: CreatorWorkRecord; creator: CreatorRecord; assets: AttachedAsset[] };

/** Request-scoped publication view over the existing library, not a second copy of its records.
 * Authorization and product admission belong in PublicationService callbacks. Selection is
 * explicit: only a persisted, current-source rendition can become a delivery object. A poster
 * does not qualify its original video for delivery. Do not reuse this view between requests.
 */
export class LocalLibraryPublicationView {
  private snapshot?: Snapshot;
  private selected?: AssetRecord[];
  private transactionId?: string;
  readonly publicationIntents;
  readonly publications;
  readonly auditEvents;

  constructor(private readonly local: LocalSqliteDatabase,
    private readonly scope: { tenantId: string; creatorId: string; workId: string },
    private readonly selectRendition: (asset: Readonly<AttachedAsset>) => string | undefined) {
    this.scope = { ...scope };
    const repositories = createLocalRepositories(local);
    this.publicationIntents = repositories.publicationIntents;
    this.publications = repositories.publications;
    this.auditEvents = repositories.auditEvents;
  }

  private read<T>(kind: string, id: string): T | undefined {
    const row = this.local.database.prepare("SELECT payload FROM ubeeq_creator_library WHERE cell_id = ? AND tenant_id = ? AND kind = ? AND id = ? AND creator_id = ?")
      .get(this.local.configuration.cellId, this.scope.tenantId, kind, id, this.scope.creatorId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  private current(): Snapshot {
    const { tenantId, creatorId, workId } = this.scope;
    const work = this.read<CreatorWorkRecord>('work', workId);
    const row = this.local.database.prepare("SELECT payload FROM ubeeq_records WHERE repository = 'creators' AND id = ?")
      .get(creatorId) as { payload: string } | undefined;
    const creator = row ? JSON.parse(row.payload) as CreatorRecord : undefined;
    if (!work || work.workId !== workId || work.tenantId !== tenantId || work.creatorId !== creatorId ||
      !['draft', 'ready', 'published'].includes(work.status) || !creator || creator.id !== creatorId ||
      creator.instanceId !== tenantId || creator.homeCellId !== this.local.configuration.cellId) {
      throw new CreatorWorkError('not_found', 'Publishable Work not found.');
    }
    const attachments = this.read<CreatorAssetAttachment[]>('work_assets', workId) || [];
    if (new Set(attachments.map(item => item.assetId)).size !== attachments.length) throw new Error('Duplicate Work asset membership.');
    const assets = attachments.map(attachment => {
      const asset = this.read<CreatorAssetRecord>('asset', attachment.assetId);
      if (!asset || asset.assetId !== attachment.assetId || asset.tenantId !== tenantId || asset.creatorId !== creatorId || attachment.workId !== workId) {
        throw new Error('Work asset membership or ownership is invalid.');
      }
      return { ...asset, attachment };
    });
    return { work, creator, assets };
  }

  private home(creator: CreatorRecord) {
    return { instanceId: creator.instanceId, homeCellId: creator.homeCellId, dataHomeRegion: creator.dataHomeRegion,
      dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: creator.routingRevision };
  }

  private projectWork({ work, creator }: Snapshot): WorkRecord {
    return { ...work, ...this.home(creator), id: work.workId, status: work.status as WorkRecord['status'] };
  }

  private projectAsset(asset: AttachedAsset, creator: CreatorRecord): AssetRecord {
    const processing = asset.processing;
    const renditionId = this.selectRendition(structuredClone(asset));
    const rendition = processing?.renditions.find(item => item.id === renditionId);
    const object = rendition?.storage;
    const ready = ['pending', 'processing', 'ready'].includes(asset.status) && processing?.state === 'completed' &&
      asset.storage?.scope === 'private' && !!asset.storage.versionId && processing.sourceVersionId === asset.storage.versionId &&
      rendition?.sourceVersionId === asset.storage.versionId && object?.scope === 'private' &&
      !!object.bucket && !!object.key && !!object.versionId && !!object.contentType &&
      Number.isSafeInteger(object.byteLength) && object.byteLength > 0 && /^[a-f0-9]{64}$/.test(object.checksum);
    // Never spread the original asset: only the explicitly selected derivative is deliverable.
    return { id: asset.assetId, ...this.home(creator), creatorId: asset.creatorId, workId: this.scope.workId,
      revision: 1, createdAt: asset.createdAt, updatedAt: asset.updatedAt,
      mimeType: ready ? object!.contentType : asset.mimeType, checksum: ready ? object!.checksum : '',
      objectVersion: ready ? object!.versionId : '', status: ready ? 'ready' : 'pending',
      ...(ready ? { storage: structuredClone(object), sourceVersionId: asset.storage.versionId, renditionId } : {}) };
  }

  readonly works = {
    get: async (id: string): Promise<WorkRecord | undefined> => id === this.scope.workId ? this.projectWork(this.current()) : undefined,
    update: async (id: string, revision: number, change: Partial<Omit<WorkRecord, 'id' | 'revision' | 'createdAt' | 'updatedAt'>>,
      options?: { transaction?: PersistenceTransaction }): Promise<WorkRecord> => {
      if (!this.transactionId || options?.transaction?.id !== this.transactionId) throw new Error('Library publication requires its owned transaction.');
      if (id !== this.scope.workId || change.status !== 'published' || Object.keys(change).some(key => key !== 'status')) throw new Error('Publication view only supports publishing its bound Work.');
      const current = this.current();
      if (!this.snapshot || JSON.stringify(current) !== JSON.stringify(this.snapshot) || current.work.revision !== revision) throw new OptimisticConcurrencyError(id, revision);
      const next = { ...current.work, status: 'published', revision: revision + 1, updatedAt: new Date().toISOString() };
      const result = this.local.database.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'work' AND id = ? AND creator_id = ? AND json_extract(payload, '$.revision') = ?")
        .run(JSON.stringify(next), this.local.configuration.cellId, this.scope.tenantId, id, this.scope.creatorId, revision);
      if (result.changes !== 1) throw new OptimisticConcurrencyError(id, revision);
      return this.projectWork({ ...current, work: next });
    }
  };

  readonly assets = {
    list: async (request: PageRequest) => {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new Error('Invalid publication page size.');
      if (!this.snapshot) {
        this.snapshot = this.current();
        this.selected = this.snapshot.assets.map(asset => this.projectAsset(asset, this.snapshot!.creator));
      }
      const offset = request.cursor === undefined ? 0 : Number(request.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid publication cursor.');
      const end = offset + Math.min(request.limit, 100);
      return { items: structuredClone(this.selected!.slice(offset, end)), ...(end < this.selected!.length ? { nextCursor: String(end) } : {}) };
    }
  };

  async transaction<T>(operation: (transaction: PersistenceTransaction) => Promise<T>): Promise<T> {
    return this.local.transaction(async transaction => {
      if (this.transactionId) throw new Error('Publication view transaction already active.');
      this.transactionId = transaction.id;
      try { return await operation(transaction); }
      finally { this.transactionId = undefined; }
    });
  }
}
