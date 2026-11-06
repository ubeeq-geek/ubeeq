import { createHash, randomUUID } from 'node:crypto';
import { normalizeSlideshowSettings, slideshowDurationSeconds, slideshowDimensions, SlideshowError, type SlideshowSettings } from '@ubeeq/core';
import { repositoryItems, OptimisticConcurrencyError, type UbeeqRepositories, type AssetRecord, type CreatorRecord, type CollectionRecord, type WorkRecord, type PageRequest, type Page } from '@ubeeq/persistence';
import { cellScopedObjectKey, requireCreatorScopedObject, type ObjectStorage, type StoredObject } from '@ubeeq/storage';
import type { JobQueue } from '@ubeeq/jobs';
import type { SlideshowRenderer } from '@ubeeq/processing';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fail = (code: string, message: string): never => { throw new SlideshowError(code, message); };
type MediaAsset = AssetRecord & { storage?: StoredObject; originalStorage?: StoredObject };
interface Source {
  workId: string; workRevision: number; assetId: string; assetRevision: number;
  sourceVersionId: string; checksum: string; contentType: string; storage: StoredObject;
}
interface Snapshot { collectionId: string; collectionRevision: number; settings: SlideshowSettings; slides: Source[]; music: Source[] }
type SlideshowAsset = MediaAsset & { slideshow?: Snapshot; slideshowPending?: boolean; slideshowJobId?: string; renderMetadata?: { durationSeconds: number; width: number; height: number } };
const all = async <T>(repository: { list(request: PageRequest): Promise<Page<T>> }): Promise<T[]> => {
  const result: T[] = [];
  for await (const record of repositoryItems(request => repository.list(request))) result.push(record);
  return result;
};
const home = (record: CreatorRecord) => ({ homeCellId: record.homeCellId, dataHomeRegion: record.dataHomeRegion, dataHomeAssignedAt: record.dataHomeAssignedAt, routingRevision: record.routingRevision });

/** Reference composition of durable rendition records and jobs. No source bytes enter job JSON. */
export class ReferenceCollectionSlideshows {
  constructor(private readonly deps: {
    repositories: UbeeqRepositories; storage: ObjectStorage; jobs: JobQueue; cellId: string; renderer?: SlideshowRenderer;
    writable(creator: CreatorRecord): Promise<void>; admit(ids: readonly string[]): Promise<void>;
  }) {}

  private async collection(creator: CreatorRecord, id: string): Promise<CollectionRecord> {
    const collection = await this.deps.repositories.collections.get(id);
    if (creator.homeCellId !== this.deps.cellId || !collection || collection.creatorId !== creator.id || collection.homeCellId !== this.deps.cellId || collection.routingRevision !== creator.routingRevision) return fail('slideshow_not_found', 'Collection was not found.');
    await this.deps.writable(creator);
    return collection;
  }

  async catalogue(creator: CreatorRecord) {
    const collections = [];
    const memberships = await all(this.deps.repositories.workMemberships);
    for await (const collection of repositoryItems(request => this.deps.repositories.collections.list(request))) {
      if (collection.creatorId === creator.id && collection.homeCellId === this.deps.cellId) collections.push({ ...collection, workIds: memberships.filter(m => m.collectionId === collection.id).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map(m => m.workId) });
    }
    const works: WorkRecord[] = [];
    for await (const work of repositoryItems(request => this.deps.repositories.works.list(request))) {
      if (work.creatorId === creator.id && work.homeCellId === this.deps.cellId && !['deleted', 'archived'].includes(work.status)) works.push(work);
    }
    const music = (await all<MediaAsset>(this.deps.repositories.assets)).filter(a => a.creatorId === creator.id && a.homeCellId === this.deps.cellId && a.status === 'ready' && a.mimeType.startsWith('audio/') && works.some(w => w.id === a.workId)).map(a => ({ assetId: a.id, title: works.find(w => w.id === a.workId)?.title ?? a.id }));
    return { collections, works, music, slideshowEnabled: !!this.deps.renderer };
  }

