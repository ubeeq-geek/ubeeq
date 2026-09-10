import type { CreatorContentRecords, CreatorContentStore } from "./creator-content.js";
import { CreatorContentListBudgetError, creatorContentListBudget, type CreatorContentListOptions } from './creator-content.js';
import { CreatorContentCommitError, type CreatorContentAssetCommit } from "./creator-content.js";
import type { CreatorContentSourceReceipt, CreatorContentReuseCommit, CreatorContentSourceReuseStore } from './creator-content.js';

/**
 * Reference in-memory adapter, also used by local snapshot-backed compositions.
 * It does not claim persistence or transaction durability. Durable adapters must
 * implement the same content port. The enumerable arrays retain snapshot compatibility.
 */
export class MemoryCreatorContentStore<M extends CreatorContentRecords = CreatorContentRecords> implements CreatorContentStore<M>, CreatorContentSourceReuseStore<M> {
  works: M['work'][] = [];
  canonicalAssets: M['asset'][] = [];
  workAssets: Array<M['attachment'] & { tenantId: string }> = [];
  publications: M['publication'][] = [];
  publicationIntents: M['intent'][] = [];
  creatorCollections: M['collection'][] = [];
  collectionWorks: Array<M['collectionWork'] & { tenantId: string }> = [];
  workDiscovery: M['discovery'][] = [];
  sourceReceipts: CreatorContentSourceReceipt[] = [];

  async getSourceReceipt(tenantId: string, receiptId: string): Promise<CreatorContentSourceReceipt | null> {
    return structuredClone(this.sourceReceipts.find(receipt => receipt.tenantId === tenantId && receipt.receiptId === receiptId) || null);
  }

  async commitSourceReuse(input: CreatorContentReuseCommit<M>): Promise<void> {
    const { work, expectedAsset, attachment, receipt } = input;
    const fail = () => { throw new CreatorContentCommitError('Source reuse custody, receipt or Work revision changed.'); };
    const previous = this.works.find(item => item.tenantId === work.tenantId && item.workId === work.workId) as (M['work'] & { revision?: number }) | undefined;
    const asset = this.canonicalAssets.find(item => item.tenantId === work.tenantId && item.assetId === expectedAsset.assetId) as (M['asset'] & { status?: string; checksumSha256?: string }) | undefined;
    if (!previous || previous.creatorId !== work.creatorId || ['deleted', 'archived'].includes(previous.status) ||
      !asset || asset.creatorId !== work.creatorId || asset.status === 'deleted' || asset.checksumSha256 !== receipt.checksum ||
      expectedAsset.tenantId !== work.tenantId || expectedAsset.creatorId !== work.creatorId ||
      receipt.tenantId !== work.tenantId || receipt.creatorId !== work.creatorId || receipt.workId !== work.workId ||
      receipt.assetId !== asset.assetId || !receipt.receiptId || !receipt.sourceIdentity || !/^[a-f0-9]{64}$/.test(receipt.checksum) ||
      attachment.workId !== work.workId || attachment.assetId !== asset.assetId) return fail();
    const members = this.workAssets.filter(item => item.tenantId === work.tenantId && item.workId === work.workId);
    const saved = this.sourceReceipts.find(item => item.tenantId === receipt.tenantId && item.receiptId === receipt.receiptId);
    if (saved) {
      if (Object.keys(receipt).some(key => receipt[key as keyof CreatorContentSourceReceipt] !== saved[key as keyof CreatorContentSourceReceipt]) ||
        !members.some(item => item.assetId === receipt.assetId)) return fail();
      return; // Preserve later creator edits; never recreate a removed membership.
    }
    const source = this.works.find(item => item.tenantId === work.tenantId && item.workId === input.sourceWorkId);
    if (!source || source.creatorId !== work.creatorId || ['deleted', 'archived'].includes(source.status) ||
      !this.workAssets.some(item => item.tenantId === work.tenantId && item.workId === input.sourceWorkId && item.assetId === asset.assetId) ||
      JSON.stringify(asset) !== JSON.stringify(expectedAsset) || previous.revision !== input.previousRevision ||
      !Number.isSafeInteger(input.previousRevision) || input.previousRevision < 1 || work.revision !== input.previousRevision + 1 ||
      members.some(item => item.assetId === asset.assetId) || attachment.position !== (members.length ? Math.max(...members.map(item => item.position)) + 1 : 0)) return fail();
    const nextWorks = this.works.map(item => item === previous ? structuredClone(work) : item);
    const nextMembers = [...this.workAssets, { ...structuredClone(attachment), tenantId: work.tenantId }];
    const nextReceipts = [...this.sourceReceipts, structuredClone(receipt)];
    // Stage all fallible cloning before synchronously replacing state. The caller
    // owns durable checkpointing; this reference adapter does not promise disk I/O.
    this.works = nextWorks; this.workAssets = nextMembers; this.sourceReceipts = nextReceipts;
  }

