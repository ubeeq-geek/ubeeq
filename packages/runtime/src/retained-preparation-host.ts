import {randomUUID,createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isObjectKeyWithinPrefix} from '@ubeeq/storage';
import type {ContentMetadataDefaults} from '@ubeeq/core';
import type {PreparationCollection,PreparationSourceFile} from './content-preparation-host.js';
import type {RetainedPreparationModels,RetainedSetupStore,RetainedSetupHost,RetainedSetupSettings,RetainedSetupDestination,RetainedWorkFieldMetadata,RetainedOriginalConfiguration,RetainedOriginalHost,RetainedSourceAccess,RetainedSourceIntakeStore,RetainedSourceIntakeHost,RetainedVolumeStore,RetainedVolumeHost} from './retained-preparation-host-types.js';
export type * from './retained-preparation-host-types.js';

export class SourceFileIntakeError extends Error {
    readonly code = 'invalid_input';
    readonly status = 400;
}
/** One private intake primitive for Files & Media and preparation workflows. */
export async function prepareSourceFileIntake<F extends PreparationSourceFile,A extends RetainedSourceAccess>(store: RetainedSourceIntakeStore<F,A>, config: RetainedOriginalConfiguration, input: {
    creatorId: string;
    originalFilename: unknown;
    mimeType: unknown;
    sizeBytes: unknown;
    checksumSha256?: unknown;
    publishingWorkId?: string;
    fileId?: string;
}, access: A, assertStorage: () => Promise<void>, host:RetainedSourceIntakeHost<F>): Promise<F> {
    const maximum = config.localMediaDirectory ? config.externalContentMaxBytes : 5 * 1024 ** 3;
    const originalFilename = typeof input.originalFilename === 'string' ? input.originalFilename.trim() : '';
    const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim() : 'application/octet-stream', sizeBytes = input.sizeBytes;
    if (!originalFilename || originalFilename.length > 255 || /[\r\n\x00]/.test(originalFilename) || !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 1 || Number(sizeBytes) > maximum || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType))
        throw new SourceFileIntakeError(`Choose a non-empty file of at most ${maximum} bytes with a valid media type.`);
    if(input.checksumSha256!==undefined&&(typeof input.checksumSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.checksumSha256)))throw new SourceFileIntakeError('Choose the exact SHA-256 checksum of this original.');
    if (input.publishingWorkId) {
        const work = await store.getWork(config.tenantId, input.publishingWorkId);
        if (!work || work.creatorId !== input.creatorId || work.deletedAt || work.archivedAt)
            throw new SourceFileIntakeError('Choose an available Work owned by this Creator Identity.');
    }
    const privateStorage = !config.localMediaDirectory && Boolean(config.privateOriginalsBucket);
    if (privateStorage)
        await assertStorage();
    const fileId = input.fileId ?? randomUUID(), now = new Date().toISOString();
    const file = host.file({ fileId, creatorId: input.creatorId, originalFilename, mimeType, sizeBytes: Number(sizeBytes), ...(input.checksumSha256===undefined?{}:{checksumSha256:input.checksumSha256 as string}), storageKey: `${host.originalCreatorPrefix(input.creatorId, privateStorage)}${fileId}/source`, sourceKind: mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : mimeType.startsWith('image/') ? 'image' : mimeType === 'application/pdf' || mimeType.startsWith('text/') ? 'document' : 'other', downloadable: false, premium: false, restricted: false, ...(input.publishingWorkId ? { metadata: { publishingWorkId: input.publishingWorkId } } : {}), revision: 1, uploadState: 'pending', createdAt: now, updatedAt: now });
    if(input.checksumSha256!==undefined&&file.checksumSha256!==input.checksumSha256)throw new SourceFileIntakeError('The original host must retain its precommitted checksum.');
    await store.commitSourceFile({ expected: null, file, access, audit: { auditId: randomUUID(), actorUserId: access.actorUserId, actorRole: access.isAdmin ? 'admin' : 'creator', action: 'source_file.upload.prepared', createdAt: now, detail: { fileId, creatorId: input.creatorId, revision: 1, uploadState: 'pending', downloadable: false } } });
    return file;
}