  async replaceWorks(creator: CreatorRecord, id: string, workIds: unknown, expectedRevision: unknown) {
    const collection = await this.collection(creator, id);
    if (!Array.isArray(workIds) || workIds.length > 100 || workIds.some(w => typeof w !== 'string' || !w) || new Set(workIds).size !== workIds.length) return fail('invalid_slideshow', 'Choose up to 100 distinct Works in order.');
    if (expectedRevision !== collection.revision) return fail('slideshow_conflict', 'Collection changed; reload before saving its order.');
    for (const id of workIds) {
      const work = await this.deps.repositories.works.get(id);
      if (!work || work.creatorId !== creator.id || work.homeCellId !== this.deps.cellId || ['deleted', 'archived'].includes(work.status)) return fail('invalid_slideshow', 'Choose active Works owned by this Creator.');
    }
    return this.deps.repositories.transaction(async transaction => {
      const updated = await this.deps.repositories.collections.update(collection.id, collection.revision, { title: collection.title }, { transaction });
      const previous = [];
      for await (const member of repositoryItems(request => this.deps.repositories.workMemberships.list(request, { transaction }))) {
        if (member.collectionId === collection.id) previous.push(member);
      }
      for (const member of previous) await this.deps.repositories.workMemberships.remove(member.id, member.revision, { transaction });
      for (const [position, workId] of workIds.entries()) await this.deps.repositories.workMemberships.create({ id: randomUUID(), instanceId: collection.instanceId, ...home(creator), collectionId: id, workId, position }, { transaction });
      return { collection: updated, workIds };
    }).catch(error => {
      if (error instanceof OptimisticConcurrencyError) return fail('slideshow_conflict', 'Collection changed; reload before saving its order.');
      throw error;
    });
  }

  private async source(creator: CreatorRecord, asset: MediaAsset): Promise<Source> {
    const work = asset.workId ? await this.deps.repositories.works.get(asset.workId) : undefined;
    const storage = asset.originalStorage ?? asset.storage;
    if (!work || work.creatorId !== creator.id || work.homeCellId !== this.deps.cellId || work.routingRevision !== creator.routingRevision || ['deleted', 'archived'].includes(work.status) || asset.creatorId !== creator.id || asset.homeCellId !== this.deps.cellId || asset.routingRevision !== creator.routingRevision || asset.status !== 'ready' || !storage?.versionId || storage.versionId !== asset.objectVersion || storage.checksum !== asset.checksum || storage.contentType !== asset.mimeType || !Number.isSafeInteger(storage.byteLength) || storage.byteLength < 1) return fail('slideshow_source_unavailable', 'Slideshow sources must be ready, versioned assets owned by this Creator.');
    requireCreatorScopedObject(storage.key, { cellId: this.deps.cellId, creatorId: creator.id });
    return { workId: work.id, workRevision: work.revision, assetId: asset.id, assetRevision: asset.revision, sourceVersionId: asset.objectVersion, checksum: asset.checksum, contentType: asset.mimeType, storage: structuredClone(storage) };
  }

  private async snapshot(creator: CreatorRecord, id: string, settings: SlideshowSettings): Promise<Snapshot> {
    const collection = await this.collection(creator, id);
    const memberships = [];
    for await (const member of repositoryItems(request => this.deps.repositories.workMemberships.list(request))) if (member.collectionId === id) memberships.push(member);
    memberships.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const assets = (await all<MediaAsset>(this.deps.repositories.assets)).filter(a => a.creatorId === creator.id);
    const slides: Source[] = [];
    for (const member of memberships) {
      const images = assets.filter(a => a.workId === member.workId && a.status !== 'deleted').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (!images.length || images.some(a => !['image/jpeg', 'image/png', 'image/webp'].includes(a.mimeType))) return fail('invalid_slideshow', 'Every collection Work must contain only JPEG, PNG or WebP images.');
      for (const image of images) slides.push(await this.source(creator, image));
    }
    slideshowDurationSeconds(slides.length, settings);
    const music: Source[] = [];
    for (const track of settings.music) {
      const asset = assets.find(a => a.id === track.assetId);
      if (!asset?.mimeType.startsWith('audio/')) return fail('invalid_slideshow', 'Choose music uploaded by this Creator.');
      music.push(await this.source(creator, asset));
    }
    if ([...slides, ...music].reduce((sum, s) => sum + s.storage.byteLength, 0) > 256 * 1024 * 1024) return fail('invalid_slideshow', 'Slideshow sources must total at most 256 MiB.');
    await this.deps.admit([creator.id, collection.id, ...slides.flatMap(s => [s.workId, s.assetId]), ...music.flatMap(s => [s.workId, s.assetId])]);
    return { collectionId: id, collectionRevision: collection.revision, settings: structuredClone(settings), slides, music };
  }

