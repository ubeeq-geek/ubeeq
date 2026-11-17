import { randomUUID } from 'node:crypto';
import { ContentWorkflowError, inferContentArrangement, validateContentObjects, validateContentPreparation, contentWorkflowBlockers, captureContentPreset, contentPresetKey, resolveContentPreset, type ContentWorkflowDraft, type ContentEntryContext, type ContentIntakeObject, type ContentPreparationSettings, type ContentArrangement, type ContentUnitPreset, type ContentWorkflowReview, type ContentUnitRef, CreatorWorkService, parseStoredPostBlocks, contentAssetReferences, standaloneImageWorkIds } from '@ubeeq/core';
import { publicationIdentityHash } from '@ubeeq/persistence';
import { portableContentPreparations, validateContentPreparationArchive, type ContentPreparationArchive } from '@ubeeq/portability';
import type { ContentPreparationStore, ContentPreparationHost, ContentPreparationAuthorization, PreparationAtomic, PreparationOrganizationState, PreparationWork as Work, PreparationCollection as CreatorCollection, PreparationAsset as CanonicalAsset, PreparationSourceFile as SourceFile } from './content-preparation-host.js';
export type * from './content-preparation-host.js';
export class ContentPreparationError extends Error {
    constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
const conflict = () => new ContentPreparationError('revision_conflict', 'This preparation changed. Reload its current draft before saving.');
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
const checkpoints = ['content', 'organize', 'access', 'preview', 'publish', 'announce', 'review'];
export interface ContentWorkflowPatch {
    title?: string;
    arrangement?: ContentArrangement;
    arrangementConfirmed?: boolean;
    checkpoint?: ContentWorkflowDraft['checkpoint'];
    settings?: ContentPreparationSettings;
    classifications?: Array<{
        id: string;
        role: ContentIntakeObject['role'];
        targets: string[];
    }>;
    objectOrder?: string[];
    childCollectionIds?: string[];
    pendingOrder?: string[];
    primaryId?: string;
    componentMetadata?: Record<string, {
        caption?: string;
        altText?: string;
    }>;
}
/** Uses the same durable transaction authority as canonical content and publication commands. */
export class ContentWorkflowService<S extends PreparationOrganizationState, C extends { tenantId: string }> {
    private recoveryCursor?: string;
    constructor(readonly store: ContentPreparationStore<S>, readonly config: C, private readonly host: ContentPreparationHost, private readonly now: () => string = () => new Date().toISOString(), private readonly authorization: ContentPreparationAuthorization = host) {
        const required = ['authorizeCreator', 'canManageCollections', 'recoveryAuthorization', 'defaultSettings', 'inspectOriginal', 'captureSetup', 'contentMetadataWork', 'validateCollectionVolumes', 'resolvedCollectionMembers', 'recordImageCompatibility'] as const;
        if (required.some(name => typeof host?.[name] !== 'function') || typeof authorization?.authorizeCreator !== 'function' || typeof authorization?.canManageCollections !== 'function')
            throw new ContentPreparationError('unsupported_operation', 'Content preparation requires its authenticated host capabilities.', 503);
    }
    private atomic(): PreparationAtomic {
        if (!this.store.publicationAtomic?.supportsConditionalTransactions)
            throw new ContentPreparationError('unsupported_operation', 'Durable content preparation is unavailable in this storage adapter.', 503);
        return this.store.publicationAtomic;
    }
    kind(creatorId: string, suffix = 'draft') { return `content-workflow:${this.config.tenantId}:${creatorId}:${suffix}`; }
    private async access(creatorId: string) {
        if (!validId(creatorId) || !await this.authorization.authorizeCreator(creatorId))
            throw new ContentPreparationError('access_denied', 'Content preparation access denied.', 403);
        const creator = await this.store.getCreatorById(creatorId);
        if (!creator || creator.status !== 'active' || creator.deletion)
            throw new ContentPreparationError('access_denied', 'This Creator Identity is unavailable.', 403);
    }
    private async scoped<T>(creatorId: string, operation: (atomic: PreparationAtomic) => Promise<T>): Promise<T> {
        const atomic = this.atomic();
        return atomic.run(async () => { await this.access(creatorId); return operation(atomic); });
    }
    async get(creatorId: string, id: string): Promise<ContentWorkflowDraft> {
        if (!validId(id))
            throw new ContentPreparationError('not_found', 'Preparation not found.', 404);
        return this.scoped(creatorId, async (atomic) => {
            const draft = await atomic.get(this.kind(creatorId), id) as ContentWorkflowDraft | undefined;
            if (!draft || draft.creatorId !== creatorId || draft.tenantId !== this.config.tenantId)
                throw new ContentPreparationError('not_found', 'Preparation not found.', 404);
            return structuredClone(draft);
        });
    }
    async list(creatorId: string) {
        return this.scoped(creatorId, async (atomic) => (await atomic.list(this.kind(creatorId)) as ContentWorkflowDraft[])
            .filter(d => d.tenantId === this.config.tenantId && d.creatorId === creatorId && d.state !== 'cancelled')
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id, title, revision, checkpoint, state, updatedAt, entry, units }) => ({ id, title, revision, checkpoint, state, updatedAt, entry, units })));
    }
    async standaloneImages(creatorId: string) {
        return this.scoped(creatorId, async () => {
            const collections = await this.store.listCreatorCollections(this.config.tenantId, creatorId), members = (await Promise.all(collections.filter(c => !['deleted', 'archived'].includes(c.status)).map(c => this.store.listCollectionWorks(this.config.tenantId, c.collectionId)))).flat();
            return { workIds: standaloneImageWorkIds(await this.store.listWorksByCreator(this.config.tenantId, creatorId), members) };
        });
    }
    async exportArchive(creatorId: string) { return this.scoped(creatorId, async (atomic) => portableContentPreparations(await atomic.list(this.kind(creatorId)), await atomic.list(this.kind(creatorId, 'preset-version')))); }
    async restoreArchive(creatorId: string, actorId: string, restoreId: string, archive: ContentPreparationArchive) {
        if (!validId(restoreId))
            throw new ContentPreparationError('invalid_input', 'Choose a stable preparation restore identity.', 400);
        if (!archive || !Array.isArray(archive.drafts) || !Array.isArray(archive.presets))
            throw new ContentPreparationError('invalid_input', 'Choose a valid preparation archive.', 400);
        const source = archive.drafts[0], sourceCreator = source?.creatorId ?? archive.presets[0]?.creatorId;
        const safe = validateContentPreparationArchive(archive, { creatorId: sourceCreator ?? creatorId, tenantId: source?.tenantId ?? this.config.tenantId });
        const results = [];
        for (const incoming of safe.drafts)
            results.push(await this.command(creatorId, publicationIdentityHash([restoreId, incoming.id]), { action: 'restore-preparation', incoming }, async (atomic) => {
                const draft = structuredClone(incoming), at = this.now();
                draft.id = publicationIdentityHash([restoreId, creatorId, incoming.id]).slice(0, 40);
                draft.tenantId = this.config.tenantId;
                draft.creatorId = creatorId;
                draft.actorId = actorId;
                draft.createdAt = at;
                draft.updatedAt = at;
                draft.revision = 1;
                delete draft.review;
                draft.state = 'draft';
                draft.operationIds = [];
                for (const ref of [...draft.units, ...(draft.entry.target ? [draft.entry.target] : []), ...(draft.changes ? [draft.changes.target] : []), ...draft.previews.map(p => p.target), ...draft.objects.flatMap(o => [...(o.existingCollection ? [o.existingCollection] : []), ...(o.existingWork ? [o.existingWork] : []), ...(o.result ? [o.result] : [])])]) {
                    const row = ref.kind === 'work' ? await this.store.getWork(this.config.tenantId, ref.id) : await this.store.getCreatorCollection(this.config.tenantId, ref.id);
                    if (!row || row.creatorId !== creatorId)
                        throw new ContentPreparationError('content_pending', 'Restore this preparation’s canonical content before its workflow.');
                    ref.revision = row.revision ?? 0;
                }
                for (const object of draft.objects)
                    if (object.sourceFileId) {
                        const file = await this.store.getSourceFileById?.(object.sourceFileId);
                        if (!file || file.creatorId !== creatorId || file.uploadState !== 'ready' || file.checksumSha256 !== object.checksum) {
                            delete object.sourceFileId;
                            object.state = 'failed';
                            object.error = 'Upload and rebind the original in this deployment before publication.';
                        }
                    }
                if (draft.changes)
                    draft.changes.state = 'draft';
                await atomic.put(this.kind(creatorId), draft.id, draft);
                return draft.id;
            }));
        for (const incoming of [...safe.presets].sort((a, b) => a.revision - b.revision))
            await this.command(creatorId, publicationIdentityHash([restoreId, incoming.id, incoming.revision]), { action: 'restore-preset', incoming }, async (atomic) => { const preset = { ...incoming, id: publicationIdentityHash([restoreId, creatorId, incoming.id]).slice(0, 40), creatorId, isDefault: false }; await this.putPreset(atomic, preset); return preset.id; });
        return { workflowIds: results, destinationBindingsRequireReview: true, publicationsActivated: false };
    }
    async contents(creatorId: string, id: string) {
        return this.scoped(creatorId, async () => {
            const draft = await this.get(creatorId, id), target = draft.entry.target;
            if (!target)
                return { items: [] };
            if (target.kind === 'collection') {
                if (!await this.authorization.canManageCollections(creatorId))
                    throw new ContentPreparationError('access_denied', 'Collection access denied.', 403);
                const collection = await this.store.getCreatorCollection(this.config.tenantId, target.id);
                if (!collection || collection.creatorId !== creatorId)
                    throw new ContentPreparationError('not_found', 'Content unavailable.', 404);
                const ids = [...new Set([...(await this.store.listCollectionWorks(this.config.tenantId, target.id)).map(m => m.workId), ...(draft.changes?.additions ?? [])])];
                const works = await Promise.all(ids.map(workId => this.store.getWork(this.config.tenantId, workId)));
                return { items: works.filter((work): work is Work => !!work && work.creatorId === creatorId).map(work => ({ id: work.workId, title: work.title })), children:(await this.store.listCreatorCollections(this.config.tenantId,creatorId)).filter(child=>child.volumeIds?.includes(collection.collectionId)).map(child=>({id:child.collectionId,title:child.title,type:child.type,revision:child.revision??0})), revision: collection.revision ?? 0 };
            }
            const work = await this.store.getWork(this.config.tenantId, target.id);
            if (!work || work.creatorId !== creatorId)
                throw new ContentPreparationError('not_found', 'Content unavailable.', 404);
            return { workKind: work.kind, textLength: (work.body ?? []).map(b => b.text ?? b.quote ?? '').join('\n').length, items: (await this.store.listCanonicalAssetsByWork(this.config.tenantId, target.id)).map(asset => ({ id: asset.assetId, title: asset.originalFilename || asset.attachment.altText || 'Content component', caption: asset.attachment.caption, altText: asset.attachment.altText })), revision: work.revision };
        });
    }
    async collectionChoices(creatorId: string) {
        await this.access(creatorId);
        if (!await this.authorization.canManageCollections(creatorId))
            return { items: [] };
        return { items: await Promise.all((await this.store.listCreatorCollections(this.config.tenantId, creatorId)).filter(c => !c.deletedAt && !c.archivedAt && !['archived', 'deleted'].includes(c.status) && c.managementState !== 'archived').map(async (c) => ({ id: c.collectionId, collectionId: c.collectionId, title: c.title, type: c.type, revision: c.revision ?? 0, volumeIds: c.volumeIds, workIds: (await this.store.listCollectionWorks(this.config.tenantId, c.collectionId)).map(m => m.workId) }))) };
    }
    async target(creatorId: string, ref: ContentUnitRef) {
        if (!ref || !['work', 'collection'].includes(ref.kind) || !validId(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 0)
            throw new ContentPreparationError('invalid_input', 'Choose a valid content target.', 400);
        if (ref.kind === 'collection' && !await this.authorization.canManageCollections(creatorId))
            throw new ContentPreparationError('access_denied', 'Collection management requires a Manager or administrator.', 403);
        const row = ref.kind === 'work' ? await this.store.getWork(this.config.tenantId, ref.id) : await this.store.getCreatorCollection(this.config.tenantId, ref.id);
        if (!row || row.creatorId !== creatorId || row.tenantId !== this.config.tenantId || ['archived', 'deleted'].includes(row.status) || row.deletedAt || row.archivedAt || 'managementState' in row && row.managementState === 'archived')
            throw new ContentPreparationError('not_found', 'Choose available content owned by this Creator Identity.', 404);
        if ((row.revision ?? 0) !== ref.revision)
            throw new ContentPreparationError('revision_conflict', 'The content changed. Refresh its preparation.');
        return row;
    }
    private async command<T>(creatorId: string, operationId: string, input: unknown, execute: (atomic: PreparationAtomic) => Promise<T>): Promise<T> {
        if (!validId(operationId))
            throw new ContentPreparationError('invalid_input', 'Use a stable operation identity.', 400);
        const digest = publicationIdentityHash(input);
        return this.scoped(creatorId, async (atomic) => {
            const previous = await atomic.get(this.kind(creatorId, 'receipt'), operationId);
            if (previous) {
                if (previous.digest !== digest)
                    throw new ContentPreparationError('revision_conflict', 'This operation identity was used with different content.');
                return structuredClone(previous.result) as T;
            }
            const result = await execute(atomic);
            await atomic.put(this.kind(creatorId, 'receipt'), operationId, { digest, result, createdAt: this.now() });
            return structuredClone(result);
        });
    }
    async begin(creatorId: string, actorId: string, operationId: string, entry: ContentEntryContext) {
        if (!entry || !['new', 'work', 'collection', 'add', 'preview', 'announce'].includes(entry.intent) ||
            entry.returnPath !== undefined && (typeof entry.returnPath !== 'string' || !entry.returnPath.startsWith('/studio/') || entry.returnPath.includes('\\') || entry.returnPath.length > 2000))
            throw new ContentPreparationError('invalid_input', 'Choose a valid content entry context.', 400);
        if (['add', 'preview', 'announce'].includes(entry.intent) && !entry.target)
            throw new ContentPreparationError('invalid_input', 'Choose the content to prepare.', 400);
        const previousId = entry.target ? (await this.scoped(creatorId, async (atomic) => (await atomic.list(this.kind(creatorId)) as ContentWorkflowDraft[]).filter(d => d.units.some(u => u.kind === entry.target!.kind && u.id === entry.target!.id) && d.state === 'completed').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id)) : undefined;
        return this.command(creatorId, operationId, { action: 'begin', actorId, entry }, async (atomic) => {
            if (entry.intent === 'collection' && !await this.authorization.canManageCollections(creatorId))
                throw new ContentPreparationError('access_denied', 'Collection creation requires a Manager or administrator.', 403);
            const target = entry.target ? await this.target(creatorId, entry.target) : undefined;
            const at = this.now(), id = randomUUID();
            const draft: ContentWorkflowDraft = { id, schemaVersion: 1, tenantId: this.config.tenantId, creatorId, actorId, revision: 1, createdAt: at, updatedAt: at,
                entry: structuredClone(entry), checkpoint: entry.intent === 'announce' ? 'announce' : 'content', state: 'draft', title: target?.title ?? '',
                arrangement: entry.target?.kind ?? (entry.intent === 'work' ? 'work' : entry.intent === 'collection' ? 'collection' : undefined),
                arrangementConfirmed: Boolean(entry.target || entry.intent === 'work' || entry.intent === 'collection'), collectionType: 'collection', objects: [], units: [],
                settings: this.host.defaultSettings(), previews: [], operationIds: [operationId] };
            if (entry.target) {
                const previous = previousId ? await this.get(creatorId, previousId) : undefined;
                if (previous) {
                    draft.settings = structuredClone(previous.settings);
                    delete draft.settings.releaseTime;
                    draft.preset = previous.preset ? { ...previous.preset } : undefined;
                    draft.previews = structuredClone(previous.previews);
                }
                const creatorPreference = await this.store.getAnnouncementOrchestration<any>({ tenantId: this.config.tenantId, creatorId }, 'preferences', 'creator'), unitPreference = entry.target.kind === 'collection' ? await this.store.getAnnouncementOrchestration<any>({ tenantId: this.config.tenantId, creatorId }, 'preferences', `collection:${entry.target.id}`) : null;
                if (unitPreference?.value.patch?.initial?.behaviour === 'off' || !unitPreference?.value.patch?.initial?.behaviour && creatorPreference?.value.settings?.initial?.behaviour === 'off')
                    draft.settings.announce.mode = 'off';
            }
            if (entry.target?.kind === 'work')
                draft.settings.discovery = (await this.store.getWorkDiscoveryParticipation(this.config.tenantId, entry.target.id))?.state === 'opted_in';
            if (entry.intent === 'preview')
                draft.settings.preview = 'uploaded';
            if (entry.target) {
                draft.units = [entry.target];
                if (entry.target.kind === 'collection')
                    for (const member of await this.host.resolvedCollectionMembers(this.config.tenantId, target as CreatorCollection)) {
                        const work = await this.store.getWork(this.config.tenantId, member.workId);
                        if (work?.creatorId === creatorId)
                            draft.units.push({ kind: 'work', id: work.workId, revision: work.revision });
                    }
            }
            if (entry.target)
                draft.changes = { id: `changes-${id}`, target: entry.target, orderedIds: entry.target.kind === 'collection'
                        ? (await this.store.listCollectionWorks(this.config.tenantId, entry.target.id)).map(w => w.workId)
                        : (await this.store.listCanonicalAssetsByWork(this.config.tenantId, entry.target.id)).map(a => a.assetId), additions: [], replacements: [], state: 'applied' };
            if (entry.target?.kind === 'collection') {
                draft.collectionType = (target as CreatorCollection).type;
                draft.settings.structure = { collectionType: draft.collectionType, order: 'intake', cover: 'first_eligible_image' };
                draft.hierarchy = { children: (await this.store.listCreatorCollections(this.config.tenantId, creatorId)).filter(c => c.volumeIds?.includes(entry.target!.id)).map(c => ({ kind: 'collection' as const, id: c.collectionId, revision: c.revision ?? 0 })), state: 'applied' };
            }
            if (entry.target?.kind === 'work' && draft.changes) {
                draft.changes.primaryId = (target as Work).primaryAssetId;
                draft.changes.componentMetadata = Object.fromEntries((await this.store.listCanonicalAssetsByWork(this.config.tenantId, entry.target.id)).map(asset => [asset.assetId, { caption: asset.attachment.caption ?? '', altText: asset.attachment.altText ?? '' }]));
            }
            await atomic.put(this.kind(creatorId), id, draft);
            return draft;
        });
    }
    private async editable(creatorId: string, id: string, expectedRevision: number) {
        const draft = await this.get(creatorId, id);
        if (!Number.isSafeInteger(expectedRevision) || draft.revision !== expectedRevision || draft.state !== 'draft')
            throw conflict();
        return draft;
    }
    private async save(atomic: PreparationAtomic, draft: ContentWorkflowDraft, operationId: string) {
        draft.revision++;
        draft.updatedAt = this.now();
        delete draft.review;
        draft.operationIds = [...draft.operationIds.slice(-99), operationId];
        validateContentObjects(draft.objects);
        validateContentPreparation(draft.settings,{allowIncompleteMedia:true});
        if (Buffer.byteLength(JSON.stringify(draft)) > 180000)
            throw new ContentPreparationError('invalid_input', 'This preparation is too large. Split it into smaller batches.', 400);
        await atomic.put(this.kind(draft.creatorId), draft.id, draft);
        return draft;
    }
    async revise(creatorId: string, id: string, expectedRevision: number, operationId: string, patch: ContentWorkflowPatch) {
        return this.command(creatorId, operationId, { action: 'revise', id, expectedRevision, patch }, async (atomic) => {
            const draft = await this.editable(creatorId, id, expectedRevision);
            if (!patch || Object.keys(patch).some(k => !['title', 'arrangement', 'arrangementConfirmed', 'checkpoint', 'settings', 'classifications', 'objectOrder', 'pendingOrder', 'primaryId', 'componentMetadata', 'childCollectionIds'].includes(k)))
                throw new ContentPreparationError('invalid_input', 'Unsupported preparation change.', 400);
            if (patch.title !== undefined) {
                if (typeof patch.title !== 'string' || patch.title.length > 300)
                    throw new ContentPreparationError('invalid_input', 'Use a title of up to 300 characters.', 400);
                draft.title = patch.title;
            }
            if (patch.arrangement !== undefined) {
                if (draft.units.length && patch.arrangement !== draft.arrangement)
                    throw new ContentPreparationError('revision_conflict', 'Saved Works keep their identities. Start another preparation to use a different arrangement.');
                if (patch.arrangement === 'collection' && !await this.authorization.canManageCollections(creatorId))
                    throw new ContentPreparationError('access_denied', 'Collection creation requires a Manager or administrator.', 403);
                if (!['work', 'collection', 'separate_works'].includes(patch.arrangement) || draft.entry.target && patch.arrangement !== draft.entry.target.kind)
                    throw new ContentPreparationError('invalid_input', 'Keep additions within the selected content unit.', 400);
                draft.arrangement = patch.arrangement;
            }
            if (patch.arrangementConfirmed !== undefined) {
                if (typeof patch.arrangementConfirmed !== 'boolean')
                    throw new ContentPreparationError('invalid_input', 'Confirm the proposed arrangement.', 400);
                draft.arrangementConfirmed = patch.arrangementConfirmed;
            }
            if (patch.checkpoint !== undefined) {
                if (!checkpoints.includes(patch.checkpoint))
                    throw new ContentPreparationError('invalid_input', 'Choose a preparation section.', 400);
                draft.checkpoint = patch.checkpoint;
            }
            if (patch.settings !== undefined) {
                validateContentPreparation(patch.settings,{allowIncompleteMedia:true});
                draft.settings = structuredClone(patch.settings);
            }
            if (patch.childCollectionIds !== undefined) {
                const allowed = [...(draft.hierarchy?.children ?? []), ...draft.objects.filter(o => o.role === 'original').flatMap(o => o.existingCollection ? [o.existingCollection] : [])];
                if (!Array.isArray(patch.childCollectionIds) || patch.childCollectionIds.length > 25 || new Set(patch.childCollectionIds).size !== patch.childCollectionIds.length || patch.childCollectionIds.some(id => !allowed.some(r => r.id === id)))
                    throw new ContentPreparationError('invalid_input', 'Choose up to 25 distinct child groupings.', 400);
                if (publicationIdentityHash(patch.childCollectionIds) !== publicationIdentityHash(draft.hierarchy?.children.map(r => r.id) ?? []))
                    draft.hierarchy = { children: patch.childCollectionIds.map(id => allowed.find(r => r.id === id)!), state: 'draft' };
            }
            if (patch.classifications !== undefined) {
                if (!Array.isArray(patch.classifications) || patch.classifications.length > 250 || new Set(patch.classifications.map(c => c.id)).size !== patch.classifications.length)
                    throw new ContentPreparationError('invalid_input', 'Choose distinct intake objects.', 400);
                for (const classification of patch.classifications) {
                    const object = draft.objects.find(o => o.id === classification.id);
                    if (!object)
                        throw new ContentPreparationError('invalid_input', 'An intake object changed.', 400);
                    if (object.result && !object.existingCollection && classification.role !== object.role)
                        throw new ContentPreparationError('revision_conflict', 'This object already belongs to a saved Work. Edit its supporting relationships without changing its identity.');
                    if (!Array.isArray(classification.targets) || classification.targets.some(target => !draft.objects.some(o => o.id === target && o.role === 'original') && target !== draft.entry.target?.id && !draft.units.some(u => u.id === target)))
                        throw new ContentPreparationError('invalid_input', 'Choose targets from this preparation.', 400);
                    object.role = classification.role;
                    object.targets = classification.targets;
                    object.provenance = object.role === 'preview' && object.sourceFileId ? 'uploaded_prepared' : object.provenance;
                }
            }
            if (patch.objectOrder !== undefined) {
                if (!Array.isArray(patch.objectOrder) || patch.objectOrder.length !== draft.objects.length || new Set(patch.objectOrder).size !== draft.objects.length || patch.objectOrder.some(id => !draft.objects.some(o => o.id === id)))
                    throw new ContentPreparationError('invalid_input', 'Include each intake object exactly once.', 400);
                draft.objects = patch.objectOrder.map(id => draft.objects.find(o => o.id === id)!);
            }
            if (patch.pendingOrder !== undefined || patch.primaryId !== undefined || patch.componentMetadata !== undefined) {
                if (!draft.changes)
                    throw new ContentPreparationError('invalid_input', 'Choose an existing content unit before editing its contents.', 400);
                if (patch.pendingOrder !== undefined && publicationIdentityHash(patch.pendingOrder) !== publicationIdentityHash(draft.changes.orderedIds) || patch.primaryId !== undefined && patch.primaryId !== draft.changes.primaryId || patch.componentMetadata !== undefined && publicationIdentityHash(patch.componentMetadata) !== publicationIdentityHash(draft.changes.componentMetadata))
                    draft.changes.state = 'draft';
                if (patch.pendingOrder !== undefined) {
                    const allowed = new Set([...draft.changes.orderedIds, ...draft.changes.additions]);
                    if (!Array.isArray(patch.pendingOrder) || patch.pendingOrder.length > 250 || new Set(patch.pendingOrder).size !== patch.pendingOrder.length || patch.pendingOrder.some(id => !allowed.has(id)))
                        throw new ContentPreparationError('invalid_input', 'Choose distinct existing or staged content references.', 400);
                    draft.changes.orderedIds = [...patch.pendingOrder];
                    if (draft.changes.primaryId && !patch.pendingOrder.includes(draft.changes.primaryId))
                        draft.changes.primaryId = patch.pendingOrder[0];
                    if (draft.changes.componentMetadata)
                        draft.changes.componentMetadata = Object.fromEntries(Object.entries(draft.changes.componentMetadata).filter(([id]) => patch.pendingOrder!.includes(id)));
                }
                if (patch.primaryId !== undefined) {
                    if (!draft.changes.orderedIds.includes(patch.primaryId))
                        throw new ContentPreparationError('invalid_input', 'Choose a retained component as primary.', 400);
                    draft.changes.primaryId = patch.primaryId;
                }
                if (patch.componentMetadata !== undefined) {
                    if (!patch.componentMetadata || typeof patch.componentMetadata !== 'object' || Array.isArray(patch.componentMetadata) || Object.keys(patch.componentMetadata).length > 250)
                        throw new ContentPreparationError('invalid_input', 'Choose bounded component details.', 400);
                    for (const [id, fields] of Object.entries(patch.componentMetadata))
                        if (!draft.changes.orderedIds.includes(id) || !fields || Object.keys(fields).some(k => !['caption', 'altText'].includes(k)) || Object.values(fields).some(v => typeof v !== 'string' || v.length > 2000))
                            throw new ContentPreparationError('invalid_input', 'Choose valid captions and alternative text.', 400);
                    draft.changes.componentMetadata = structuredClone(patch.componentMetadata);
                }
            }
            const inferred = inferContentArrangement(draft.entry, draft.objects);
            draft.arrangement ??= inferred.arrangement;
            if (!inferred.needsChoice && !draft.entry.target && draft.entry.intent === 'new' && !draft.arrangementConfirmed)
                draft.arrangement = inferred.arrangement;
            return this.save(atomic, draft, operationId);
        });
    }
    async addObject(creatorId: string, id: string, expectedRevision: number, operationId: string, input: {
        sourceFileId?: string;
        work?: ContentUnitRef;
        collection?: ContentUnitRef;
        text?: string;
        body?: unknown;
        title?: string;
        media?: ContentIntakeObject['media'];
    }) {
        // Streaming verification runs outside the transaction. The source record is reread and fenced at acceptance.
        let checksum: string | undefined;
        const source = input.sourceFileId ? await this.store.getSourceFileById?.(input.sourceFileId) : undefined;
        await this.access(creatorId);
        if (input.sourceFileId) {
            if (!source || source.creatorId !== creatorId || source.uploadState !== 'ready' || source.restricted)
                throw new ContentPreparationError('missing_original', 'Choose a completed, available original owned by this Creator.', 400);
            checksum = await this.host.inspectOriginal(source);
        }
        return this.command(creatorId, operationId, { action: 'object', id, expectedRevision, input }, async (atomic) => {
            const draft = await this.editable(creatorId, id, expectedRevision);
            const objectId = publicationIdentityHash([id, operationId]).slice(0, 40);
            let object: ContentIntakeObject;
            if (source) {
                const current = await this.store.getSourceFileById?.(source.fileId);
                if (publicationIdentityHash(current) !== publicationIdentityHash(source))
                    throw conflict();
                object = { id: objectId, operationId, filename: source.originalFilename || 'Uploaded file', media: source.sourceKind === 'document' ? 'literature' : source.sourceKind === 'image' ? 'image' : source.sourceKind === 'video' ? 'video' : source.sourceKind === 'audio' ? 'audio' : 'mixed', role: 'original', state: 'ready', sourceFileId: source.fileId, checksum, targets: [], provenance: 'uploaded_original' };
            }
            else if (input.collection) {
                if (input.collection.kind !== 'collection' || draft.entry.target?.kind === 'work')
                    throw new ContentPreparationError('unsupported_operation', 'Include child groupings in a Volume.', 400);
                const collection = await this.target(creatorId, input.collection) as CreatorCollection;
                if (draft.objects.some(o => o.existingCollection?.id === input.collection!.id) || draft.hierarchy?.children.some(c => c.id === input.collection!.id))
                    throw new ContentPreparationError('invalid_input', 'This grouping is already included.', 400);
                object = { id: objectId, operationId, filename: collection.title, media: 'mixed', role: 'original', state: 'reference', existingCollection: input.collection, targets: [], provenance: 'existing' };
                draft.arrangement = 'collection';
                draft.arrangementConfirmed = draft.entry.intent !== 'work';
                draft.settings.structure = { collectionType: 'volume', order: 'intake', cover: 'first_eligible_image' };
                draft.hierarchy = { children: [...(draft.hierarchy?.children ?? []), input.collection], state: 'draft' };
            }
            else if (input.work) {
                const work = await this.target(creatorId, input.work);
                if (input.work.kind !== 'work')
                    throw new ContentPreparationError('unsupported_operation', 'Choose existing Works here; Collection grouping is configured separately.', 400);
                object = { id: objectId, operationId, filename: work.title, media: 'kind' in work ? work.kind : 'mixed', role: 'original', state: 'reference', existingWork: input.work, targets: [], provenance: 'existing' };
            }
            else {
                if (!['article', 'literature'].includes(input.media || '') || typeof input.text !== 'string' || !input.text.trim())
                    throw new ContentPreparationError('invalid_input', 'Write some content or choose a completed upload.', 400);
                const body = input.body === undefined ? undefined : parseStoredPostBlocks(input.body);
                for (const assetId of contentAssetReferences(body, undefined)) {
                    const asset = await this.store.getCanonicalAsset(this.config.tenantId, assetId);
                    if (!asset || asset.creatorId !== creatorId || asset.deletedAt)
                        throw new ContentPreparationError('content_held', 'Writing references an unavailable asset.', 400);
                }
                object = { id: objectId, operationId, filename: input.title || 'Writing', title: input.title, media: input.media!, role: 'original', state: 'ready', text: input.text, body, targets: [], provenance: 'authored' };
            }
            draft.objects.push(object);
            if (!draft.title)
                draft.title = (input.title || object.filename.replace(/\.[^.]+$/, '')).slice(0, 300);
            const inferred = inferContentArrangement(draft.entry, draft.objects);
            if (!draft.arrangementConfirmed)
                draft.arrangement = inferred.arrangement;
            return this.save(atomic, draft, operationId);
        });
    }
    async stageUpload(creatorId: string, id: string, expectedRevision: number, operationId: string, input: unknown, prepare: (fileId: string) => Promise<SourceFile>) {
        return this.command(creatorId, operationId, { action: 'stage-upload', id, expectedRevision, input }, async (atomic) => {
            const draft = await this.editable(creatorId, id, expectedRevision), fileId = publicationIdentityHash([id, operationId, 'source']).slice(0, 40);
            const file = await prepare(fileId), objectId = publicationIdentityHash([id, operationId]).slice(0, 40);
            draft.objects.push({ id: objectId, operationId, sourceFileId: file.fileId, filename: file.originalFilename || 'Uploaded file', media: file.sourceKind === 'image' ? 'image' : file.sourceKind === 'video' ? 'video' : file.sourceKind === 'audio' ? 'audio' : file.sourceKind === 'document' ? 'literature' : 'mixed', role: draft.entry.intent === 'preview' ? 'preview' : 'original', state: 'pending', targets: draft.entry.intent === 'preview' && draft.entry.target ? [draft.entry.target.id] : [], provenance: draft.entry.intent === 'preview' ? 'uploaded_prepared' : 'uploaded_original' });
            if (!draft.title)
                draft.title = (file.originalFilename || 'Untitled content').replace(/\.[^.]+$/, '').slice(0, 300);
            if (!draft.arrangementConfirmed)
                draft.arrangement = inferContentArrangement(draft.entry, draft.objects).arrangement;
            return { draft: await this.save(atomic, draft, operationId), file, objectId };
        });
    }
    async completeUpload(creatorId: string, id: string, objectId: string, expectedRevision: number, operationId: string) {
        const draft = await this.get(creatorId, id), object = draft.objects.find(o => o.id === objectId), file = object?.sourceFileId ? await this.store.getSourceFileById?.(object.sourceFileId) : undefined;
        if (!file || file.creatorId !== creatorId || file.uploadState !== 'ready' || file.restricted)
            throw new ContentPreparationError('processing_pending', 'Complete the staged upload before continuing.');
        const checksum = await this.host.inspectOriginal(file);
        return this.command(creatorId, operationId, { action: 'complete-upload', id, objectId, expectedRevision }, async (atomic) => {
            const current = await this.editable(creatorId, id, expectedRevision), row = current.objects.find(o => o.id === objectId);
            if (!row || publicationIdentityHash(await this.store.getSourceFileById?.(file.fileId)) !== publicationIdentityHash(file))
                throw conflict();
            row.state = 'ready';
            row.checksum = checksum;
            return this.save(atomic, current, operationId);
        });
    }
    async review(creatorId: string, id: string, expectedRevision: number, action: ContentWorkflowReview['action']) {
        return this.scoped(creatorId, async (atomic) => {
            const draft = await this.editable(creatorId, id, expectedRevision);
            if (!['save', 'publish', 'schedule'].includes(action))
                throw new ContentPreparationError('invalid_input', 'Choose a release action.', 400);
            if (draft.entry.target)
                await this.target(creatorId, draft.entry.target);
            for (const unit of draft.units)
                await this.target(creatorId, unit);
            const blockers = contentWorkflowBlockers(draft);
            const review: ContentWorkflowReview = { id: randomUUID(), workflowRevision: draft.revision, fingerprint: publicationIdentityHash({ ...draft, review: undefined }), expiresAt: new Date(Date.parse(this.now()) + 300000).toISOString(), action, targets: draft.entry.target ? [draft.entry.target] : draft.units, blockers };
            draft.review = review;
            await atomic.put(this.kind(creatorId), id, draft);
            return { draft, review };
        });
    }
    async presets(creatorId: string): Promise<ContentUnitPreset[]> { return this.scoped(creatorId, atomic => atomic.list(this.kind(creatorId, 'preset'))); }
    async presetVersions(creatorId: string, id: string): Promise<ContentUnitPreset[]> {
        return this.scoped(creatorId, async (atomic) => (await atomic.list(this.kind(creatorId, 'preset-version')) as ContentUnitPreset[]).filter(p => p.id === id).sort((a, b) => b.revision - a.revision));
    }
    private async putPreset(atomic: PreparationAtomic, preset: ContentUnitPreset) {
        await atomic.put(this.kind(preset.creatorId, 'preset-version'), `${preset.id}:${preset.revision}`, preset);
        await atomic.put(this.kind(preset.creatorId, 'preset'), preset.id, preset);
    }
    async revisePreset(creatorId: string, id: string, expectedRevision: number, operationId: string, input: {
        name?: string;
        isDefault?: boolean;
        archived?: boolean;
        workflowId?: string;
        workflowRevision?: number;
    }) {
        return this.command(creatorId, operationId, { action: 'revise-preset', id, expectedRevision, input }, async (atomic) => {
            const preset = (await this.presets(creatorId)).find(p => p.id === id);
            if (!preset || preset.revision !== expectedRevision)
                throw conflict();
            if (!input || Object.keys(input).some(k => !['name', 'isDefault', 'archived', 'workflowId', 'workflowRevision'].includes(k)) || input.isDefault !== undefined && typeof input.isDefault !== 'boolean' || input.archived !== undefined && typeof input.archived !== 'boolean')
                throw new ContentPreparationError('invalid_input', 'Choose valid preset changes.', 400);
            let settings = preset.settings;
            if (input.workflowId) {
                const draft = await this.get(creatorId, input.workflowId);
                if (draft.revision !== input.workflowRevision || !draft.units.length || contentWorkflowBlockers(draft).length || draft.arrangement !== preset.applicability.arrangement)
                    throw new ContentPreparationError('preset_incompatible', 'Choose a saved matching content unit before updating the preset.');
                settings = draft.settings;
            }
            const next = { ...captureContentPreset({ ...preset, name: input.name ?? preset.name, settings, revision: preset.revision + 1, isDefault: input.isDefault ?? preset.isDefault }), archived: input.archived ?? preset.archived };
            if (next.archived)
                next.isDefault = false;
            if (next.isDefault)
                for (const other of await this.presets(creatorId))
                    if (other.id !== id && other.isDefault && contentPresetKey(other) === contentPresetKey(next))
                        await this.putPreset(atomic, { ...other, isDefault: false, revision: other.revision + 1 });
            await this.putPreset(atomic, next);
            return next;
        });
    }
    private async presetMedia(draft: ContentWorkflowDraft): Promise<ContentUnitPreset['applicability']['media']> {
        const media = draft.objects.filter(o => o.role === 'original').map(o => o.media);
        if (!media.length)
            for (const ref of draft.units.filter(u => u.kind === 'work')) {
                const work = await this.store.getWork(this.config.tenantId, ref.id);
                if (work) {
                    const assets = work.kind === 'gallery' ? await this.store.listCanonicalAssetsByWork(this.config.tenantId, work.workId) : [];
                    media.push(work.kind === 'gallery' && assets.length && assets.every(a => a.kind === 'image') ? 'image' : work.kind);
                }
            }
        return media.length ? (media.every(m => m === media[0]) ? media[0] : 'mixed') : 'any';
    }
    async capturePreset(creatorId: string, id: string, expectedRevision: number, operationId: string, input: {
        name: string;
        isDefault: boolean;
    }) {
        return this.command(creatorId, operationId, { action: 'preset', id, expectedRevision, input }, async (atomic) => {
            const draft = await this.get(creatorId, id);
            if (draft.revision !== expectedRevision || !draft.units.length || contentWorkflowBlockers(draft).length)
                throw new ContentPreparationError('preset_incompatible', 'Save a ready content unit before capturing its setup.');
            const flavour = await this.presetMedia(draft);
            const settings = structuredClone(draft.settings);
            if (!settings.metadata) {
                const ref = draft.units.find(u => u.kind === 'work');
                const work = ref ? await this.store.getWork(this.config.tenantId, ref.id) : undefined;
                if (work) {
                    const setup = await this.host.captureSetup(work);
                    settings.metadata = { shared: setup.profile.shared, overrides: [...setup.profile.overrides.filter(row => !row.publicationId), ...(setup.publicationSettings ?? []).map(row => ({ destination: row.destination, accountId: row.accountId, targetIds: row.galleries, values: row.values }))] };
                }
            }
            const preset = captureContentPreset({ id: randomUUID(), creatorId, name: input.name, revision: 1, applicability: { arrangement: draft.arrangement!, ...(draft.arrangement === 'collection' ? { collectionType: draft.settings.structure?.collectionType ?? draft.collectionType } : {}), media: flavour || 'any' }, settings, isDefault: input.isDefault === true });
            if (preset.isDefault)
                for (const existing of await this.presets(creatorId))
                    if (existing.isDefault && contentPresetKey(existing) === contentPresetKey(preset))
                        await this.putPreset(atomic, { ...existing, isDefault: false, revision: existing.revision + 1 });
            await this.putPreset(atomic, preset);
            return preset;
        });
    }
    async applyPreset(creatorId: string, id: string, expectedRevision: number, operationId: string, presetId: string, expectedPresetRevision?: number) {
        if (expectedPresetRevision !== undefined && (!Number.isSafeInteger(expectedPresetRevision) || expectedPresetRevision < 1))
            throw new ContentPreparationError('invalid_input', 'Choose a valid reviewed preset version.', 400);
        // Legacy callers keep their exact command fingerprint. New reviews bind
        // the selected version; accepted retries still return the original receipt.
        return this.command(creatorId, operationId, { action: 'apply-preset', id, expectedRevision, presetId, ...(expectedPresetRevision === undefined ? {} : { expectedPresetRevision }) }, async (atomic) => {
            const draft = await this.editable(creatorId, id, expectedRevision), originals = draft.objects.filter(o => o.role === 'original');
            const media = await this.presetMedia(draft);
            const preset = resolveContentPreset(await this.presets(creatorId), creatorId, draft.arrangement ?? inferContentArrangement(draft.entry, draft.objects).arrangement, media || 'any', presetId, draft.objects.some(o => o.role === 'preview' && o.provenance === 'uploaded_prepared') ? 'uploaded_prepared' : undefined, draft.settings.structure?.collectionType ?? draft.collectionType);
            if (!preset)
                throw new ContentPreparationError('preset_incompatible', 'Choose a matching preset.');
            if (expectedPresetRevision !== undefined && preset.revision !== expectedPresetRevision)
                throw new ContentPreparationError('revision_conflict', 'This saved setup changed. Cancel and choose it again to review its current settings.');
            draft.settings = structuredClone(preset.settings);
            draft.preset = { id: preset.id, revision: preset.revision, name: preset.name };
            if (draft.objects.some(o => o.role === 'preview' && o.provenance === 'uploaded_prepared'))
                draft.settings.preview = 'uploaded';
            return this.save(atomic, draft, operationId);
        });
    }
    async refreshReferences(creatorId: string, id: string, expectedRevision: number, operationId: string) {
        return this.command(creatorId, operationId, { action: 'refresh-references', id, expectedRevision }, async (atomic) => {
            const draft = await this.editable(creatorId, id, expectedRevision), refresh = async (ref: ContentUnitRef) => {
                const row = ref.kind === 'work' ? await this.store.getWork(this.config.tenantId, ref.id) : await this.store.getCreatorCollection(this.config.tenantId, ref.id);
                if (!row)
                    throw new ContentPreparationError('not_found', 'A referenced content unit is unavailable.', 404);
                const current = { ...ref, revision: row.revision ?? 0 };
                await this.target(creatorId, current);
                return current;
            };
            draft.units = await Promise.all(draft.units.map(refresh));
            for (const object of draft.objects) {
                if (object.existingCollection)
                    object.existingCollection = await refresh(object.existingCollection);
                if (object.existingWork)
                    object.existingWork = await refresh(object.existingWork);
                if (object.result)
                    object.result = await refresh(object.result);
            }
            if (draft.entry.target)
                draft.entry.target = await refresh(draft.entry.target);
            if (draft.hierarchy) {
                draft.hierarchy.children = await Promise.all(draft.hierarchy.children.map(refresh));
                draft.hierarchy.state = 'draft';
            }
            if (draft.changes) {
                draft.changes.target = await refresh(draft.changes.target);
                const ref = draft.changes.target;
                const current = ref.kind === 'collection' ? (await this.store.listCollectionWorks(this.config.tenantId, ref.id)).map(m => m.workId) : (await this.store.listCanonicalAssetsByWork(this.config.tenantId, ref.id)).map(a => a.assetId);
                draft.changes.orderedIds = [...new Set([...current, ...draft.changes.additions])];
                draft.changes.state = 'draft';
            }
            for (const preview of draft.previews) {
                preview.target = await refresh(preview.target);
                delete preview.representationIds;
            }
            return this.save(atomic, draft, operationId);
        });
    }
    async cancel(creatorId: string, id: string, expectedRevision: number, operationId: string) {
        return this.command(creatorId, operationId, { action: 'cancel', id, expectedRevision }, async (atomic) => {
            const draft = await this.editable(creatorId, id, expectedRevision);
            draft.state = 'cancelled';
            return this.save(atomic, draft, operationId);
        });
    }
    async resume(creatorId: string, id: string) {
        const draft = await this.get(creatorId, id);
        if (draft.state !== 'accepted')
            return draft;
        const operations = await this.atomic().list(this.kind(creatorId, 'operation'));
        const operation = operations.find(o => o.draft?.id === id && o.state === 'accepted');
        return operation ? this.saveDraft(creatorId, id, operation.draft.revision, operation.id) : draft;
    }
    async recover() {
        for (const creator of await this.store.listCreators()) {
            if (creator.status !== 'active' || creator.deletion)
                continue;
            for (const draft of await this.list(creator.creatorId))
                if (draft.state === 'accepted') {
                    try {
                        await this.recoverDraft(creator.creatorId, draft.id);
                    }
                    catch { /* Retain accepted child receipts; a focused retry shows the current blocker. */ }
                }
        }
    }
    private async recoverDraft(creatorId: string, id: string) {
        const record = await this.atomic().get(this.kind(creatorId), id) as ContentWorkflowDraft | undefined;
        if (!record || record.tenantId !== this.config.tenantId || record.creatorId !== creatorId)
            throw new ContentPreparationError('not_found', 'Preparation not found.', 404);
        const actor = this.host.recoveryAuthorization(record.actorId);
        const recovery = new ContentWorkflowService(this.store, this.config, this.host, this.now, {
            authorizeCreator: async id => await actor.authorizeCreator(id) && (record.arrangement !== 'collection' || await actor.canManageCollections(id)),
            canManageCollections: id => actor.canManageCollections(id)
        });
        return recovery.resume(creatorId, id);
    }
    /** Discover from canonical accepted commands; never create a second queue or
     * use the worker's identity as the saved actor's authority. One command is
     * resumed per poll. The cursor affects fairness only and is safe to discard. */
    async recoverNext() {
        const candidates: Array<{key:string;creatorId:string;id:string}> = [];
        for (const creator of await this.store.listCreators()) {
            if (creator.status !== 'active' || creator.deletion || !validId(creator.creatorId)) continue;
            const drafts = await this.atomic().list(this.kind(creator.creatorId)) as ContentWorkflowDraft[];
            const operations = await this.atomic().list(this.kind(creator.creatorId, 'operation'));
            for (const draft of drafts) if (draft.tenantId === this.config.tenantId && draft.creatorId === creator.creatorId && draft.state === 'accepted'
                && operations.some(operation => operation.state === 'accepted' && operation.draft?.id === draft.id))
                candidates.push({key:JSON.stringify([creator.creatorId,draft.id]),creatorId:creator.creatorId,id:draft.id});
        }
        candidates.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
        const ordered=[...candidates.filter(candidate=>!this.recoveryCursor || candidate.key>this.recoveryCursor),...candidates.filter(candidate=>this.recoveryCursor && candidate.key<=this.recoveryCursor)];
        let denied=false;
        for(const next of ordered){
            this.recoveryCursor=next.key;
            const record=await this.atomic().get(this.kind(next.creatorId),next.id) as ContentWorkflowDraft | undefined;
            if(!record || record.tenantId!==this.config.tenantId || record.creatorId!==next.creatorId)throw new ContentPreparationError('not_found','Preparation not found.',404);
            const actor=this.host.recoveryAuthorization(record.actorId);
            // A denied old command must not starve eligible commands after a cold
            // start. Positive observations still authorize nothing: recoverDraft
            // repeats live authority inside the original conditional children.
            if(!await actor.authorizeCreator(next.creatorId) || record.arrangement==='collection' && !await actor.canManageCollections(next.creatorId)){denied=true;continue;}
            const draft=await this.recoverDraft(next.creatorId,next.id);
            return {kind:'content-preparation' as const,creatorId:next.creatorId,id:next.id,state:draft.state};
        }
        if(denied)throw new ContentPreparationError('access_denied','Content preparation access denied.',403);
    }
    /** Assemble private draft units in bounded, resumable transactions. Never publish or queue a send. */
    async saveDraft(creatorId: string, id: string, expectedRevision: number, operationId: string) {
        const accepted = await this.command(creatorId, operationId, { action: 'save-draft', id, expectedRevision }, async (atomic) => {
            const draft = await this.editable(creatorId, id, expectedRevision);
            for (const ref of draft.units)
                await this.target(creatorId, ref);
            if (!draft.preset && publicationIdentityHash(draft.settings) === publicationIdentityHash(this.host.defaultSettings())) {
                const originals = draft.objects.filter(o => o.role === 'original'), media = originals.every(o => o.media === originals[0]?.media) ? originals[0]?.media : 'mixed';
                const preset = resolveContentPreset(await this.presets(creatorId), creatorId, draft.arrangement ?? inferContentArrangement(draft.entry, draft.objects).arrangement, media ?? 'any', undefined, undefined, draft.settings.structure?.collectionType ?? draft.collectionType);
                if (preset) {
                    draft.settings = structuredClone(preset.settings);
                    draft.preset = { id: preset.id, revision: preset.revision, name: preset.name };
                    if (draft.objects.some(o => o.role === 'preview'))
                        draft.settings.preview = 'uploaded';
                }
            }
            if (!draft.entry.target && draft.arrangement === 'collection') {
                const originals = draft.objects.filter(o => o.role === 'original');
                draft.collectionType = draft.settings.structure?.collectionType ?? (originals.length && originals.every(o => o.media === 'image') ? 'gallery' : 'collection');
                draft.settings.structure = { collectionType: draft.collectionType as 'gallery' | 'collection' | 'series' | 'playlist' | 'volume', order: 'intake', cover: draft.settings.structure?.cover ?? 'first_eligible_image' };
            }
            const blockers = contentWorkflowBlockers(draft);
            if (draft.arrangement === 'collection' && !await this.authorization.canManageCollections(creatorId))
                throw new ContentPreparationError('access_denied', 'Collection creation requires a Manager or administrator.', 403);
            if (blockers.length)
                return { state: 'saved_incomplete', draft: await this.save(atomic, draft, operationId) };
            if (!draft.objects.some(o => o.role === 'original') && !draft.entry.target)
                throw new ContentPreparationError('missing_original', 'Select full content, or explicitly use promotional content as a standalone Work.', 400);
            if (draft.arrangement === 'work' && !draft.entry.target && draft.objects.some(o => o.role === 'original' && o.existingWork) && draft.objects.filter(o => o.role === 'original').length > 1)
                throw new ContentPreparationError('unsupported_operation', 'Existing Works retain their identities. Choose a Collection or Separate Works for these items.');
            const operation = { id: operationId, draft: structuredClone(draft), state: 'accepted', createdAt: this.now() };
            await atomic.put(this.kind(creatorId, 'operation'), operationId, operation);
            draft.state = 'accepted';
            await this.save(atomic, draft, operationId);
            return operation;
        });
        if (accepted.state === 'saved_incomplete')
            return accepted.draft;
        const snapshot = accepted.draft as ContentWorkflowDraft;
        // Each logical child commits with its receipt and parent progress; a retry never repeats a completed attachment.
        const originals = snapshot.objects.filter(o => o.role === 'original');
        if (snapshot.arrangement === 'work' && !snapshot.entry.target && originals.some(o => o.existingWork) && originals.length > 1)
            throw new ContentPreparationError('unsupported_operation', 'Existing Works retain their identities. Choose a Collection or Separate Works for these items.');
        const workIds: string[] = [];
        for (const original of originals) {
            if (original.existingCollection) {
                await this.target(creatorId, original.existingCollection);
                await this.command(creatorId, publicationIdentityHash([operationId, original.id]), { action: 'reference-child', operationId, original }, async (atomic) => { const current = await this.get(creatorId, id); current.objects.find(o => o.id === original.id)!.result = original.existingCollection; await atomic.put(this.kind(creatorId), id, current); });
                continue;
            }
            if (snapshot.entry.target?.kind === 'work') {
                if (!original.result)
                    workIds.push(original.id);
                continue;
            }
            const child = publicationIdentityHash([operationId, original.id]);
            const ref = await this.command(creatorId, child, { action: 'assemble', operationId, originalId: original.id }, async (atomic) => {
                if (original.existingWork) {
                    await this.target(creatorId, original.existingWork);
                    const draft = await this.get(creatorId, id);
                    draft.units = [...draft.units.filter(u => u.id !== original.existingWork!.id), original.existingWork];
                    const intake = draft.objects.find(o => o.id === original.id);
                    if (intake)
                        intake.result = original.existingWork;
                    await atomic.put(this.kind(creatorId), id, draft);
                    return original.existingWork;
                }
                const workId = publicationIdentityHash([id, snapshot.arrangement === 'work' ? 'work' : original.id]).slice(0, 40);
                let work = await this.store.getWork(this.config.tenantId, workId);
                if (!work) {
                    const at = this.now(), title = (snapshot.arrangement === 'work' ? snapshot.title : original.title || original.filename.replace(/\.[^.]+$/, '')).slice(0, 300);
                    const slug = (title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 140) || 'work') + '-' + workId.slice(0, 8);
                    work = { workId, tenantId: this.config.tenantId, creatorId, kind: original.media, title, slug, slugHistory: [slug], tags: [], contentRating: 'general', aiDisclosure: 'none', heavyTopics: [], status: 'draft', origin: { type: 'local' }, revision: 1, createdAt: at, updatedAt: at };
                    await new CreatorWorkService<Work>(this.store, scope => this.authorization.authorizeCreator(scope.creatorId), () => at).create(work);
                }
                if (work.creatorId !== creatorId || work.status !== 'draft')
                    throw new ContentPreparationError('revision_conflict', 'An assembled Work changed. Review it before continuing.');
                const progress = await this.get(creatorId, id), expected = progress.units.find(ref => ref.kind === 'work' && ref.id === workId);
                if (expected && expected.revision !== work.revision)
                    throw new ContentPreparationError('revision_conflict', 'A saved Work changed outside this preparation. Review its current contents.');
                if (snapshot.arrangement === 'work' && work.title !== snapshot.title && !work.contentPreparationMetadata) {
                    const updated: Work = { ...work, title: snapshot.title, revision: work.revision + 1, updatedAt: this.now() };
                    await this.store.commitWorkRevision(updated, work.revision);
                    work = updated;
                }
                if (original.sourceFileId) {
                    const file = await this.store.getSourceFileById?.(original.sourceFileId);
                    if (!file || file.creatorId !== creatorId || file.uploadState !== 'ready' || file.restricted || file.checksumSha256 && file.checksumSha256 !== original.checksum)
                        throw new ContentPreparationError('content_held', 'The staged original is unavailable or changed.');
                    const assetId = publicationIdentityHash([workId, file.fileId]).slice(0, 40), assets = await this.store.listCanonicalAssetsByWork(this.config.tenantId, workId);
                    if (!assets.some(a => a.assetId === assetId)) {
                        const at = this.now(), asset: CanonicalAsset = { assetId, tenantId: this.config.tenantId, creatorId, kind: file.sourceKind === 'image' ? 'image' : file.sourceKind === 'video' ? 'video' : file.sourceKind === 'audio' ? 'audio' : 'document', status: 'ready', mimeType: file.mimeType, originalFilename: file.originalFilename, sizeBytes: file.sizeBytes, checksumSha256: original.checksum, storage: { mode: 'hosted', objectKey: file.storageKey }, metadata: { ...file.metadata, sourceFileId: file.fileId, contentWorkflowId: id }, createdAt: at, updatedAt: at };
                        const next = { ...work, kind: snapshot.arrangement === 'work' && originals.length > 1 ? (originals.every(o => o.media === 'image') ? 'gallery' : 'mixed') as Work['kind'] : work.kind, primaryAssetId: work.primaryAssetId || assetId, revision: work.revision + 1, updatedAt: at };
                        await this.store.commitAssetAttachment({ previousRevision: work.revision, work: next, asset, attachment: { workId, assetId, role: work.primaryAssetId ? 'content' : 'primary', position: assets.length } });
                        work = next;
                        await this.host.recordImageCompatibility(work, asset, snapshot.actorId);
                    }
                }
                else if (original.provenance === 'authored' && !work.body?.some(b => b.blockId === original.id)) {
                    const body = [...(work.body ?? []), ...(original.body?.length ? original.body.map((block, index) => ({ ...block, blockId: index === 0 ? original.id : `${original.id}-${index}` })) : [{ blockId: original.id, type: 'paragraph' as const, text: original.text }])];
                    work = { ...work, body, revision: work.revision + 1, updatedAt: this.now() };
                    await this.store.commitWorkRevision(work, work.revision - 1);
                }
                for (const support of snapshot.objects.filter(o => ['cover', 'attachment'].includes(o.role) && (o.targets.includes(original.id) || o.targets.includes(workId) || !o.targets.length && originals.length === 1))) {
                    const file = support.sourceFileId ? await this.store.getSourceFileById?.(support.sourceFileId) : undefined;
                    if (!file || file.creatorId !== creatorId || file.uploadState !== 'ready' || file.restricted || file.checksumSha256 && file.checksumSha256 !== support.checksum)
                        throw new ContentPreparationError('content_held', 'A supporting file is unavailable.');
                    const assetId = publicationIdentityHash([workId, file.fileId]).slice(0, 40), assets = await this.store.listCanonicalAssetsByWork(this.config.tenantId, workId);
                    if (assets.some(a => a.assetId === assetId))
                        continue;
                    const at = this.now(), asset: CanonicalAsset = { assetId, tenantId: this.config.tenantId, creatorId, kind: file.sourceKind === 'image' ? 'image' : file.sourceKind === 'video' ? 'video' : file.sourceKind === 'audio' ? 'audio' : 'document', status: 'ready', mimeType: file.mimeType, originalFilename: file.originalFilename, sizeBytes: file.sizeBytes, checksumSha256: support.checksum, storage: { mode: 'hosted', objectKey: file.storageKey }, metadata: { ...file.metadata, sourceFileId: file.fileId, contentWorkflowId: id }, createdAt: at, updatedAt: at };
                    const next: Work = { ...work!, primaryAssetId: support.role === 'cover' && file.sourceKind === 'image' ? assetId : work!.primaryAssetId, revision: work!.revision + 1, updatedAt: at };
                    await this.store.commitAssetAttachment({ previousRevision: work.revision, work: next, asset, attachment: { workId, assetId, role: support.role === 'cover' ? 'primary' : 'attachment', position: assets.length } });
                    work = next;
                }
                if (snapshot.settings.metadata && work.contentPreparationMetadata?.fingerprint !== publicationIdentityHash(snapshot.settings.metadata)) {
                    const proposed = { ...await this.host.contentMetadataWork(work, snapshot.settings.metadata), contentPreparationMetadata: { workflowId: id, fingerprint: publicationIdentityHash(snapshot.settings.metadata) } };
                    if (publicationIdentityHash(proposed) !== publicationIdentityHash(work)) {
                        const next = { ...proposed, revision: work.revision + 1, updatedAt: this.now() };
                        await this.store.commitWorkRevision(next, work.revision);
                        work = next;
                    }
                }
                const draft = await this.get(creatorId, id);
                const ref: ContentUnitRef = { kind: 'work', id: workId, revision: work.revision };
                const intake = draft.objects.find(o => o.id === original.id);
                if (intake)
                    intake.result = ref;
                for (const supporting of draft.objects.filter(o => ['cover', 'attachment'].includes(o.role) && (o.targets.includes(original.id) || o.targets.includes(workId) || !o.targets.length && originals.length === 1)))
                    supporting.result = ref;
                draft.units = [...draft.units.filter(r => r.id !== workId), ref];
                draft.updatedAt = this.now();
                await atomic.put(this.kind(creatorId), id, draft);
                return ref;
            });
            workIds.push(ref.id);
        }
        if (snapshot.entry.target?.kind === 'work')
            workIds.push(...snapshot.objects.filter(o => ['cover', 'attachment'].includes(o.role) && !o.result).map(o => o.id));
        const completion = publicationIdentityHash([operationId, 'complete']);
        return this.command(creatorId, completion, { action: 'complete-draft', operationId }, async (atomic) => {
            const draft = await this.get(creatorId, id);
            if (snapshot.entry.target) {
                await this.target(creatorId, snapshot.entry.target);
                const fresh = workIds.filter(ref => !snapshot.changes!.additions.includes(ref));
                draft.changes = { ...snapshot.changes!, state: fresh.length ? 'draft' : snapshot.changes!.state, primaryId: snapshot.changes!.primaryId ?? (snapshot.entry.target.kind === 'work' ? snapshot.objects.find(o => o.role === 'cover' && !o.result)?.id : undefined), additions: [...new Set([...snapshot.changes!.additions, ...workIds])], orderedIds: [...new Set([...snapshot.changes!.orderedIds, ...fresh])] };
                draft.units = [snapshot.entry.target, ...draft.units.filter(ref => ref.id !== snapshot.entry.target!.id)];
            }
            else if (snapshot.arrangement === 'collection') {
                const collectionId = publicationIdentityHash([id, 'collection']).slice(0, 40), at = this.now(), slug = (snapshot.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 140) || 'collection') + '-' + collectionId.slice(0, 8);
                const coverWork = snapshot.settings.structure?.cover === 'first_eligible_image' ? (await Promise.all(workIds.map(workId => this.store.getWork(this.config.tenantId, workId)))).find(work => work?.primaryAssetId && ['image', 'gallery'].includes(work.kind)) : undefined;
                const collection: CreatorCollection & {
                    revision: number;
                } = { collectionId, tenantId: this.config.tenantId, creatorId, title: snapshot.title, type: snapshot.collectionType, coverAssetId: coverWork?.primaryAssetId, slug, slugHistory: [slug], status: 'draft', visibility: 'private', category: snapshot.settings.access === 'premium' ? 'premium' : 'free_preview', revision: 1, createdAt: at, updatedAt: at };
                const existing = await this.store.getCreatorCollection(this.config.tenantId, collectionId), expected = draft.units.find(u => u.id === collectionId);
                if (existing && (existing.status !== 'draft' || expected && expected.revision !== (existing.revision ?? 0)))
                    throw new ContentPreparationError('revision_conflict', 'The Collection changed outside this preparation. Review its current contents.');
                const state = await this.store.getCollectionOrganization(this.config.tenantId, creatorId);
                state.revision++;
                const next = existing ? { ...existing, title: snapshot.title, type: snapshot.collectionType, coverAssetId: collection.coverAssetId, category: collection.category, revision: (existing.revision ?? 0) + 1, updatedAt: at } : collection;
                await this.store.commitCollectionOrganization({ tenantId: this.config.tenantId, creatorId, expectedRevision: state.revision - 1, state, collection: next, expectedCollectionRevision: existing?.revision ?? 0, members: [...new Set(workIds)].map((workId, position) => ({ collectionId, workId, position, addedAt: at })) });
                draft.units = [{ kind: 'collection', id: collectionId, revision: (await this.store.getCreatorCollection(this.config.tenantId, collectionId))!.revision ?? 1 }, ...draft.units.filter(u => u.id !== collectionId)];
            }
            if (draft.hierarchy)
                draft.hierarchy.children = draft.hierarchy.children.filter(ref => !draft.objects.some(o => o.existingCollection?.id === ref.id && o.role === 'excluded'));
            if (draft.hierarchy?.state === 'draft' && !draft.changes) {
                const parent = draft.units.find(u => u.kind === 'collection')!;
                draft.changes = { id: `changes-${id}`, target: parent, orderedIds: [...new Set(workIds)], additions: [], replacements: [], state: 'draft' };
            }
            draft.state = 'draft';
            draft.checkpoint = 'review';
            const operation = await atomic.get(this.kind(creatorId, 'operation'), operationId);
            await atomic.put(this.kind(creatorId, 'operation'), operationId, { ...operation, state: 'completed', completedAt: this.now() });
            return this.save(atomic, draft, completion);
        });
    }
    async applyChanges(creatorId: string, id: string, expectedRevision: number, operationId: string, reviewId: string, fingerprint: string) {
        return this.command(creatorId, operationId, { action: 'apply-changes', id, expectedRevision, reviewId, fingerprint }, async (atomic) => {
            const draft = await this.editable(creatorId, id, expectedRevision), review = draft.review, change = draft.changes;
            if (!change || !review || review.id !== reviewId || review.fingerprint !== fingerprint || review.workflowRevision !== draft.revision || Date.parse(review.expiresAt) <= Date.parse(this.now()) || review.blockers.length || publicationIdentityHash({ ...draft, review: undefined }) !== fingerprint)
                throw new ContentPreparationError('review_stale', 'Review the current content changes before applying them.');
            const target = await this.target(creatorId, change.target);
            if (draft.hierarchy?.state === 'draft') {
                if (change.target.kind !== 'collection' || draft.settings.structure?.collectionType !== 'volume')
                    throw new ContentPreparationError('hierarchy_required', 'Only a Volume can include child groupings.');
                const all = await this.store.listCreatorCollections(this.config.tenantId, creatorId);
                for (const ref of draft.hierarchy.children)
                    await this.target(creatorId, ref);
                const parent = { ...target, type: 'volume' as const } as CreatorCollection;
                if (draft.hierarchy.children.some(ref => ref.id === parent.collectionId))
                    throw new ContentPreparationError('hierarchy_cycle', 'A Volume cannot contain itself.');
                let graph = all.filter(c => c.collectionId !== parent.collectionId).concat(parent);
                const changed: CreatorCollection[] = [];
                for (const child of graph.filter(c => c.collectionId !== parent.collectionId)) {
                    const selected = draft.hierarchy.children.some(r => r.id === child.collectionId), included = child.volumeIds?.includes(parent.collectionId) ?? false;
                    if (selected === included)
                        continue;
                    const next = { ...child, volumeIds: [...(child.volumeIds ?? []).filter(id => id !== parent.collectionId), ...(selected ? [parent.collectionId] : [])], revision: (child.revision ?? 0) + 1, updatedAt: this.now() };
                    this.host.validateCollectionVolumes(graph, next);
                    graph = graph.filter(c => c.collectionId !== next.collectionId).concat(next);
                    changed.push(next);
                }
                this.host.validateCollectionVolumes(graph, parent);
                if (changed.length > 25)
                    throw new ContentPreparationError('preparation_too_large', 'Review up to 25 hierarchy changes together.');
                for (const child of changed) {
                    const state = await this.store.getCollectionOrganization(this.config.tenantId, creatorId);
                    state.revision++;
                    await this.store.commitCollectionOrganization({ tenantId: this.config.tenantId, creatorId, expectedRevision: state.revision - 1, state, collection: { ...child, revision: child.revision! }, expectedCollectionRevision: child.revision! - 1 });
                }
                draft.hierarchy = { children: draft.hierarchy.children.map(ref => ({ ...ref, revision: graph.find(c => c.collectionId === ref.id)!.revision ?? 0 })), state: 'applied' };
            }
            if (change.target.kind === 'collection') {
                const collection = target as CreatorCollection, state = await this.store.getCollectionOrganization(this.config.tenantId, creatorId);
                state.revision++;
                // Reordering/membership acceptance does not invoke the legacy automatic publisher.
                const members = change.orderedIds.map((workId, position) => ({ collectionId: collection.collectionId, workId, position, addedAt: this.now() }));
                await this.store.commitCollectionOrganization({ tenantId: this.config.tenantId, creatorId, expectedRevision: state.revision - 1, state, collection: { ...collection, type: draft.settings.structure?.collectionType ?? collection.type, title: draft.title, revision: (collection.revision ?? 0) + 1, updatedAt: this.now() }, expectedCollectionRevision: collection.revision ?? 0, members });
            }
            else {
                const work = target as Work, assets = await this.store.listCanonicalAssetsByWork(this.config.tenantId, work.workId), existing = new Map(assets.map(a => [a.assetId, a]));
                const heldRefs = new Set(contentAssetReferences(work.body, undefined));
                for (const asset of assets)
                    if (!change.orderedIds.includes(asset.assetId) && heldRefs.has(asset.assetId))
                        throw new ContentPreparationError('content_held', 'A removed component is still used by the saved body. Update those references first.');
                const ids: string[] = [], resolvedIds = new Map<string, string>(), body = [...(work.body ?? [])];
                for (const selectedId of change.orderedIds) {
                    let asset = existing.get(selectedId);
                    if (!asset) {
                        const object = draft.objects.find(o => o.id === selectedId && ['original', 'attachment', 'cover'].includes(o.role)), file = object?.sourceFileId ? await this.store.getSourceFileById?.(object.sourceFileId) : undefined;
                        if (object?.provenance === 'authored') {
                            if (!body.some(b => b.blockId === object.id))
                                body.push(...(object.body?.length ? object.body.map((b, index) => ({ ...b, blockId: index === 0 ? object.id : `${object.id}-${index}` })) : [{ blockId: object.id, type: 'paragraph' as const, text: object.text }]));
                            object.result = { kind: 'work', id: work.workId, revision: work.revision + 1 };
                            continue;
                        }
                        if (!object || !file || file.creatorId !== creatorId || file.uploadState !== 'ready' || file.restricted || file.checksumSha256 && file.checksumSha256 !== object.checksum)
                            throw new ContentPreparationError('content_held', 'A staged component is unavailable or changed.');
                        const assetId = publicationIdentityHash([work.workId, file.fileId]).slice(0, 40), at = this.now();
                        const created: CanonicalAsset = { assetId, tenantId: this.config.tenantId, creatorId, kind: file.sourceKind === 'image' ? 'image' : file.sourceKind === 'video' ? 'video' : file.sourceKind === 'audio' ? 'audio' : 'document', status: 'ready', mimeType: file.mimeType, originalFilename: file.originalFilename, sizeBytes: file.sizeBytes, checksumSha256: object.checksum, storage: { mode: 'hosted', objectKey: file.storageKey }, metadata: { ...file.metadata, sourceFileId: file.fileId, contentWorkflowId: id }, createdAt: at, updatedAt: at };
                        if (!await this.store.getCanonicalAsset(this.config.tenantId, assetId))
                            await this.store.createCanonicalAsset(created);
                        asset = { ...created, attachment: { workId: work.workId, assetId, role: object.role === 'attachment' ? 'attachment' : 'content', position: ids.length } };
                    }
                    if (asset.deletedAt || asset.replacedByAssetId || asset.status !== 'ready' || asset.creatorId !== creatorId)
                        throw new ContentPreparationError('content_held', 'A component changed or is unavailable.');
                    ids.push(asset.assetId);
                    resolvedIds.set(selectedId, asset.assetId);
                    const intake = draft.objects.find(o => o.id === selectedId);
                    if (intake)
                        intake.result = { kind: 'work', id: work.workId, revision: work.revision + 1 };
                    const fields = change.componentMetadata?.[selectedId];
                    await this.store.attachAssetToWork(this.config.tenantId, { ...asset.attachment, workId: work.workId, assetId: asset.assetId, position: ids.length - 1, ...fields, role: (change.primaryId ?? work.primaryAssetId ?? change.orderedIds[0]) === selectedId ? 'primary' : asset.attachment.role === 'primary' ? 'content' : asset.attachment.role });
                }
                for (const asset of assets)
                    if (!ids.includes(asset.assetId))
                        await this.store.detachAssetFromWork(this.config.tenantId, work.workId, asset.assetId);
                const primaryId = change.primaryId ? resolvedIds.get(change.primaryId) : work.primaryAssetId && ids.includes(work.primaryAssetId) ? work.primaryAssetId : ids[0];
                await this.store.commitWorkRevision({ ...work, title: draft.title, body, primaryAssetId: primaryId, kind: ids.length > 1 && work.kind === 'image' ? 'gallery' : work.kind, revision: work.revision + 1, updatedAt: this.now() }, work.revision);
            }
            change.state = 'applied';
            draft.releaseScope = { workIds: change.target.kind === 'collection' ? change.additions.filter(id => change.orderedIds.includes(id)) : [change.target.id], componentIds: change.target.kind === 'work' ? change.additions.filter(id => change.orderedIds.includes(id)) : undefined };
            const updated = change.target.kind === 'work' ? await this.store.getWork(this.config.tenantId, change.target.id) : await this.store.getCreatorCollection(this.config.tenantId, change.target.id);
            draft.units = [{ ...change.target, revision: updated!.revision ?? 0 }, ...draft.units.filter(ref => ref.id !== change.target.id && (change.target.kind !== 'collection' || ref.kind !== 'work' || change.orderedIds.includes(ref.id)))];
            draft.entry.target = { ...change.target, revision: updated!.revision ?? 0 };
            if (change.target.kind === 'collection' && draft.hierarchy?.state === 'applied' && draft.settings.structure?.collectionType === 'volume') {
                const parent = await this.store.getCreatorCollection(this.config.tenantId, change.target.id);
                const resolved = await this.host.resolvedCollectionMembers(this.config.tenantId, parent!);
                for (const member of resolved) {
                    const work = await this.store.getWork(this.config.tenantId, member.workId);
                    if (!work || work.creatorId !== creatorId)
                        throw new ContentPreparationError('content_held', 'A child Work is unavailable.');
                    draft.units = [...draft.units.filter(u => u.id !== work.workId), { kind: 'work', id: work.workId, revision: work.revision }];
                }
                draft.releaseScope = { workIds: resolved.map(m => m.workId) };
            }
            draft.changes = { id: change.id, target: draft.entry.target, orderedIds: change.target.kind === 'work' ? (await this.store.listCanonicalAssetsByWork(this.config.tenantId, change.target.id)).map(a => a.assetId) : (await this.store.listCollectionWorks(this.config.tenantId, change.target.id)).map(m => m.workId), additions: [], replacements: [], state: 'applied' };
            return this.save(atomic, draft, operationId);
        });
    }
}