/** Reads existing immutable original bytes in bounded chunks, without copying or processing video. */
export async function inspectStoredOriginal<F extends PreparationSourceFile>(config:RetainedOriginalConfiguration,file:F,host:RetainedOriginalHost): Promise<string> {
  if (!isObjectKeyWithinPrefix(file.storageKey, `${host.originalCreatorPrefix(file.creatorId, host.isPrivateOriginalKey(file.storageKey))}${file.fileId}/`)
    || file.uploadState !== 'ready' || !Number.isSafeInteger(file.sizeBytes) || !file.sizeBytes
    || file.sizeBytes > config.externalContentMaxBytes) throw new Error('Original is not ready for attachment.');
  if (config.localMediaDirectory) {
    const root = await realpath(config.localMediaDirectory), target = await realpath(resolve(root, file.storageKey));
    if (!target.startsWith(`${root}/`) || !isObjectKeyWithinPrefix(target.slice(root.length + 1), `${host.originalCreatorPrefix(file.creatorId, host.isPrivateOriginalKey(file.storageKey))}${file.fileId}/`)) throw new Error('Invalid original location.');
  }
  const stream = await host.openStream(file.storageKey,file);
  const hash = createHash('sha256'); let size = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > file.sizeBytes) throw new Error('Original size changed.');
      hash.update(chunk);
    }
    if (size !== file.sizeBytes) throw new Error('Original size changed.');
    const checksum = hash.digest('hex');
    if (file.checksumSha256 && checksum !== file.checksumSha256) throw new Error('Original checksum changed.');
    return checksum;
  } finally { (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.(); }
}

/** Subject variables are expanded once when this private Work is assembled. */
export async function contentMetadataWork<D extends string,M extends RetainedPreparationModels<D>>(store:RetainedSetupStore<D,M>,work:M['work'],defaults:ContentMetadataDefaults,host:RetainedSetupHost<D,M>):Promise<M['work']> {
    const creator = await store.getCreatorById(work.creatorId), values = { title: work.title, description: work.description ?? '', creator: creator?.name ?? '' };
    const render = (pattern: string) => pattern.replace(/\{(title|description|creator)\}/g, (_all, key: keyof typeof values) => values[key]);
    const base = host.currentFieldMetadata(work), profile = host.parseFieldMetadata({ shared: { ...base.shared, ...defaults.shared, ...(defaults.titlePattern ? { title: render(defaults.titlePattern) } : {}), ...(defaults.descriptionPattern ? { description: render(defaults.descriptionPattern) } : {}) }, overrides: [...base.overrides.filter(row => !defaults.overrides.some(d => d.destination === row.destination && d.accountId === row.accountId && !row.publicationId)), ...defaults.overrides.filter(row => !row.targetIds?.length)] });
    // Existing affirmative safety declarations are retained by reusable defaults.
    const contentRating = work.contentRating !== 'general' ? work.contentRating : profile.shared.isMature ? 'mature' : 'general';
    const aiDisclosure = work.aiDisclosure !== 'none' ? work.aiDisclosure : profile.shared.isAiGenerated ? 'ai-generated' : 'none';
    return { ...work, title: String(profile.shared.title ?? work.title), description: String(profile.shared.description ?? work.description ?? ''), tags: profile.shared.tags as string[] ?? work.tags, contentRating, aiDisclosure, fieldMetadata: profile };
}