  async request(creator: CreatorRecord, collectionId: string, body: Record<string, unknown>) {
    if (!this.deps.renderer) return fail('slideshow_unavailable', 'Slideshow rendering is not configured on this instance.');
    const settings = normalizeSlideshowSettings(body.settings);
    const snapshot = await this.snapshot(creator, collectionId, settings);
    if (settings.music.length && body.musicRightsConfirmed !== true) return fail('invalid_slideshow', 'Confirm permission to use the selected music on the destination platforms.');
    const requestId = body.requestId;
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) return fail('invalid_slideshow', 'A request ID of at most 200 characters is required.');
    const id = `slideshow-${hash([creator.id, collectionId, requestId])}`;
    let asset = await this.deps.repositories.assets.get(id) as SlideshowAsset | undefined;
    if (asset && hash(asset.slideshow) !== hash(snapshot)) return fail('slideshow_conflict', 'This request ID already belongs to different slideshow sources or settings.');
    if (!asset) asset = await this.deps.repositories.assets.create({ id, instanceId: creator.instanceId, ...home(creator), creatorId: creator.id, mimeType: 'video/mp4', checksum: hash(snapshot), objectVersion: hash(snapshot), status: 'pending', slideshow: snapshot, slideshowPending: true } as AssetRecord & { slideshow: Snapshot; slideshowPending: boolean }, { idempotencyKey: id }) as SlideshowAsset;
    if (hash(asset.slideshow) !== hash(snapshot)) return fail('slideshow_conflict', 'This request ID already belongs to different slideshow sources or settings.');
    await this.enqueue(asset);
    return { rendition: await this.status(creator, collectionId, id) };
  }

  private async enqueue(asset: SlideshowAsset): Promise<void> {
    if (!asset.slideshow || !asset.slideshowPending || asset.slideshowJobId) return;
    const job = await this.deps.jobs.enqueue({ cellId: this.deps.cellId, type: 'collection.slideshow', payload: { assetId: asset.id, creatorId: asset.creatorId, fingerprint: hash(asset.slideshow) }, idempotencyKey: asset.id, maxAttempts: 3 });
    // A competing dispatcher or worker can update the rendition while the queue persists.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.deps.repositories.assets.get(asset.id) as SlideshowAsset;
      if (current.slideshowJobId) return;
      try { await this.deps.repositories.assets.update(asset.id, current.revision, { slideshowJobId: job.id } as Partial<SlideshowAsset>); return; }
      catch (error) { if (!(error instanceof OptimisticConcurrencyError) || attempt === 2) throw error; }
    }
  }

  private async rendition(creator: CreatorRecord, collectionId: string, id: string): Promise<SlideshowAsset & { slideshow: Snapshot }> {
    await this.collection(creator, collectionId);
    const asset = await this.deps.repositories.assets.get(id) as SlideshowAsset | undefined;
    if (!asset?.slideshow || asset.creatorId !== creator.id || asset.homeCellId !== this.deps.cellId || asset.slideshow.collectionId !== collectionId || asset.status === 'deleted') return fail('slideshow_not_found', 'Slideshow rendition was not found.');
    return asset as SlideshowAsset & { slideshow: Snapshot };
  }

  async status(creator: CreatorRecord, collectionId: string, id: string) {
    const asset = await this.rendition(creator, collectionId, id);
    const job = asset.slideshowJobId ? await this.deps.jobs.get(asset.slideshowJobId) : undefined;
    let stale = false;
    try { stale = hash(await this.snapshot(creator, collectionId, asset.slideshow.settings)) !== hash(asset.slideshow); } catch { stale = true; }
    const state = asset.status === 'ready' && job?.state === 'completed' ? 'completed' : job?.state ?? (asset.slideshowPending ? 'queued' : 'unavailable');
    return { id: asset.id, state, stale, settings: asset.slideshow.settings, imageCount: asset.slideshow.slides.length,
      durationSeconds: slideshowDurationSeconds(asset.slideshow.slides.length, asset.slideshow.settings), ...asset.renderMetadata,
      ...(job?.lastError ? { error: 'Slideshow rendering failed. Check the sources and regenerate, or contact the instance administrator.' } : {}),
      ...(state === 'completed' && !stale ? { downloadPath: `/v1/collections/${encodeURIComponent(collectionId)}/slideshows/${encodeURIComponent(id)}/content` } : {}) };
  }

  async list(creator: CreatorRecord, collectionId: string) {
    await this.collection(creator, collectionId);
    const renditions = [];
    for (const asset of await all<SlideshowAsset>(this.deps.repositories.assets)) if (asset.creatorId === creator.id && asset.slideshow?.collectionId === collectionId && asset.status !== 'deleted') renditions.push(await this.status(creator, collectionId, asset.id));
    return { renditions };
  }

  async download(creator: CreatorRecord, collectionId: string, id: string) {
    const asset = await this.rendition(creator, collectionId, id);
    if (!(await this.status(creator, collectionId, id)).downloadPath || !asset.storage) return fail('slideshow_conflict', 'This video is unavailable or needs regeneration.');
    await this.deps.admit([creator.id, collectionId, id, ...asset.slideshow.slides.flatMap(s => [s.workId, s.assetId]), ...asset.slideshow.music.flatMap(s => [s.workId, s.assetId])]);
    const output = await this.deps.storage.get(asset.storage);
    if (output.body.byteLength !== asset.storage.byteLength || digest(output.body) !== asset.checksum) return fail('slideshow_source_unavailable', 'Slideshow bytes failed integrity validation.');
    if (!(await this.status(creator, collectionId, id)).downloadPath) return fail('slideshow_conflict', 'The collection changed while downloading.');
    await this.deps.admit([creator.id, collectionId, id, ...asset.slideshow.slides.flatMap(s => [s.workId, s.assetId]), ...asset.slideshow.music.flatMap(s => [s.workId, s.assetId])]);
    return output.body;
  }

  async runNextJob(workerId: string) {
    if (!this.deps.renderer) return undefined;
    // The pending asset is an outbox record. Recover a crash between rendition creation and queue persistence.
    for (const asset of await all<SlideshowAsset>(this.deps.repositories.assets)) {
      if (asset.homeCellId === this.deps.cellId && asset.slideshowPending && asset.slideshow && asset.status !== 'deleted' && !asset.slideshowJobId) await this.enqueue(asset);
    }
    const lease = await this.deps.jobs.lease<{ assetId: string; creatorId: string; fingerprint: string }>({ cellId: this.deps.cellId, types: ['collection.slideshow'], workerId, leaseDurationSeconds: 600 });
    if (!lease) return undefined;
    let output: StoredObject | undefined;
    try {
      if (lease.job.cellId !== this.deps.cellId) throw new Error('Foreign slideshow job rejected.');
      const creator = await this.deps.repositories.creators.get(lease.job.payload.creatorId);
      if (!creator) throw new Error('Slideshow owner is unavailable.');
      let asset = await this.rendition(creator, (await this.deps.repositories.assets.get(lease.job.payload.assetId) as SlideshowAsset)?.slideshow?.collectionId ?? '', lease.job.payload.assetId);
      if (hash(asset.slideshow) !== lease.job.payload.fingerprint) throw new Error('Slideshow job does not match its source snapshot.');
      const assertCurrent = async () => {
        const job = await this.deps.jobs.get(lease.job.id);
        if (job?.state !== 'leased' || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now() || job.attempt !== lease.job.attempt) throw new Error('Slideshow lease is no longer current.');
        if (hash(await this.snapshot(creator, asset.slideshow.collectionId, asset.slideshow.settings)) !== hash(asset.slideshow)) return fail('slideshow_conflict', 'Collection or sources changed; regenerate the slideshow.');
      };
      await assertCurrent();
      if (asset.status !== 'ready') {
        const read = async (source: Source) => {
          const result = await this.deps.storage.get(source.storage);
          if (result.body.byteLength !== source.storage.byteLength || digest(result.body) !== source.checksum) throw new Error('Slideshow source integrity validation failed.');
          return { source: result.body, contentType: source.contentType };
        };
        const slides = [], music = [];
        for (const source of asset.slideshow.slides) slides.push(await read(source));
        for (const source of asset.slideshow.music) music.push(await read(source));
        const result = await this.deps.renderer.render({ settings: asset.slideshow.settings, slides, music });
        const expected = slideshowDimensions(asset.slideshow.settings.format);
        if (result.contentType !== 'video/mp4' || !result.body.length || result.body.length > 512 * 1024 * 1024 || result.width !== expected.width || result.height !== expected.height || !Number.isFinite(result.durationSeconds) || Math.abs(result.durationSeconds - slideshowDurationSeconds(slides.length, asset.slideshow.settings)) > 1 / 30) throw new Error('Invalid slideshow renderer result.');
        await assertCurrent();
        output = { bucket: asset.slideshow.slides[0].storage.bucket, key: cellScopedObjectKey({ cellId: this.deps.cellId, creatorId: creator.id, kind: 'renditions', objectId: `${asset.id}-${randomUUID()}.mp4` }), versionId: randomUUID(), contentType: 'video/mp4', byteLength: result.body.byteLength, checksum: digest(result.body), scope: 'private' };
        await this.deps.storage.put({ object: output, body: result.body });
        await assertCurrent();
        const current = await this.deps.repositories.assets.get(asset.id) as SlideshowAsset;
        const stored = output;
        asset = await this.deps.repositories.transaction(async transaction => {
          const ready = await this.deps.repositories.assets.update(asset.id, current.revision, { status: 'ready', checksum: stored.checksum!, objectVersion: stored.versionId!, storage: stored, renderMetadata: { durationSeconds: result.durationSeconds, width: result.width, height: result.height } } as Partial<SlideshowAsset>, { transaction });
          await this.deps.repositories.usageEvents.create({ id: randomUUID(), instanceId: asset.instanceId, ...home(creator), accountId: creator.id, meter: 'transcode_seconds', quantity: result.durationSeconds, idempotencyKey: asset.id }, { transaction, idempotencyKey: asset.id });
          await this.deps.repositories.auditEvents.create({ id: randomUUID(), instanceId: asset.instanceId, ...home(creator), action: 'collection.slideshow_rendered', subjectId: asset.slideshow.collectionId, payload: { renditionId: asset.id, sourceFingerprint: lease.job.payload.fingerprint, jobId: lease.job.id } }, { transaction, idempotencyKey: asset.id });
          return ready as typeof asset;
        });
      }
      await assertCurrent();
      await this.deps.jobs.complete({ id: lease.job.id, leaseToken: lease.leaseToken });
      output = undefined; // A committed rendition is now retained.
      return { rendition: await this.status(creator, asset.slideshow.collectionId, asset.id) };
    } catch (error) {
      // If a ready record was saved before an interrupted completion, retain its bytes for recovery.
      const saved = await this.deps.repositories.assets.get(lease.job.payload.assetId) as SlideshowAsset | undefined;
      if (output && saved?.storage?.key !== output.key) await this.deps.storage.remove(output).catch(() => undefined);
      const details = { code: error instanceof SlideshowError ? error.code : 'slideshow_render_failed', message: 'Slideshow could not be rendered. Regenerate after checking its sources.' };
      if (error instanceof SlideshowError || lease.job.attempt >= lease.job.maxAttempts) await this.deps.jobs.deadLetter({ id: lease.job.id, leaseToken: lease.leaseToken, error: details });
      else await this.deps.jobs.retry({ id: lease.job.id, leaseToken: lease.leaseToken, retryAt: new Date(Date.now() + 1000).toISOString(), error: details });
      throw error;
    }
  }
}
