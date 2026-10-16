import { contentAssetReferences } from '@ubeeq/core';
import type { CreatorContentRecords } from './creator-content.js';
import { CreatorContentCommitError } from './creator-content.js';

/** Additive graph commit. Implementations must hide staged rows until the completed receipt commits. */
export interface CreatorContentRestore<M extends CreatorContentRecords> {
  restoreId: string; fingerprint: string; tenantId: string; creatorId: string;
  works: M['work'][]; assets: M['asset'][]; attachments: M['attachment'][];
  publications: M['publication'][]; intents: M['intent'][];
  collections: M['collection'][]; collectionWorks: M['collectionWork'][]; discovery: M['discovery'][];
}
export interface CreatorContentRestoreReceipt {
  restoreId: string; fingerprint: string; tenantId: string; creatorId: string; completedAt: string;
}
export interface CreatorContentRestoreStore<M extends CreatorContentRecords> {
  getContentRestore(tenantId: string, restoreId: string): Promise<CreatorContentRestoreReceipt | null>;
  commitContentRestore(input: CreatorContentRestore<M>): Promise<CreatorContentRestoreReceipt>;
}
export function validateCreatorContentRestore<M extends CreatorContentRecords>(input: CreatorContentRestore<M>): void {
  const fail = () => { throw new CreatorContentCommitError('Invalid restore graph, ownership or relationships.'); };
  if (!input.restoreId || !input.tenantId || !input.creatorId || !/^[a-f0-9]{64}$/.test(input.fingerprint)) fail();
  const ids = (values: any[], key: string) => {
    if (!Array.isArray(values)) fail();
    const found = new Set<string>();
    for (const record of values) {
      if (!record || typeof record[key] !== 'string' || !record[key].trim() || found.has(record[key]) || record.tenantId !== input.tenantId
        || record.creatorId !== undefined && record.creatorId !== input.creatorId) fail();
      found.add(record[key]);
    }
    return found;
  };
  const works = ids(input.works, 'workId'), assets = ids(input.assets, 'assetId'), collections = ids(input.collections, 'collectionId');
  ids(input.publications, 'publicationId'); ids(input.intents, 'publicationIntentId'); ids(input.discovery, 'workId');
  for (const record of [...input.works, ...input.assets, ...input.collections]) if (record.creatorId !== input.creatorId) fail();
  for (const [records, parentKey, parents, childKey, children] of [
    [input.attachments, 'workId', works, 'assetId', assets], [input.collectionWorks, 'collectionId', collections, 'workId', works]
  ] as const) {
    const positions = new Set<string>(), members = new Set<string>();
    for (const record of records as any[]) {
      if (!parents.has(record[parentKey]) || !children.has(record[childKey]) || !Number.isSafeInteger(record.position) || record.position < 0) fail();
      const position = JSON.stringify([record[parentKey], record.position]), member = JSON.stringify([record[parentKey], record[childKey]]);
      if (positions.has(position) || members.has(member)) fail(); positions.add(position); members.add(member);
    }
  }
  for (const work of input.works as any[]) {
    const attached = new Set(input.attachments.filter(row => row.workId === work.workId).map(row => row.assetId));
    if ((work.primaryAssetId !== undefined && !attached.has(work.primaryAssetId)) || contentAssetReferences(work.body, work.media).some(id => !attached.has(id))) fail();
  }
  if ((input.collections as any[]).some(collection => collection.coverAssetId !== undefined && !assets.has(collection.coverAssetId))) fail();
  if ([...input.publications, ...input.intents, ...input.discovery].some(record => !works.has(record.workId))) fail();
}