export async function captureSetup<D extends string,M extends RetainedPreparationModels<D>>(store:RetainedSetupStore<D,M>,work:M['work'],host:RetainedSetupHost<D,M>):Promise<RetainedSetupSettings<D>>{
 const profile=await host.loadFieldMetadata(work.tenantId,work);
 const clean=(values:RetainedWorkFieldMetadata['shared'])=>Object.fromEntries(Object.entries(values).filter(([key])=>!['title','description'].includes(key)));
 const publications=await store.listPublicationsByWork(work.tenantId,work.workId),intents=await store.listPublicationIntentsByWork(work.tenantId,work.workId);
 const publicationSettings=profile.overrides.filter(row=>row.publicationId).flatMap(row=>{const publication=publications.find(p=>p.publicationId===row.publicationId);const galleries=intents.find(i=>i.publicationId===row.publicationId)?.galleryExternalCollectionIds??publication?.providerData?.externalCollectionIds;if(!publication||!Array.isArray(galleries)||!galleries.length)return [];return [{destination:row.destination,accountId:row.accountId,galleries:galleries as string[],values:clean(row.values)}];});
 return {publicationSettings,profile:{shared:clean(profile.shared),overrides:profile.overrides.filter(row=>!row.publicationId).map(row=>({...row,values:clean(row.values)})).filter(row=>Object.keys(row.values).length)},destinations:host.withoutCollectionDestinations(await captureDestinations<D,M>(store,work,host),await host.requiredCollectionDestinations(work))};
}
export async function captureDestinations<D extends string,M extends RetainedPreparationModels<D>>(store:RetainedSetupStore<D,M>,work:M['work'],host:RetainedSetupHost<D,M>):Promise<RetainedSetupDestination<D>[]>{
 const intents=await store.listPublicationIntentsByWork(work.tenantId,work.workId);
 const publications=await store.listPublicationsByWork(work.tenantId,work.workId);
 const rows:RetainedSetupDestination<D>[]=intents.filter(row=>row.enabled).map(({destination,integrationAccountId,desiredStatus,scheduledAt,galleryExternalCollectionIds,galleryFeature})=>({destination,integrationAccountId,desiredStatus,scheduledAt,galleryExternalCollectionIds,galleryFeature}));
 for(const p of publications.filter(row=>['live','draft'].includes(row.status)))if(!intents.some(i=>i.publicationId===p.publicationId||!i.publicationId&&i.destination===p.destination&&i.integrationAccountId===p.integrationAccountId))rows.push({destination:p.destination,integrationAccountId:p.integrationAccountId,desiredStatus:p.status==='live'?'live':'draft',...(p.destination==='deviantart'?{galleryExternalCollectionIds:Array.isArray(p.providerData?.externalCollectionIds)?p.providerData.externalCollectionIds as string[]:[]}: {})});
 const grouped=new Map<string,RetainedSetupDestination<D>>();for(const row of rows){const key=JSON.stringify([row.destination,row.integrationAccountId,row.desiredStatus]);const old=grouped.get(key);grouped.set(key,{...row,...(row.destination==='deviantart'?{galleryExternalCollectionIds:[...new Set([...(old?.galleryExternalCollectionIds||[]),...(row.galleryExternalCollectionIds||[])])]}:{})});}return [...grouped.values()];
}
/** Stage choices only: each Work retains its own publication identities and remote posts. */
export async function applySetupDestinations<D extends string,M extends RetainedPreparationModels<D>>(store:RetainedSetupStore<D,M>,work:M['work'],rows:RetainedSetupDestination<D>[],mode:'replace'|'add'='replace',preserveInProgress=false,host:RetainedSetupHost<D,M>){
 rows=host.mergeDestinationChoices([...(mode==='add'?await captureDestinations<D,M>(store,work,host):[]),...rows,...await host.requiredCollectionDestinations(work)]);
 const existing=await store.listPublicationIntentsByWork(work.tenantId,work.workId),now=new Date().toISOString();
 for(const old of existing)if(!rows.some(row=>row.destination===old.destination&&row.integrationAccountId===old.integrationAccountId))await store.upsertPublicationIntent({...old,enabled:false,updatedAt:now});
 for(const row of rows){
  if(row.destination==='deviantart'&&row.integrationAccountId&&row.galleryExternalCollectionIds?.length){
   const account=await store.getExternalAccount(row.integrationAccountId);if(!account)throw Error('A preset DeviantArt connection is unavailable.');
   const prepared=await host.prepareDeviantArtGalleryIntents(work.tenantId,work,account,row.galleryExternalCollectionIds,row.desiredStatus==='draft'?'draft':'live','add',preserveInProgress);
   const accountRows=rows.filter(item=>item.destination===row.destination&&item.integrationAccountId===row.integrationAccountId);
   const selected=new Set(accountRows.flatMap(item=>item.galleryExternalCollectionIds||[]));
   for(const intent of await store.listPublicationIntentsByWork(work.tenantId,work.workId))if(intent.destination===row.destination&&intent.integrationAccountId===row.integrationAccountId&&!prepared.preservedPublicationIds.includes(intent.publicationId??'')){const ids=(intent.galleryExternalCollectionIds||[]).filter(id=>selected.has(id)),choice=accountRows.find(item=>ids.some(id=>item.galleryExternalCollectionIds?.includes(id)));await store.upsertPublicationIntent({...intent,enabled:ids.length>0,galleryExternalCollectionIds:ids,gallerySelectionEditedAt:now,desiredStatus:choice?.desiredStatus||intent.desiredStatus,scheduledAt:choice?.scheduledAt,galleryFeature:choice?.galleryFeature??intent.galleryFeature,updatedAt:now});}
  }else{
   const matches=existing.filter(i=>i.destination===row.destination&&i.integrationAccountId===row.integrationAccountId);
   const targets=matches.length?matches:[host.intent({publicationIntentId:randomUUID(),tenantId:work.tenantId,creatorId:work.creatorId,workId:work.workId,destination:row.destination,integrationAccountId:row.integrationAccountId,enabled:true,desiredStatus:row.desiredStatus,createdAt:now,updatedAt:now})];
   for(const target of targets)await store.upsertPublicationIntent({...target,enabled:true,desiredStatus:row.desiredStatus,scheduledAt:row.scheduledAt,updatedAt:now});
  }
 }
 // Explicitly retain deselected live publications as local intent tombstones.
 // They remain on the platform, but must not be inferred as selected again.
 const current=await store.listPublicationIntentsByWork(work.tenantId,work.workId);
 for(const p of (await store.listPublicationsByWork(work.tenantId,work.workId)).filter(p=>p.status!=='removed'))if(!current.some(i=>i.publicationId===p.publicationId||!i.publicationId&&i.destination===p.destination&&i.integrationAccountId===p.integrationAccountId))await store.upsertPublicationIntent(host.intent({publicationIntentId:`setup:${p.publicationId}`,publicationId:p.publicationId,tenantId:work.tenantId,creatorId:work.creatorId,workId:work.workId,destination:p.destination,integrationAccountId:p.integrationAccountId,enabled:false,desiredStatus:'live',createdAt:now,updatedAt:now}));
}
export const standardSetup=<D extends string>(mature:boolean,ai=false):RetainedSetupSettings<D>=>({profile:{shared:{isMature:mature,isAiGenerated:ai,noAi:true,...(mature?{matureLevel:'moderate',matureClassification:[]}: {})},overrides:[]},destinations:[]});

