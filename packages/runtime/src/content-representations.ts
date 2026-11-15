import {createHash} from 'node:crypto';
import sharp,{type OverlayOptions} from 'sharp';
import {validatePreviewRecipe,type ContentPreviewRecipe,type ContentUnitRef,type ContentWorkflowDraft,type ContentPreviewRelationship} from '@ubeeq/core';
import {publicationIdentityHash} from '@ubeeq/persistence';
import type {ContentPreparationStore,PreparationWork,PreparationAsset,PreparationSourceFile} from './content-preparation-host.js';
import {ContentPreparationError} from './content-preparations.js';

export interface ContentRepresentationFile {
 objectKey:string;checksumSha256:string;sizeBytes:number;mimeType:string;filename:string;width?:number;height?:number;
}
export interface PreparedContentRepresentation<F extends ContentRepresentationFile=ContentRepresentationFile> {
 schemaVersion:1;id:string;subject:ContentUnitRef;kind:'full'|'preview';relationshipId?:string;primaryId?:string;
 assets:Array<{id:string;sourceAssetId?:string;sourceFileId?:string;sourceChecksum:string;kind:PreparationAsset['kind'];role:string;caption?:string;altText?:string;recipe:ContentPreviewRecipe;file:F}>;
 body?:PreparationWork['body'];
}
export interface ContentPublicationBinding<F extends ContentRepresentationFile=ContentRepresentationFile> {
 manifest:PreparedContentRepresentation<F>;placements?:Record<string,PreparedContentRepresentation<F>>;
}
export function contentPublicationBinding<F extends ContentRepresentationFile=ContentRepresentationFile>(publication?:{providerData?:Record<string,unknown>}|null):ContentPublicationBinding<F>|undefined {
 const value=publication?.providerData?.contentRepresentation as ContentPublicationBinding<F>|undefined;
 return value?.manifest?.schemaVersion===1?value:undefined;
}
export interface ContentRepresentationStore<W extends PreparationWork,A extends PreparationAsset,S extends PreparationSourceFile & {premium?:boolean}> {
 readonly publicationAtomic?:Pick<NonNullable<ContentPreparationStore<{revision:number}>['publicationAtomic']>,'get'>;
 getWork(tenantId:string,id:string):Promise<W|null>;
 listPublicationsByWork(tenantId:string,id:string):Promise<Array<{destination:string;providerData?:Record<string,unknown>}>>;
 listCanonicalAssetsByWork(tenantId:string,id:string):Promise<Array<A & {attachment:import('./content-preparation-host.js').PreparationAttachment}>>;
 getCanonicalAsset(tenantId:string,id:string):Promise<A|null>;
 getSourceFileById?(id:string):Promise<S|null>;
}
/** Bind to the actual scoped media authority and policy ports. Reads must verify
 * immutable bytes and current custody; writes must retain quota and recovery.
 * No storage, watermark or policy capability is synthesized by this service. */
export interface ContentRepresentationHost<W extends PreparationWork,A extends PreparationAsset,S extends PreparationSourceFile & {premium?:boolean},F extends ContentRepresentationFile,M> {
 isNativeDestination(destination:string):boolean;
 prepareImageRenditions(work:W):Promise<Array<{assetId:string;file:F}>>;
 readPublishingSource(asset:A):Promise<Buffer>;
 originalFile(asset:A):F;
 inspectOriginal(file:S):Promise<string>;
 creatorWatermark(creatorId:string):Promise<M|undefined>;
 watermarkOverlay(watermark:M,width:number,height:number):Promise<OverlayOptions>;
 writePrivate(key:string,bytes:Buffer,mimeType:string):Promise<void>;
 readPrivate(key:string,expectedBytes:number,expectedChecksum:string):Promise<Buffer>;
 file(value:ContentRepresentationFile):F;
 canReadRepresentation(work:W,sourceIds:string[]):Promise<boolean>;
}

