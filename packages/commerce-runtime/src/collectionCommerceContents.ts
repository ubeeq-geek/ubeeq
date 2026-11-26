import { createHash } from 'node:crypto';
import type { CommercePorts, Offer, PrivateAsset } from '@ubeeq/commerce';
import { CommerceError } from '@ubeeq/commerce';
import type { ObjectStorage, StoredObject } from '@ubeeq/storage';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export interface CollectionCommerceCollection {
  collectionId: string;
  revision?: number;
  title: string;
  description?: string;
  volumeIds?: readonly string[];
}

export interface CollectionCommerceWork {
  workId: string;
  creatorId: string;
  revision: number;
  kind: string;
  deletedAt?: string;
  title: string;
}

export interface CollectionCommerceAsset {
  assetId: string;
  kind: string;
  status: string;
  mimeType: string;
  originalFilename?: string;
  checksumSha256?: string;
  storage?: unknown;
  deletedAt?: string;
  replacedByAssetId?: string;
}

export interface CollectionCommerceStore {
  getCreatorById(id: string): Promise<{ id: string; status: string; deletion?: boolean } | undefined>;
  listCreatorCollections(tenantId: string, creatorId: string): Promise<CollectionCommerceCollection[]>;
  listCollectionWorks(tenantId: string, collectionId: string): Promise<Array<{ workId: string; position: number }>>;
  getWork(tenantId: string, workId: string): Promise<CollectionCommerceWork | undefined>;
  listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<CollectionCommerceAsset[]>;
  readPublishingSource?(asset: CollectionCommerceAsset): Promise<Uint8Array>;
}

export const collectionContentRevision = (
  collections: CollectionCommerceCollection[],
  works: Array<{ work: CollectionCommerceWork; sources: CollectionCommerceAsset[] }>
): string =>
  hash(
    JSON.stringify({
      collections: collections.map((c) => [c.collectionId, c.revision ?? 0, c.title, c.description, c.volumeIds]),
      works: works.map(({ work, sources }) => [
        work.workId,
        work.revision,
        work.title,
        sources.map((a) => [a.assetId, a.checksumSha256, a.mimeType, a.originalFilename, a.storage]),
      ]),
    })
  );

export function collectionCommerceContents(
  store: CollectionCommerceStore,
  config: { tenantId: string },
  storage: ObjectStorage,
  allowed: (work: CollectionCommerceWork) => Promise<boolean>,
  creatorAllowed: (id: string) => Promise<boolean>,
  readSource?: (asset: CollectionCommerceAsset) => Promise<Uint8Array>
): NonNullable<CommercePorts['prepareCollectionContents']> {
  const read = readSource ?? store.readPublishingSource ?? (async () => new Uint8Array());

  return async (offer: Offer) => {
    if (offer.billing) return undefined;
    const creator = await store.getCreatorById(offer.ownerId);
    if (!creator || creator.status !== 'active' || creator.deletion || !(await creatorAllowed(offer.ownerId))) {
      throw new CommerceError('collection_unavailable', 409);
    }

    const all = await store.listCreatorCollections(config.tenantId, offer.ownerId);
    const rootIds =
      offer.collectionRoots ??
      offer.benefits
        .filter((b) => b.type === 'gallery')
        .slice(0, 1)
        .map((b) => b.resourceId);

    if (!rootIds.length || (!offer.collectionRoots && rootIds.some((id) => !all.some((c) => c.collectionId === id)))) {
      return undefined;
    }

    const roots = rootIds.map((id) => {
      const c = all.find((item) => item.collectionId === id);
      if (!c) throw new CommerceError('collection_unavailable', 409);
      return c;
    });

    const collectionWorks = await Promise.all(
      roots.map(async (root) => {
        const works = (await store.listCollectionWorks(config.tenantId, root.collectionId))
          .sort((a, b) => a.position - b.position)
          .map((m) => m.workId);
        return { root, workIds: works };
      })
    );

    const collections = roots;
    const uniqueWorkIds = [...new Set(collectionWorks.flatMap((cw) => cw.workIds))];

    const works = await Promise.all(
      uniqueWorkIds.map(async (id) => {
        const work = await store.getWork(config.tenantId, id);
        if (!work || work.creatorId !== offer.ownerId || work.deletedAt || work.kind !== 'image' || !(await allowed(work))) {
          throw new CommerceError('collection_work_unavailable', 409);
        }
        const assets = await store.listCanonicalAssetsByWork(config.tenantId, id);
        const sources = assets.filter((a) => a.kind === 'image' && a.status === 'ready' && !a.deletedAt);
        if (!sources.length) throw new CommerceError('collection_image_unavailable', 409);
        return { work, sources };
      })
    );

    const revision = collectionContentRevision(collections, works);
    if (revision === offer.contentSourceRevision) return undefined;

    const assets: Array<Omit<PrivateAsset, 'id' | 'deploymentId' | 'ownerId' | 'environment' | 'createdAt' | 'updatedAt'>> = [];
    for (const { work, sources } of works) {
      for (const source of sources) {
        const bytes = await read(source);
        const checksum = hash(bytes);
        const key =
          'cells/' +
          config.tenantId +
          '/creators/' +
          offer.ownerId +
          '/uploads/commerce-source-' +
          hash(source.assetId + ':' + checksum);
        const object: StoredObject = {
          bucket: config.tenantId,
          key,
          versionId: checksum,
          scope: 'private',
          contentType: source.mimeType,
          byteLength: bytes.length,
          checksum,
        };
        await storage.put({ object, body: bytes });
        assets.push({
          label: work.title + (sources.length > 1 && source.originalFilename ? ' · ' + source.originalFilename : ''),
          contentType: source.mimeType,
          byteLength: bytes.length,
          checksum,
          objectId: JSON.stringify(object),
          state: 'available',
          publicPreview: false,
          source: { workId: work.workId, assetId: source.assetId, checksum },
        });
      }
    }

    // Stale check
    const current = await store.listCreatorCollections(config.tenantId, offer.ownerId);
    for (const before of collections) {
      const after = current.find((c) => c.collectionId === before.collectionId);
      if (!after || (after.revision ?? 0) !== (before.revision ?? 0)) {
        throw new CommerceError('stale_collection_revision', 409);
      }
    }

    for (const { work, sources } of works) {
      const latest = await store.getWork(config.tenantId, work.workId);
      if (!latest || latest.revision !== work.revision || !(await allowed(latest))) {
        throw new CommerceError('stale_work_revision', 409);
      }
      const latestSources = (await store.listCanonicalAssetsByWork(config.tenantId, work.workId)).filter(
        (a) => a.kind === 'image' && a.status === 'ready' && !a.deletedAt
      );
      if (
        JSON.stringify(latestSources.map((a) => [a.assetId, a.checksumSha256, a.storage])) !==
        JSON.stringify(sources.map((a) => [a.assetId, a.checksumSha256, a.storage]))
      ) {
        throw new CommerceError('stale_work_revision', 409);
      }
    }

    return {
      revision,
      collectionRoots: rootIds,
      galleryIds: collections.map((c) => c.collectionId),
      title: roots[0].title,
      description: roots[0].description ?? '',
      assets,
    };
  };
}