export async function setupProfileForWork<D extends string,M extends RetainedPreparationModels<D>>(store:RetainedSetupStore<D,M>,work:M['work'],settings:RetainedSetupSettings<D>,host:RetainedSetupHost<D,M>){
 const profile=structuredClone(settings.profile),publications=await store.listPublicationsByWork(work.tenantId,work.workId),intents=await store.listPublicationIntentsByWork(work.tenantId,work.workId);
 for(const p of publications.filter(p=>p.status!=='removed')){
  const ids=intents.find(i=>i.publicationId===p.publicationId)?.galleryExternalCollectionIds??p.providerData?.externalCollectionIds;
  if(!Array.isArray(ids))continue;
  const candidates=(settings.publicationSettings||[]).filter(row=>row.destination===p.destination&&row.accountId===p.integrationAccountId&&row.galleries.length===ids.length&&row.galleries.every(id=>ids.includes(id)));
  if(candidates.length===1)profile.overrides.push({destination:p.destination,accountId:p.integrationAccountId,publicationId:p.publicationId,values:structuredClone(candidates[0].values)});
 }
 return profile;
}

export function sameSetupDestinations<D extends string>(a:RetainedSetupDestination<D>[],b:RetainedSetupDestination<D>[]){
 const normalized=(rows:RetainedSetupDestination<D>[])=>rows.map(row=>JSON.stringify([row.destination,row.integrationAccountId||null,row.desiredStatus,row.scheduledAt||null,[...row.galleryExternalCollectionIds||[]].sort(),row.galleryFeature??null])).sort();
 return JSON.stringify(normalized(a))===JSON.stringify(normalized(b));
}