  protected async validatePublication(_previous: M['publication'] | null, _next: M['publication']): Promise<void> {}
  async commitAssetAttachment(input: CreatorContentAssetCommit<M>): Promise<void> {
    const { work, asset, attachment } = input;
    const previous = this.works.find((item) => item.tenantId === work.tenantId && item.workId === work.workId) as (M['work'] & { revision?: number }) | undefined;
    if (!previous || previous.revision !== input.previousRevision || work.revision !== input.previousRevision + 1 ||
      previous.creatorId !== work.creatorId || previous.status === 'deleted' || asset.tenantId !== work.tenantId ||
      asset.creatorId !== work.creatorId || attachment.workId !== work.workId || attachment.assetId !== asset.assetId ||
      this.canonicalAssets.some((item) => item.tenantId === asset.tenantId && item.assetId === asset.assetId)) {
      throw new CreatorContentCommitError('Work changed or uploaded asset conflicts with stored state.');
    }
    const attachments = this.workAssets.filter((item) => item.tenantId === work.tenantId && item.workId === work.workId);
    if (attachment.position !== (attachments.length ? Math.max(...attachments.map(item => item.position)) + 1 : 0)) throw new CreatorContentCommitError('Work attachment order changed.');
    const nextWorks = this.works.map((item) => item === previous ? work : item);
    const nextAssets = [...this.canonicalAssets, asset];
    const nextAttachments = [...this.workAssets, { ...attachment, tenantId: work.tenantId }];
    // Synchronous staged replacement: no awaited callback or partial write path.
    this.works = nextWorks;
    this.canonicalAssets = nextAssets;
    this.workAssets = nextAttachments;
  }
  private creatorList<T extends { tenantId: string; creatorId: string; status: string }>(records: readonly T[], tenantId: string, creatorId: string, options: CreatorContentListOptions): T[] {
    const budget = creatorContentListBudget(options), result: T[] = []; let evaluated = 0;
    for (const record of records) {
      if (record.tenantId !== tenantId || record.creatorId !== creatorId) continue;
      if (++evaluated > budget) throw new CreatorContentListBudgetError();
      if (options.includeDeleted === true || record.status !== 'deleted') result.push(record);
    }
    return result;
  }
  async listWorksByCreator(tenantId: string, creatorId: string, options: CreatorContentListOptions = {}): Promise<M['work'][]> {
    return this.creatorList(this.works, tenantId, creatorId, options)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getWork(tenantId: string, workId: string): Promise<M['work'] | null> {
    return this.works.find((work) => work.tenantId === tenantId && work.workId === workId) || null;
  }

  async createWork(work: M['work']): Promise<void> {
    this.works = this.works.filter((item) => !(item.tenantId === work.tenantId && item.workId === work.workId));
    this.works.push(work);
  }

  async updateWork(work: M['work']): Promise<void> { await this.createWork(work); }
  async commitWorkRevision(work: M['work'] & { revision: number }, expectedRevision: number): Promise<void> {
    const previous = this.works.find((item) => item.tenantId === work.tenantId && item.workId === work.workId) as (M['work'] & { revision?: number }) | undefined;
    if (!previous || previous.revision !== expectedRevision || work.revision !== expectedRevision + 1 || previous.creatorId !== work.creatorId) {
      throw new CreatorContentCommitError('Work changed before this revision could be committed.');
    }
    this.works = this.works.map((item) => item === previous ? work : item);
  }

  async listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<M['asset'] & { attachment: M['attachment'] }>> {
    return this.workAssets
      .filter((attachment) => attachment.tenantId === tenantId && attachment.workId === workId)
      .sort((a, b) => a.position - b.position)
      .map((attachment) => {
        const asset = this.canonicalAssets.find((candidate) => candidate.tenantId === tenantId && candidate.assetId === attachment.assetId);
        const { tenantId: _attachmentTenantId, ...publicAttachment } = attachment;
        return asset ? { ...asset, attachment: publicAttachment as M['attachment'] } : null;
      })
      .filter((asset): asset is M['asset'] & { attachment: M['attachment'] } => Boolean(asset));
  }

  async getCanonicalAsset(tenantId: string, assetId: string): Promise<M['asset'] | null> {
    return this.canonicalAssets.find((asset) => asset.tenantId === tenantId && asset.assetId === assetId) || null;
  }

  async listCanonicalAssetsByCreator(tenantId: string, creatorId: string): Promise<M['asset'][]> {
    return structuredClone(this.canonicalAssets.filter(asset => asset.tenantId === tenantId && asset.creatorId === creatorId));
  }

  async createCanonicalAsset(asset: M['asset']): Promise<void> {
    this.canonicalAssets = this.canonicalAssets.filter((item) => !(item.tenantId === asset.tenantId && item.assetId === asset.assetId));
    this.canonicalAssets.push(asset);
  }

  async updateCanonicalAsset(asset: M['asset']): Promise<void> { await this.createCanonicalAsset(asset); }

  async attachAssetToWork(tenantId: string, attachment: M['attachment']): Promise<void> {
    this.workAssets = this.workAssets.filter((item) => !(item.tenantId === tenantId && item.workId === attachment.workId && item.assetId === attachment.assetId));
    this.workAssets.push({ ...attachment, tenantId });
  }

  async detachAssetFromWork(tenantId: string, workId: string, assetId: string): Promise<void> {
    this.workAssets = this.workAssets.filter((item) => !(item.tenantId === tenantId && item.workId === workId && item.assetId === assetId));
  }

  async listPublicationsByWork(tenantId: string, workId: string): Promise<M['publication'][]> {
    return this.publications
      .filter((publication) => publication.tenantId === tenantId && publication.workId === workId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listPublicationsByDestination(tenantId: string, destination: M['publication']['destination']): Promise<M['publication'][]> {
    return this.publications
      .filter((publication) => publication.tenantId === tenantId && publication.destination === destination)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getPublication(tenantId: string, publicationId: string): Promise<M['publication'] | null> {
    return this.publications.find((publication) => publication.tenantId === tenantId && publication.publicationId === publicationId) || null;
  }

  async upsertPublication(publication: M['publication']): Promise<void> {
    await this.validatePublication(await this.getPublication(publication.tenantId, publication.publicationId), publication);
    this.publications = this.publications.filter((item) => !(item.tenantId === publication.tenantId && item.publicationId === publication.publicationId));
    this.publications.push(publication);
  }

  async listPublicationIntentsByWork(tenantId: string, workId: string): Promise<M['intent'][]> {
    return this.publicationIntents.filter((intent) => intent.tenantId === tenantId && intent.workId === workId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getPublicationIntent(tenantId: string, publicationIntentId: string): Promise<M['intent'] | null> {
    return this.publicationIntents.find((intent) => intent.tenantId === tenantId && intent.publicationIntentId === publicationIntentId) || null;
  }

  async upsertPublicationIntent(intent: M['intent']): Promise<void> {
    this.publicationIntents = this.publicationIntents.filter((item) => !(item.tenantId === intent.tenantId && item.publicationIntentId === intent.publicationIntentId));
    this.publicationIntents.push(intent);
  }

  async deletePublicationIntent(tenantId: string, publicationIntentId: string): Promise<void> {
    this.publicationIntents = this.publicationIntents.filter((intent) => !(intent.tenantId === tenantId && intent.publicationIntentId === publicationIntentId));
  }

  async listCreatorCollections(tenantId: string, creatorId: string, options: CreatorContentListOptions = {}): Promise<M['collection'][]> {
    return this.creatorList(this.creatorCollections, tenantId, creatorId, options)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async getCreatorCollection(tenantId: string, collectionId: string): Promise<M['collection'] | null> {
    return this.creatorCollections.find((collection) => collection.tenantId === tenantId && collection.collectionId === collectionId) || null;
  }

  async createCreatorCollection(collection: M['collection']): Promise<void> {
    this.creatorCollections = this.creatorCollections.filter((item) => !(item.tenantId === collection.tenantId && item.collectionId === collection.collectionId));
    this.creatorCollections.push(collection);
  }

  async updateCreatorCollection(collection: M['collection']): Promise<void> { await this.createCreatorCollection(collection); }

  async listCollectionWorks(tenantId: string, collectionId: string): Promise<M['collectionWork'][]> {
    const collection = await this.getCreatorCollection(tenantId, collectionId);
    if (!collection) return [];
    return this.collectionWorks.filter((item) => item.tenantId === tenantId && item.collectionId === collectionId).sort((a, b) => a.position - b.position);
  }

  async replaceCollectionWorks(tenantId: string, collectionId: string, works: M['collectionWork'][]): Promise<void> {
    if (!(await this.getCreatorCollection(tenantId, collectionId))) throw new Error('Collection not found');
    this.collectionWorks = [
      ...this.collectionWorks.filter((item) => !(item.tenantId === tenantId && item.collectionId === collectionId)),
      ...works.map((item) => ({ ...item, tenantId }))
    ];
  }

  async getWorkDiscoveryParticipation(tenantId: string, workId: string): Promise<M['discovery'] | null> {
    return this.workDiscovery.find((item) => item.tenantId === tenantId && item.workId === workId) || null;
  }

  async upsertWorkDiscoveryParticipation(participation: M['discovery']): Promise<void> {
    this.workDiscovery = this.workDiscovery.filter((item) => !(item.tenantId === participation.tenantId && item.workId === participation.workId));
    this.workDiscovery.push(participation);
  }


}