/** Every output is immutable and private until an exact Publication binding is accepted. */
export class ContentRepresentations<W extends PreparationWork,A extends PreparationAsset,S extends PreparationSourceFile & {premium?:boolean},F extends ContentRepresentationFile,M,C extends {tenantId:string}> {
    constructor(readonly store: ContentRepresentationStore<W,A,S>, readonly config:C, private readonly host:ContentRepresentationHost<W,A,S,F,M>) {
        for (const key of ['isNativeDestination','prepareImageRenditions','readPublishingSource','originalFile','inspectOriginal','creatorWatermark','watermarkOverlay','writePrivate','readPrivate','file','canReadRepresentation'] as const)
            if(typeof host?.[key]!=='function')throw new ContentPreparationError('unsupported_operation','Content representations require their actual private media, policy and rendering host.',503);
    }
    async full(work: W, protectedOutput = false): Promise<PreparedContentRepresentation<F>> {
        if(!protectedOutput){const publication=(await this.store.listPublicationsByWork(work.tenantId,work.workId)).find(p=>this.host.isNativeDestination(p.destination)),binding=contentPublicationBinding<F>(publication);if(binding?.manifest.kind!=='full'&&Object.values(binding?.placements??{}).some(placement=>placement.kind==='full'))throw new ContentPreparationError('access_unresolved','This Work has protected full placements. Reuse its approved preview, or review a protected Collection/Volume offering; a new free reference cannot expose its original.');}
        const selected = await this.host.prepareImageRenditions(work), assets = [];
        for (const asset of await this.store.listCanonicalAssetsByWork(work.tenantId, work.workId)) {
            if (asset.deletedAt || asset.replacedByAssetId || asset.status !== 'ready')
                throw new ContentPreparationError('content_held', 'A content component is unavailable.');
            if (asset.attachment.role === 'source' || asset.attachment.role === 'preview')
                continue;
            if (asset.kind === 'image' && !['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(asset.mimeType))
                throw new ContentPreparationError('unsupported_operation', 'Use a verified JPEG, PNG, WebP or AVIF for native image delivery. Other originals remain available in Files & Media and supported platform publishing.');
            // Native video/audio hosting must be installed separately; reference/import paths remain available.
            if (!['image', 'document'].includes(asset.kind))
                throw new ContentPreparationError('unsupported_operation', 'This deployment cannot serve this full media component. Use its connected platform publication or a prepared preview.');
            if (!protectedOutput && typeof asset.metadata?.sourceFileId === 'string' && (await this.store.getSourceFileById?.(asset.metadata.sourceFileId))?.premium)
                throw new ContentPreparationError('access_unresolved', 'This component has premium source-file protection. Use its offering or an approved preview.');
            const image = selected.find(row => row.assetId === asset.assetId);
            if (!image)
                await this.host.readPublishingSource(asset);
            assets.push({ id: asset.assetId, sourceAssetId: asset.assetId, sourceFileId: typeof asset.metadata?.sourceFileId === 'string' ? asset.metadata.sourceFileId : undefined, sourceChecksum: asset.checksumSha256!, kind: asset.kind, role: asset.attachment.role, caption: asset.attachment.caption, altText: asset.attachment.altText, recipe: { kind: 'independent' as const, regenerable: false as const }, file: image?.file ?? this.host.originalFile(asset) });
        }
        // Rich body assets must be among the approved components, never implicit references to private originals.
        const serialized = JSON.stringify(work.body ?? []);
        for (const match of serialized.matchAll(/"assetId":"([^"\\]+)"/g))
            if (!assets.some(a => a.id === match[1]))
                throw new ContentPreparationError('content_held', 'The body refers to media outside the approved component set.');
        return this.finish({ schemaVersion: 1, subject: { kind: 'work', id: work.workId, revision: work.revision }, kind: 'full', primaryId: work.primaryAssetId, assets, body: structuredClone(work.body) });
    }
    private finish(value: Omit<PreparedContentRepresentation<F>, 'id'>): PreparedContentRepresentation<F> { return { ...value, id: publicationIdentityHash(value) }; }
    async previews(draft: ContentWorkflowDraft, recipes: Record<string, ContentPreviewRecipe> = {}): Promise<{
        relationships: ContentPreviewRelationship[];
        outputs: PreparedContentRepresentation<F>[];
    }> {
        const outputs: PreparedContentRepresentation<F>[] = [], relationships: ContentPreviewRelationship[] = [];
        const works = draft.units.filter(u => u.kind === 'work');
        if (draft.entry.target?.kind === 'work' && !works.some(u => u.id === draft.entry.target!.id))
            works.push(draft.entry.target);
        for (const target of works) {
            const work = await this.store.getWork(this.config.tenantId, target.id);
            if (!work || work.creatorId !== draft.creatorId || work.revision !== target.revision)
                throw new ContentPreparationError('revision_conflict', 'A preview source changed. Refresh its content.');
            const intakeIds = draft.objects.filter(o => o.result?.id === work.workId || o.existingWork?.id === work.workId).map(o => o.id);
            const uploads = draft.objects.filter(o => o.role === 'preview' && (o.targets.includes(work.workId) || draft.entry.target?.kind === 'collection' && o.targets.includes(draft.entry.target.id) || o.targets.some(id => intakeIds.includes(id)) || !o.targets.length && draft.entry.target?.id === work.workId));
            const previous = draft.previews.find(p => p.target.id === work.workId), relationshipId = previous?.id ?? publicationIdentityHash([draft.id, work.workId, 'preview']), components: ContentPreviewRelationship['components'] = [], assets: PreparedContentRepresentation<F>['assets'] = [];
            let body: PreparationWork['body'];
            if (uploads.length) {
                for (const object of uploads) {
                    if (object.existingWork) {
                        const source = await this.store.getWork(this.config.tenantId, object.existingWork.id);
                        if (!source || source.creatorId !== draft.creatorId || source.revision !== object.existingWork.revision || ['deleted', 'archived'].includes(source.status))
                            throw new ContentPreparationError('content_held', 'The independent promotional Work changed.');
                        const prepared = await this.full(source), recipe = { kind: 'independent' as const, regenerable: false as const };
                        assets.push(...prepared.assets.map(asset => ({ ...asset, id: `${object.id}-${asset.id}`, role: 'preview', recipe })));
                        body = [...(body ?? []), ...(prepared.body ?? [])];
                        components.push({ workId: source.workId, sourceRevision: String(source.revision), recipe });
                        continue;
                    }
                    const file = object.sourceFileId ? await this.store.getSourceFileById?.(object.sourceFileId) : undefined;
                    if (!file || file.creatorId !== draft.creatorId || file.uploadState !== 'ready' || file.restricted || file.premium || await this.host.inspectOriginal(file) !== object.checksum)
                        throw new ContentPreparationError('content_held', 'A prepared preview is unavailable or changed.');
                    if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf'].includes(file.mimeType))
                        throw new ContentPreparationError('unsupported_operation', 'Native playback for this preview is unavailable. Keep it as a draft or publish through its supported connected platform.');
                    const recipe = { kind: 'uploaded_prepared' as const, regenerable: false as const };
                    components.push({ intakeId: object.id, sourceRevision: object.checksum!, recipe });
                    assets.push({ id: object.id, sourceFileId: file.fileId, sourceChecksum: object.checksum!, kind: file.sourceKind === 'image' ? 'image' : 'document', role: 'preview', recipe, file: this.host.file({ objectKey: file.storageKey, checksumSha256: object.checksum!, sizeBytes: file.sizeBytes!, mimeType: file.mimeType, filename: file.originalFilename || 'preview' }) });
                }
            }
            else if (previous && previous.target.revision === work.revision && previous.components.every(c => ['uploaded_prepared', 'independent'].includes(c.recipe.kind)) && !recipes[work.workId]) {
                const saved = await Promise.all((previous.representationIds ?? []).map(id => this.store.publicationAtomic!.get(`content-workflow:${this.config.tenantId}:${draft.creatorId}:representation`, id))) as PreparedContentRepresentation<F>[];
                if (saved.length && saved.every(output => output?.subject.id === work.workId && output.subject.revision === work.revision)) {
                    outputs.push(...saved);
                    relationships.push(structuredClone(previous));
                    continue;
                }
            }
            else if (draft.settings.preview === 'generated') {
                const recipe = recipes[work.workId] ?? { kind: 'image' as const, maxWidth: draft.settings.previewMaxWidth, watermark: draft.settings.previewWatermark };
                validatePreviewRecipe(recipe);
                if (recipe.kind === 'text') {
                    const text = (work.body ?? []).map(b => b.text ?? b.quote ?? '').join('\n');
                    if (recipe.end > text.length)
                        throw new ContentPreparationError('invalid_input', 'The excerpt exceeds the saved text.', 400);
                    body = [{ blockId: `excerpt-${relationshipId}`, type: 'paragraph', text: text.slice(recipe.start, recipe.end) }];
                    components.push({ workId: work.workId, sourceRevision: String(work.revision), recipe });
                }
                else if (recipe.kind === 'image') {
                    for (const source of await this.store.listCanonicalAssetsByWork(work.tenantId, work.workId)) {
                        if (source.attachment.role === 'attachment' || source.attachment.role === 'source')
                            continue;
                        if (source.kind !== 'image')
                            throw new ContentPreparationError('unsupported_operation', 'Choose an exact text excerpt or upload a prepared preview for this component.');
                        const original = await this.host.readPublishingSource(source), metadata = await sharp(original, { limitInputPixels: 100000000, animated: true }).metadata();
                        if ((metadata.pages ?? 1) > 1)
                            throw new ContentPreparationError('unsupported_operation', 'Upload a prepared animated preview; still-image processing cannot preserve its animation.');
                        let pipeline = sharp(original, { limitInputPixels: 100000000 }).rotate().resize({ width: recipe.maxWidth, height: recipe.maxHeight, fit: 'inside', withoutEnlargement: true });
                        if (recipe.blur)
                            pipeline = pipeline.blur(Math.max(.3, recipe.blur));
                        let bytes = await pipeline.png().toBuffer(), info = await sharp(bytes).metadata();
                        const watermark = recipe.watermark ? await this.host.creatorWatermark(work.creatorId) : undefined;
                        if (watermark)
                            bytes = await sharp(bytes).composite([await this.host.watermarkOverlay(watermark, info.width!, info.height!)]).png().toBuffer();
                        const checksumSha256 = createHash('sha256').update(bytes).digest('hex'), key = `works/${work.tenantId}/${work.creatorId}/${source.assetId}/content-previews/${publicationIdentityHash([source.checksumSha256, recipe, watermark, sharp.versions])}/${checksumSha256}.png`;
                        await this.host.writePrivate(key, bytes, 'image/png');
                        const file = this.host.file({ objectKey: key, checksumSha256, sizeBytes: bytes.length, mimeType: 'image/png', filename: 'preview.png', width: info.width, height: info.height });
                        assets.push({ id: source.assetId, sourceAssetId: source.assetId, sourceFileId: typeof source.metadata?.sourceFileId === 'string' ? source.metadata.sourceFileId : undefined, sourceChecksum: source.checksumSha256!, kind: 'image', role: 'preview', altText: source.attachment.altText, caption: source.attachment.caption, recipe, file });
                        components.push({ assetId: source.assetId, workId: work.workId, sourceRevision: source.checksumSha256!, recipe });
                    }
                }
                else
                    throw new ContentPreparationError('unsupported_operation', 'This preview recipe requires another processor. Upload a prepared preview instead.');
            }
            if (!assets.length && !body?.length)
                continue;
            const output = this.finish({ schemaVersion: 1, subject: target, kind: 'preview', relationshipId, assets, body });
            outputs.push(output);
            relationships.push({ id: relationshipId, target, revision: 1, components, representationIds: [output.id] });
        }
        return { relationships, outputs };
    }
    async read(manifest: PreparedContentRepresentation<F>, id: string): Promise<{
        bytes: Buffer;
        file: F;
    }> {
        const row = manifest.assets.find(a => a.id === id);
        if (!row)
            throw Error('Unapproved component.');
        const subject = await this.store.getWork(this.config.tenantId, manifest.subject.id);
        if (!subject)
            throw Error('Source unavailable.');
        if (!await this.host.canReadRepresentation(subject, [row.sourceAssetId, row.sourceFileId].filter((id): id is string => !!id)))
            throw Error('Source unavailable.');
        if (row.sourceAssetId) {
            const source = await this.store.getCanonicalAsset(this.config.tenantId, row.sourceAssetId);
            if (!source || source.creatorId !== ((await this.store.getWork(this.config.tenantId, manifest.subject.id))?.creatorId) || source.deletedAt || source.status !== 'ready' || source.checksumSha256 !== row.sourceChecksum)
                throw Error('Source unavailable.');
        }
        if (row.sourceFileId) {
            const source = await this.store.getSourceFileById?.(row.sourceFileId);
            if (!source || source.creatorId !== subject.creatorId || source.uploadState !== 'ready' || source.restricted || source.checksumSha256 && source.checksumSha256 !== row.sourceChecksum)
                throw Error('Source unavailable.');
        }
        return { bytes: await this.host.readPrivate(row.file.objectKey, row.file.sizeBytes, row.file.checksumSha256), file: row.file };
    }
}
