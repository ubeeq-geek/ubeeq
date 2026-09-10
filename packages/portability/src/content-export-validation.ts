import { stableJson } from './index.js';
type RecordValue = Record<string, any>;
const object = (value: unknown, name: string): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name} record.`);
  return value as RecordValue;
};
const array = (value: unknown, name: string): any[] => {
  if (!Array.isArray(value)) throw new Error(`Missing ${name} array.`);
  return value;
};
const id = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error(`Invalid ${name} identity.`);
  return value;
};

/** Parse bounded JSON and validate shared content-v1 identity/relationships.
 * Storage/provider references remain untrusted data; no fetch or writes occur.
 * Product fields, permissions, byte transfer and restore policy need further gates. */
export const parseCreatorContentExport = (json: string, limits: { maxBytes?: number; maxNodes?: number; maxDepth?: number } = {}) => {
  const maxBytes = limits.maxBytes ?? 10 * 1024 * 1024, maxNodes = limits.maxNodes ?? 100_000, maxDepth = limits.maxDepth ?? 64;
  if (![maxBytes, maxNodes, maxDepth].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid export parsing budget.');
  if (typeof json !== 'string' || Buffer.byteLength(json) > maxBytes) throw new Error('Content export exceeds byte budget.');
  const parsed: unknown = JSON.parse(json);
  const stack: Array<[unknown, number]> = [[parsed, 0]]; let nodes = 0;
  while (stack.length) {
    const [value, depth] = stack.pop()!;
    if (++nodes > maxNodes || depth > maxDepth) throw new Error('Content export exceeds structure budget.');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite export number.');
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length + stack.length + nodes > maxNodes) throw new Error('Content export exceeds structure budget.');
      for (const [key, child] of entries) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe export object key.');
        stack.push([child, depth + 1]);
      }
    }
  }
  const manifest = object(parsed, 'manifest');
  if (manifest.schema !== 'https://ubeeq.site/schemas/creator-export/v1' || manifest.schemaVersion !== 1) throw new Error('Unsupported content export schema.');
  if (typeof manifest.generatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.generatedAt))) throw new Error('Invalid export timestamp.');
  const source = object(manifest.source, 'source'), creator = object(manifest.creator, 'creator');
  const tenantId = id(source.tenantId, 'tenant'), creatorId = id(creator.creatorId ?? creator.id, 'creator');
  id(source.product, 'source product');
  if (['tenantId', 'instanceId'].some(key => creator[key] !== undefined && creator[key] !== tenantId)) throw new Error('Foreign creator tenant.');
  if (creator.creatorId !== undefined && creator.id !== undefined && creator.creatorId !== creator.id) throw new Error('Conflicting creator identities.');
  const owned = (record: RecordValue, name: string) => {
    if (record.creatorId !== creatorId || record.tenantId !== tenantId) throw new Error(`Foreign ${name} ownership.`);
  };
  const works = array(manifest.works, 'works'), collections = array(manifest.collections, 'collections');
  const accounts = array(manifest.integrationAccounts, 'integration accounts');
  const retained = manifest.retainedAssets === undefined ? [] : array(manifest.retainedAssets, 'retained assets');
  const sourceFiles = manifest.sourceFiles === undefined ? [] : array(manifest.sourceFiles, 'source files');
  const sourceFileIds = new Set<string>();
  const workIds = new Set<string>(), assetIds = new Set<string>(), collectionIds = new Set<string>();
  const publicationIds = new Set<string>(), intentIds = new Set<string>(), accountIds = new Set<string>();
  const assetRecords = new Map<string, string>();
  const add = (set: Set<string>, value: unknown, name: string) => {
    const key = id(value, name); if (set.has(key)) throw new Error(`Duplicate ${name} identity.`); set.add(key); return key;
  };
  const relatedIdentity = (record: RecordValue, keys: string[], name: string): string => {
    const values = keys.filter(key => record[key] !== undefined).map(key => id(record[key], name));
    if (!values.length || values.some(value => value !== values[0])) throw new Error(`Missing or conflicting ${name} identity.`);
    return values[0];
  };
  for (const value of sourceFiles) {
    const file = object(value, 'source file');
    if (file.creatorId !== creatorId || (file.tenantId !== undefined && file.tenantId !== tenantId)) throw new Error('Foreign source-file ownership.');
    add(sourceFileIds, file.fileId, 'source file');
    if (['sourceKind', 'mimeType', 'storageKey', 'createdAt', 'updatedAt'].some(key => typeof file[key] !== 'string' || !file[key].trim()) ||
      (file.sizeBytes !== undefined && (!Number.isFinite(file.sizeBytes) || file.sizeBytes < 0))) throw new Error('Invalid source-file metadata.');
  }
  for (const entry of works) {
    const work = object(object(entry, 'work envelope').work, 'work'); owned(work, 'work');
    add(workIds, work.workId, 'work');
  }
  for (const entry of works) {
    const work = entry.work, localIds = new Set<string>();
    for (const value of array(entry.assets, 'work assets')) {
      const asset = object(value, 'asset'); owned(asset, 'asset');
      const assetId = add(localIds, asset.assetId, 'attached asset'); assetIds.add(assetId);
      const { attachment: _attachment, ...fields } = asset;
      const fingerprint = stableJson(fields);
      if (assetRecords.has(assetId) && assetRecords.get(assetId) !== fingerprint) throw new Error('Conflicting shared asset records.');
      assetRecords.set(assetId, fingerprint);
      if (asset.attachment !== undefined) {
        const attachment = object(asset.attachment, 'attachment');
        if (attachment.assetId !== assetId || attachment.workId !== work.workId || !Number.isSafeInteger(attachment.position) || attachment.position < 0) throw new Error('Invalid asset attachment relationship.');
      }
    }
    if (work.primaryAssetId && !localIds.has(work.primaryAssetId)) throw new Error('Dangling primary asset reference.');
    for (const field of ['publications', 'publicationIntents']) {
      if (entry[field] === undefined) continue;
      for (const value of array(entry[field], field)) {
        const record = object(value, field);
        const intent = field === 'publicationIntents';
        add(intent ? intentIds : publicationIds,
          relatedIdentity(record, ['id', intent ? 'publicationIntentId' : 'publicationId'], intent ? 'publication intent' : 'publication'),
          intent ? 'publication intent' : 'publication');
        if (record.workId !== work.workId || (record.creatorId !== undefined && record.creatorId !== creatorId) ||
          (record.tenantId !== undefined && record.tenantId !== tenantId) || (record.instanceId !== undefined && record.instanceId !== tenantId)) throw new Error('Foreign publication relationship.');
      }
    }
  }
  for (const value of retained) {
    const asset = object(value, 'retained asset'); owned(asset, 'asset'); add(assetIds, asset.assetId, 'retained asset');
  }
  for (const entry of collections) {
    const collection = object(object(entry, 'collection envelope').collection, 'collection'); owned(collection, 'collection');
    const collectionId = add(collectionIds, collection.collectionId, 'collection'), members = new Set<string>();
    for (const value of array(entry.works, 'collection works')) {
      const membership = object(value, 'collection membership');
      const workId = add(members, membership.workId, 'collection member');
      if (!workIds.has(workId) || (membership.collectionId !== undefined && membership.collectionId !== collectionId) ||
        !Number.isSafeInteger(membership.position) || membership.position < 0) throw new Error('Dangling or invalid collection relationship.');
    }
    if (collection.coverAssetId && !assetIds.has(collection.coverAssetId)) throw new Error('Dangling collection cover reference.');
  }
  const secretKeys = new Set(['accessToken', 'refreshToken', 'password', 'clientSecret', 'credentialReference', 'credentials']);
  for (const value of accounts) {
    const account = object(value, 'integration account');
    add(accountIds, relatedIdentity(account, ['id', 'integrationAccountId', 'externalAccountId'], 'integration account'), 'integration account');
    if (['creatorId', 'creatorIdentityId'].some(key => account[key] !== undefined && account[key] !== creatorId) ||
      ['tenantId', 'instanceId'].some(key => account[key] !== undefined && account[key] !== tenantId)) throw new Error('Foreign integration account ownership.');
  }
  const accountStack: unknown[] = [...accounts];
  while (accountStack.length) {
    const value = accountStack.pop();
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (secretKeys.has(key)) throw new Error('Integration credentials are not portable.');
      accountStack.push(child);
    }
  }
  return { manifest, creatorId, tenantId, counts: { works: workIds.size, assets: assetIds.size, retainedAssets: retained.length, collections: collectionIds.size,
    ...(manifest.sourceFiles === undefined ? {} : { sourceFiles: sourceFileIds.size }) } };
};