export async function ensureWorkCollectionDestinations<D extends string,M extends RetainedPreparationModels<D>>(store:RetainedSetupStore<D,M>,work:M['work'],host:RetainedSetupHost<D,M>){const required=await host.requiredCollectionDestinations(work);if(!required.length)return;const existing=await captureDestinations<D,M>(store,work,host);const missing=required.some(r=>!existing.some(e=>e.destination===r.destination&&e.integrationAccountId===r.integrationAccountId&&(r.destination!=='deviantart'||r.galleryExternalCollectionIds?.every(id=>e.galleryExternalCollectionIds?.includes(id)))));if(missing)await applySetupDestinations<D,M>(store,work,required,'add',true,host);}

const available=(c:PreparationCollection)=>!c.deletedAt&&!c.archivedAt&&!['deleted','archived'].includes(c.status)&&c.managementState!=='archived';
/** Parent links are owned by the child; organization CAS serializes graph edits. */
export function validateCollectionVolumes<C extends PreparationCollection>(collections:C[],updated:C,host:RetainedVolumeHost){
 const graph=collections.filter(c=>c.collectionId!==updated.collectionId).concat(updated);
 const byId=new Map(graph.map(c=>[c.collectionId,c]));
 for(const parentId of updated.volumeIds??[]){const parent=byId.get(parentId);if(!parent||parent.tenantId!==updated.tenantId||parent.creatorId!==updated.creatorId||parent.type!=='volume'||!available(parent))throw host.conflict('Choose an active Volume owned by this Creator Identity.');}
 if(updated.type!=='volume'&&graph.some(c=>c.volumeIds?.includes(updated.collectionId)))throw host.conflict('Remove this Volume’s included collections before changing its type.');
 const visiting=new Set<string>(),done=new Set<string>();
 const visit=(id:string)=>{if(visiting.has(id))throw host.conflict('A Volume cannot contain itself, directly or through another Volume.');if(done.has(id))return;visiting.add(id);for(const parent of byId.get(id)?.volumeIds??[])visit(parent);visiting.delete(id);done.add(id);};
 for(const c of graph)visit(c.collectionId);
}
/** Deterministic depth-first contents: independent Works first, then included collections. */
export async function resolveCollectionVolume<C extends PreparationCollection>(root:C,collections:C[],works:(id:string)=>Promise<string[]>,host:RetainedVolumeHost){
 const records:C[]=[],workIds:string[]=[],seen=new Set<string>(),visiting=new Set<string>();
 const visit=async(c:C)=>{if(visiting.has(c.collectionId))throw host.conflict('Circular Volume contents must be repaired before purchasing.');if(seen.has(c.collectionId))return;if(c.tenantId!==root.tenantId||c.creatorId!==root.creatorId||!available(c))throw host.conflict('Restore or remove unavailable collections from this Volume before publishing an offer.');visiting.add(c.collectionId);records.push(c);workIds.push(...await works(c.collectionId));if(c.type==='volume')for(const child of collections.filter(child=>child.volumeIds?.includes(c.collectionId)).sort((a,b)=>a.collectionId.localeCompare(b.collectionId)))await visit(child);visiting.delete(c.collectionId);seen.add(c.collectionId);};
 await visit(root);return {collections:records,workIds:[...new Set(workIds)]};
}
/** Resolve placement views without copying child memberships into the parent. */
export async function resolvedCollectionMembers<C extends PreparationCollection>(store:RetainedVolumeStore<C>,tenantId:string,collection:C,host:RetainedVolumeHost){
 const direct=await store.listCollectionWorks(tenantId,collection.collectionId);
 if(collection.type!=='volume')return direct;
 const expanded=await resolveCollectionVolume(collection,await store.listCreatorCollections(tenantId,collection.creatorId),async id=>(await store.listCollectionWorks(tenantId,id)).sort((a,b)=>a.position-b.position).map(m=>m.workId),host);
 return expanded.workIds.map((workId,position)=>direct.find(m=>m.workId===workId)??{collectionId:collection.collectionId,workId,position,addedAt:collection.updatedAt});
}
