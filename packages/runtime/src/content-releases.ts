import {randomUUID} from 'node:crypto';
import {contentAnnouncementTrigger,renderAnnouncementTemplate,defaultCollectionAnnouncementPreferences,announcementDestinationKey,renderAnnouncementTemplateText,type ContentWorkflowDraft,type CollectionReleaseBaseline,type ContentPreviewRecipe,type CollectionReleaseRequirement,type CollectionAnnouncementTriggerPreferences} from '@ubeeq/core';
import {publicationIdentityHash} from '@ubeeq/persistence';
import {ContentPreparationError} from './content-preparations.js';
import {contentPublicationBinding,type PreparedContentRepresentation} from './content-representations.js';
import type {ContentReleaseModels,ContentReleaseWorkflow,ContentReleaseHost,ReleaseRepresentations,ReleaseAnnouncementBlock,ReleasePrivateAnnouncementMedia,ReleaseBaseline,ReleaseOffer,ReleaseValueReference,ReleaseActivationOwnership,ReleaseActivationResource,PreparedReleaseActivation} from './content-release-host.js';
export type * from './content-release-host.js';
export interface PreparedRelease<M extends ContentReleaseModels> {
    id: string;
    purpose?: 'announcement_draft';
    announcementDraftContent?: M['announcementContent'];
    draftId: string;
    creatorId: string;
    actorId: string;
    revision: number;
    reviewId: string;
    fingerprint: string;
    state: 'prepared' | 'accepted' | 'completed' | 'needs_review' | 'cancelled';
    creatorFingerprint: string;
    blockRulesRevision: number;
    offerFingerprint?: string;
    hierarchyFingerprint?: string;
    connected?: M['connectedCommand'][];
    announcementTrigger?: CollectionAnnouncementTriggerPreferences;
    announcementMedia?: {
        initial: Record<string, ReleaseAnnouncementBlock[]>;
        follow_up: Record<string, ReleaseAnnouncementBlock[]>;
    };
    announcementMediaFiles?: ReleasePrivateAnnouncementMedia[];
    announcementActivationProtocol?:1;
    announcementActivation?:{schemaVersion:1;phase:'ownership_accepted'|'admission_accepted'|'media_activated';releaseFingerprint:string;ownership:ReleaseActivationOwnership;resources?:ReleaseActivationResource[];activeMediaKeys?:string[];deferredMediaKeys?:string[]};
    announcementMediaSources?: Record<string, string>;
    scheduledAt?: string;
    createdAt: string;
    completedAt?: string;
    error?: string;
    publicationFingerprints: Record<string, string>;
    previousExposure?: Array<{
        workId: string;
        revision: string;
        publicationId: string;
    }>;
    outputs: PreparedContentRepresentation<M['file']>[];
    fullOutputs?: PreparedContentRepresentation<M['file']>[];
    completed: string[];
    announcementReleaseId?: string;
    collectionsCompleted?: string[];
    cancellationPending?: boolean;
    collectionBaselines?: Record<string, ReleaseBaseline>;
}
/** Owns accepted content publication commands. Preparation and private processing never authorize a write. */
export class ContentReleaseService<M extends ContentReleaseModels> {
    private workerCursor?: string;
    readonly representations: ReleaseRepresentations<M>;
    constructor(readonly workflows: ContentReleaseWorkflow<M>, readonly allowed: (work: M['work']) => Promise<boolean>, private readonly host:ContentReleaseHost<M>, representations:ReleaseRepresentations<M>, readonly runtime?:{tick():Promise<unknown>}) {
        const required=['isNativeDestination','nativeWorkDestination','nativeCollectionDestination','nativeWorkAnnouncementBinding','nativeCollectionAnnouncementBinding','collection','announcement','contentPublishing','resolvedContentOffer','validateNativeCollectionOffer','communityActorAllowed','announcementRules','announcementDestinations','announcementKnownLinks','parseAnnouncement','validateAnnouncement','announcementDocumentForDestination','stageAnnouncementMedia','pinCollectionAnnouncementMedia','activateAnnouncementMedia','readStagedAnnouncementMedia','readAnnouncementFile','readAnnouncementImage','evaluatePublicationPolicy','nativeWorkPublication','resolvedCollectionMembers','evaluateNativeCollectionPublication','announcementPlans','captureCollectionReleaseRequirements','readOrchestrationValue'] as const;
        if(required.some(key=>typeof host?.[key]!=='function')||typeof allowed!=='function'||!representations||['full','previews','read'].some(key=>typeof representations[key as keyof ReleaseRepresentations<M>]!=='function'))throw new ContentPreparationError('unsupported_operation','Content release requires its actual authenticated publishing, announcement and private media host.',503);
        if(host.announcementActivation&&(typeof host.announcementActivation.stageOwnership!=='function'||typeof host.announcementActivation.prepare!=='function'||typeof host.prepareAnnouncementMediaAcceptance!=='function'))throw new ContentPreparationError('unsupported_operation','Strong announcement ordering requires actual pre-captured immutable media acceptance.',503);
        this.representations=representations;
    }
    private atomic() {
        const atomic = this.store.publicationAtomic;
        if (!atomic?.supportsConditionalTransactions || ['run', 'get', 'list', 'put', 'savePublication', 'active'].some(key => typeof atomic[key as keyof typeof atomic] !== 'function'))
            throw new ContentPreparationError('unsupported_operation', 'Content release requires the canonical conditional transaction authority.', 503);
        return atomic;
    }
    private get store() { return this.workflows.store; }
    private get config() { return this.workflows.config; }
    private key(creatorId: string) { return this.workflows.kind(creatorId, 'release'); }
    private async hierarchyFingerprint(draft: ContentWorkflowDraft) {
        const refs = draft.hierarchy?.children ?? [];
        const seen = new Set<string>(), records: unknown[] = [];
        const all = refs.length ? await this.store.listCreatorCollections(this.config.tenantId, draft.creatorId) : [];
        const visit = async (id: string) => { if (seen.has(id))
            return; seen.add(id); if (seen.size > 40)
            throw new ContentPreparationError('preparation_too_large', 'Review a hierarchy with up to 40 included groupings at a time.'); const c = all.find(c => c.collectionId === id); if (!c || c.deletedAt || c.archivedAt || ['archived', 'deleted'].includes(c.status) || c.managementState === 'archived')
            throw new ContentPreparationError('review_stale', 'An included grouping is unavailable.'); const members = await this.store.listCollectionWorks(this.config.tenantId, id); records.push([c, members]); if (c.type === 'volume')
            for (const child of all.filter(child => child.volumeIds?.includes(id)).sort((a, b) => a.collectionId.localeCompare(b.collectionId)))
                await visit(child.collectionId); };
        for (const ref of refs) {
            await this.workflows.target(draft.creatorId, ref);
            await visit(ref.id);
        }
        return publicationIdentityHash(records);
    }
    private async checkOffer(creatorId: string, release: PreparedRelease<M>) {
        if (!release.offerFingerprint)
            return;
        const draft = await this.workflows.get(creatorId, release.draftId);
        const offer = draft.settings.offerId ? await this.host.resolvedContentOffer(creatorId, draft.settings.offerId) : null;
        await this.checkCommerceScope(draft, offer);
        if (!offer || offer.status !== 'published' || publicationIdentityHash(offer) !== release.offerFingerprint) {
            throw new ContentPreparationError('review_stale', 'The reviewed premium offering changed. Review its current access before publishing.');
        }
    }
    private async checkCommerceScope(draft: ContentWorkflowDraft, offer: ReleaseOffer|null|undefined) {
        if (!draft.settings.offerId?.startsWith('commerce:'))
            return;
        if (!offer || !('snapshot' in offer))
            throw new ContentPreparationError('offering_unavailable', 'Choose a current purchase or subscription offer.');
        const current = offer.snapshot.offer, fullCollections = draft.units.filter(u => u.kind === 'collection' && !draft.previews.some(p => p.previewCollectionId === u.id));
        if (!fullCollections.length || fullCollections.some(ref => !current.benefits.some(b => b.type === 'gallery' && b.resourceId === ref.id)))
            throw new ContentPreparationError('offering_scope_mismatch', 'The reviewed offering must include this exact Collection or Volume.');
        const terms = draft.settings.commerce;
        if (terms && (current.currency !== terms.currency || current.amountMinor !== Math.round(Number(terms.amount) * (terms.currency === 'JPY' ? 1 : 100)) || current.terms !== terms.terms || current.supportEmail !== terms.supportEmail || !!current.billing !== (terms.kind === 'subscription') || current.billing !== terms.billing || current.benefits.some(b => b.type === 'download') !== terms.downloads || current.benefits.some(b => b.type === 'package') !== terms.packageDownload))
            throw new ContentPreparationError('offering_terms_changed', 'Publish and review an offering version matching these proposed price, licence and download terms before releasing protected content.');
    }
    private async checkAnnouncementBindings(creatorId: string, release: PreparedRelease<M>) {
        const trigger = release.announcementTrigger;
        if (!trigger || trigger.behaviour === 'off')
            return;
        const options = await this.host.announcementDestinations(creatorId);
        for (const selected of [...trigger.destinations, ...(trigger.followUp?.destinations ?? [])]) {
            const available = options.some(option => option.available && option.communityDestinationId === selected.settings.destinationId && option.destinationKey === announcementDestinationKey(selected.binding));
            if (!available)
                throw new ContentPreparationError('review_stale', 'An announcement account or target changed after review. Review its exact destination again.');
        }
    }
    private async actorAllowed(creatorId: string, release: PreparedRelease<M>) {
        if (!await this.host.communityActorAllowed(release.actorId, creatorId))
            return false;
        const draft = await this.workflows.get(creatorId, release.draftId);
        if (!draft.units.some(u => u.kind === 'collection'))
            return true;
        if ((await this.store.getPlatformRoleAssignment(release.actorId))?.role === 'admin')
            return true;
        return (await this.store.listCreatorMembers(creatorId)).some(member => member.userId === release.actorId && ['owner', 'admin', 'manager'].includes(member.role));
    }
    private async stageDraftAnnouncement(draft: ContentWorkflowDraft, outputs: PreparedContentRepresentation<M['file']>[], release: PreparedRelease<M>) {
        const subject = draft.units.find(u => u.id === draft.previews.find(p => p.previewCollectionId)?.previewCollectionId) ?? draft.units.find(u => u.kind === 'collection') ?? draft.entry.target ?? draft.units[0];
        if (!subject)
            throw new ContentPreparationError('content_pending', 'Select or save content before preparing its announcement.');
        const known = await this.host.announcementKnownLinks(draft.creatorId, subject.kind === 'work' ? subject.id : undefined, subject.kind === 'collection' ? subject.id : undefined), creator = await this.store.getCreatorById(draft.creatorId), unit = await this.workflows.target(draft.creatorId, subject);
        const link = known.links[0] ?? (this.config.appOrigin && creator ? { url: `${this.config.appOrigin.replace(/\/$/, '')}/creators/${encodeURIComponent(creator.slug)}/${subject.kind === 'work' ? 'works' : 'collections'}/${encodeURIComponent(unit.slug)}`, label: 'View content' } : undefined);
        if (!link)
            throw new ContentPreparationError('link_unavailable', 'Configure a public content URL before preparing this linked announcement.');
        const options = await this.host.announcementDestinations(draft.creatorId), selected = options.filter(option => draft.settings.announce.destinationIds.includes(option.communityDestinationId));
        if (selected.some(option => !option.available) || selected.length !== draft.settings.announce.destinationIds.length)
            throw new ContentPreparationError('destination_unavailable', 'Rebind the unavailable announcement destinations.');
        const template = draft.settings.announce.template ?? defaultCollectionAnnouncementPreferences('Etc/UTC').initial.template;
        const staged = await this.host.stageAnnouncementMedia(async () => {
            const media = await this.host.pinCollectionAnnouncementMedia(draft.creatorId, subject.kind === 'collection' ? subject.id : '', draft.settings.announce.media ?? { mode: 'none' }, draft.units.filter(u => u.kind === 'work').map(u => u.id), outputs);
            const values = { 'collection.title': draft.title, 'collection.description': '', 'creator.name': creator?.name ?? '', 'primaryLink.url': link?.url ?? '', 'primaryLink.label': link?.label ?? 'View content', 'release.newWorkCount': draft.units.filter(u => u.kind === 'work').length };
            const document = { version: 1, blocks: [...renderAnnouncementTemplate({ template, values }), ...media.blocks] }, destinationDocuments = Object.fromEntries(selected.map(destination => [destination.communityDestinationId, { version: 1, blocks: [...renderAnnouncementTemplate({ template, values, platform: destination.binding.provider, destinationKey: destination.destinationKey }), ...structuredClone(media.blocks)] }]));
            const content = this.host.parseAnnouncement({ title: draft.title, document, destinationDocuments, url: link?.url, format: 'recommended', ...(subject.kind === 'collection' ? { sourceCollectionId: subject.id } : { sourceWorkId: subject.id }) }, draft.units.filter(u => u.kind === 'work').map(u => u.id));
            await this.host.validateAnnouncement(content, selected, draft.creatorId, release.blockRulesRevision);
            return content;
        });
        release.announcementDraftContent = staged.value;
        release.announcementMediaFiles = [...(release.announcementMediaFiles ?? []), ...staged.files];
        release.announcementMedia ??= { initial: {}, follow_up: {} };
        release.announcementMediaSources ??= {};
        const documents = selected.length ? Object.fromEntries(selected.map(option => [option.communityDestinationId, this.host.announcementDocumentForDestination(staged.value.destinationDocuments?.[option.communityDestinationId] ?? staged.value.document!, option.communityDestinationId)])) : { draft: staged.value.document! };
        const previews = [];
        for (const [id, document] of Object.entries(documents)) {
            const media = document.blocks.filter(block => ['image', 'file', 'video'].includes(block.type));
            release.announcementMedia.initial[id] = media;
            for (const block of media) {
                if (block.sourceAssetId)
                    release.announcementMediaSources[block.sourceAssetId] = publicationIdentityHash(await this.store.getCanonicalAsset(this.config.tenantId, block.sourceAssetId));
                if (block.sourceWorkId)
                    release.announcementMediaSources[`work:${block.sourceWorkId}`] = publicationIdentityHash(await this.store.getWork(this.config.tenantId, block.sourceWorkId));
            }
            previews.push({ step: 'initial' as const, destinationId: id, label: selected.find(option => option.communityDestinationId === id)?.displayName ?? 'Unsent announcement draft', document: { version: 1, blocks: document.blocks.map(block => ['image', 'file'].includes(block.type) ? { id: block.id, type: block.type, alt: block.alt, filename: block.filename, caption: block.caption } : block) }, url: link?.url ?? '', text: '', representationId: `announcement-initial-${id}`, images: media.filter(block => block.type === 'image').map(block => ({ id: block.id, altText: block.alt ?? '', caption: block.caption })), files: media.filter(block => block.type === 'file').map(block => ({ id: block.id, filename: block.filename ?? 'Attachment', mime: block.mime, bytes: block.sizeBytes })) });
        }
        return previews;
    }
    async prepareAnnouncementDraft(creatorId: string, id: string, expectedRevision: number, actorId: string) {
        const draft = await this.workflows.get(creatorId, id);
        if (draft.revision !== expectedRevision || draft.state !== 'draft')
            throw new ContentPreparationError('revision_conflict', 'The preparation changed.');
        for (const ref of draft.units)
            await this.workflows.target(creatorId, ref);
        const prepared = await this.workflows.review(creatorId, id, expectedRevision, 'save');
        const release: PreparedRelease<M> = { purpose: 'announcement_draft', id: prepared.review.id, draftId: id, creatorId, actorId, revision: draft.revision, reviewId: prepared.review.id, fingerprint: prepared.review.fingerprint, state: 'prepared', creatorFingerprint: publicationIdentityHash(await this.store.getCreatorById(creatorId)), blockRulesRevision: (await this.host.announcementRules()).revision, createdAt: new Date().toISOString(), publicationFingerprints: {}, outputs: [], completed: [] };
        const outputs: PreparedContentRepresentation<M['file']>[] = [];
        for (const ref of draft.units.filter(u => u.kind === 'work')) {
            const publication = (await this.store.listPublicationsByWork(this.config.tenantId, ref.id)).find(p => this.host.isNativeDestination(p.destination) && p.status === 'live' && ['public', 'unlisted'].includes(p.visibility)), binding = contentPublicationBinding<M['file']>(publication);
            if (binding)
                outputs.push(binding.manifest);
        }
        const announcementPreviews = await this.stageDraftAnnouncement(draft, outputs, release);
        if(this.host.announcementActivation)release.announcementActivationProtocol=1;
        release.announcementTrigger = contentAnnouncementTrigger({ ...draft.settings.announce, mode: 'draft' }, (await this.host.announcementDestinations(creatorId)).filter(option => option.available).map(option => ({ binding: option.binding, settings: { destinationId: option.communityDestinationId } })), 'native');
        if (Buffer.byteLength(JSON.stringify(release)) > 300000)
            throw new ContentPreparationError('preparation_too_large', 'Reduce the selected announcement media before reviewing.');
        await this.atomic().run(async () => { const current = await this.workflows.get(creatorId, id); if (current.review?.id !== prepared.review.id)
            throw new ContentPreparationError('review_stale', 'The announcement preparation changed.'); await this.atomic().put(this.key(creatorId), release.id, release); });
        return { ...prepared, release: { id: release.id, purpose: release.purpose, outputs: [], announcementPreviews } };
    }
    async announcementDraft(creatorId: string, id: string, expectedRevision: number, actorId: string, releaseId?: string) {
        const draft = await this.workflows.get(creatorId, id);
        if (draft.revision !== expectedRevision)
            throw new ContentPreparationError('revision_conflict', 'The content preparation changed.');
        const subject = draft.units.find(u => u.id === draft.previews.find(p => p.previewCollectionId)?.previewCollectionId) ?? draft.units.find(u => u.kind === 'collection') ?? draft.entry.target ?? draft.units[0];
        if (!subject)
            throw new ContentPreparationError('content_pending', 'Save or select content before preparing its announcement.');
        await this.workflows.target(creatorId, subject);
        const known = await this.host.announcementKnownLinks(creatorId, subject.kind === 'work' ? subject.id : undefined, subject.kind === 'collection' ? subject.id : undefined), link = known.links[0];
        if (!releaseId && draft.settings.announce.media && draft.settings.announce.media.mode !== 'none')
            throw new ContentPreparationError('review_required', 'Review the selected announcement media before creating its authoring draft.');
        const frozen = releaseId ? await this.atomic().get(this.key(creatorId), releaseId) as PreparedRelease<M> | undefined : undefined;
        const creator = await this.store.getCreatorById(creatorId), template = draft.settings.announce.template ?? defaultCollectionAnnouncementPreferences('Etc/UTC').initial.template;
        const document = frozen?.announcementDraftContent?.document ?? { version: 1, blocks: renderAnnouncementTemplate({ template, values: { 'collection.title': draft.title, 'collection.description': '', 'creator.name': creator?.name ?? '', 'primaryLink.url': link?.url ?? '', 'primaryLink.label': link?.label ?? 'View content', 'release.newWorkCount': draft.units.filter(u => u.kind === 'work').length } }) };
        const content = frozen?.announcementDraftContent ?? this.host.parseAnnouncement({ title: draft.title, document, url: link?.url, format: 'recommended', ...(subject.kind === 'collection' ? { sourceCollectionId: subject.id } : { sourceWorkId: subject.id }) }, draft.units.filter(u => u.kind === 'work').map(u => u.id));
        const now = new Date().toISOString(), announcementPublicationId = publicationIdentityHash([id, releaseId ?? 'ad-hoc', 'announcement-draft']), atomic = this.atomic();
        return atomic.run(async () => {
            await this.workflows.get(creatorId, id);
            const existing = await this.store.getAnnouncementPublication(announcementPublicationId);
            if (existing)
                return existing;
            const row = this.host.announcement({ announcementPublicationId, tenantId: this.config.tenantId, userId: actorId, creatorIdentityId: creatorId, provider: 'discord', preset: 'recommended', origin: 'manual', kind: 'ad_hoc', subject: { type: subject.kind, ids: [subject.id] }, status: 'draft', idempotencyKey: `content-draft:${announcementPublicationId}`, payload: { planVersion: 1, revision: 1, title: draft.title, text: content.text, document: content.document, destinationDocuments: content.destinationDocuments, announcement: content, url: content.primary?.url ?? link?.url, sourceWorkId: subject.kind === 'work' ? subject.id : undefined, sourceCollectionId: subject.kind === 'collection' ? subject.id : undefined, format: 'recommended', destinationIds: draft.settings.announce.destinationIds }, attemptCount: 0, createdAt: now, updatedAt: now });
            if (!await this.store.claimAnnouncementPublication(null, row))
                throw new ContentPreparationError('revision_conflict', 'The announcement draft changed. Reload its current revision.');
            return row;
        });
    }
    async preparePreviews(creatorId: string, id: string, expectedRevision: number, recipes: Record<string, ContentPreviewRecipe> = {}) {
        const draft = await this.workflows.get(creatorId, id);
        if (draft.revision !== expectedRevision || draft.state !== 'draft' || !draft.units.length)
            throw new ContentPreparationError('revision_conflict', 'Save the current content unit before preparing previews.');
        const prepared = await this.representations.previews(draft, recipes);
        if (!prepared.outputs.length)
            throw new ContentPreparationError('preview_missing', 'Upload and map prepared previews, or choose a supported generated image/text recipe.');
        const atomic = this.atomic();
        for (const output of prepared.outputs)
            await atomic.run(async () => { await this.workflows.target(creatorId, output.subject); await atomic.put(this.workflows.kind(creatorId, 'representation'), output.id, output); });
        return atomic.run(async () => {
            const current = await this.workflows.get(creatorId, id);
            if (current.revision !== expectedRevision || current.state !== 'draft')
                throw new ContentPreparationError('revision_conflict', 'The preparation changed while preview processing completed.');
            let previewCollectionId: string | undefined;
            const full = current.units.find(u => u.kind === 'collection');
            if (full && current.settings.access === 'premium') {
                await this.workflows.target(creatorId, full);
                previewCollectionId = current.previews.find(p => p.previewCollectionId)?.previewCollectionId ?? publicationIdentityHash([id, 'preview-gallery']).slice(0, 40);
                const existing = await this.store.getCreatorCollection(this.config.tenantId, previewCollectionId), at = new Date().toISOString(), collection = this.host.collection({ ...(existing ?? {}), tenantId: this.config.tenantId, creatorId, collectionId: previewCollectionId, title: `${current.title} — Preview`, slug: existing?.slug ?? `preview-${previewCollectionId.slice(0, 12)}`, slugHistory: existing?.slugHistory ?? [`preview-${previewCollectionId.slice(0, 12)}`], type: 'gallery' as const, status: existing?.status ?? 'draft' as const, visibility: existing?.visibility ?? 'private' as const, category: 'free_preview' as const, relationships: { premiumCollectionIds: [full.id], relatedCollectionIds: [] }, revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? at, updatedAt: at });
                if (existing && (existing.creatorId !== creatorId || !existing.relationships?.premiumCollectionIds?.includes(full.id)))
                    throw new ContentPreparationError('preview_missing', 'The linked Preview Gallery belongs to another content unit.');
                const state = await this.store.getCollectionOrganization(this.config.tenantId, creatorId);
                state.revision++;
                if (existing?.status !== 'published')
                    await this.store.commitCollectionOrganization({ tenantId: this.config.tenantId, creatorId, expectedRevision: state.revision - 1, state, collection, expectedCollectionRevision: existing?.revision ?? 0, members: prepared.outputs.map((output, position) => ({ collectionId: previewCollectionId!, workId: output.subject.id, representationId: output.id, position, addedAt: at })) });
            }
            if (previewCollectionId) {
                const collection = await this.store.getCreatorCollection(this.config.tenantId, previewCollectionId);
                current.units = [...current.units.filter(u => u.id !== previewCollectionId), { kind: 'collection', id: previewCollectionId, revision: collection!.revision ?? 0 }];
            }
            current.previews = prepared.relationships.map(r => ({ ...r, previewCollectionId }));
            current.revision++;
            current.updatedAt = new Date().toISOString();
            delete current.review;
            await atomic.put(this.workflows.kind(creatorId), id, current);
            return current;
        });
    }
    async prepare(creatorId: string, id: string, expectedRevision: number, action: 'publish' | 'schedule', recipes: Record<string, ContentPreviewRecipe> = {}, actorId?: string) {
        const draft = await this.workflows.get(creatorId, id), creatorBefore = publicationIdentityHash(await this.store.getCreatorById(creatorId));
        if (draft.revision !== expectedRevision)
            throw new ContentPreparationError('revision_conflict', 'The preparation changed. Save and review its current values.');
        if (draft.hierarchy?.state === 'draft')
            throw new ContentPreparationError('changes_pending', 'Review and apply the included grouping references before publication.');
        const hierarchyFingerprint = await this.hierarchyFingerprint(draft);
        if (draft.changes && draft.changes.state !== 'applied')
            throw new ContentPreparationError('changes_pending', 'Review and apply pending contents before reviewing publication.');
        if (!draft.units.length)
            throw new ContentPreparationError('content_pending', 'Save the private content unit before publication review.');
        if (draft.objects.some(object => ['original', 'cover', 'attachment'].includes(object.role) && !object.result))
            throw new ContentPreparationError('content_pending', 'Save the newly added content before reviewing its publication.');
        if (draft.settings.announce.mode === 'after_publication' && !draft.settings.publishDestinations.some(d => d.required))
            throw new ContentPreparationError('destination_required', 'Choose at least one required content result before announcing after publication.');
        if (!draft.settings.publishDestinations.length)
            throw new ContentPreparationError('destination_required', 'Choose a content publication destination.');
        if (action === 'schedule' && draft.settings.publishDestinations.some(d => d.destination === 'website'))
            throw new ContentPreparationError('unsupported_operation', 'This website publisher supports reviewed publication now. Publish the website now, or schedule the other destinations separately; the saved website preparation is retained.');
        const nativeSelected = draft.settings.publishDestinations.some(d => this.host.isNativeDestination(d.destination));
        if (draft.settings.publishDestinations.some(d => this.host.isNativeDestination(d.destination) && (d.connectionId || d.targetId || d.representation === 'link')))
            throw new ContentPreparationError('unsupported_operation', 'Choose a full or preview native content representation.');
        if (draft.settings.publishDestinations.some(d => !this.host.isNativeDestination(d.destination)) && !this.host.contentPublishing())
            throw new ContentPreparationError('unsupported_operation', 'The connected publishing runtime is unavailable on this instance.');
        if (draft.settings.access === 'members')
            throw new ContentPreparationError('access_unresolved', 'Bind the existing membership entitlement from content management before releasing member content. Follower access cannot substitute for membership.');
        if (!['free', 'premium'].includes(draft.settings.access))
            throw new ContentPreparationError('access_unresolved', 'Choose Free / public for this release, or finish the existing premium/member offering setup from content management. Protected originals will remain private.');
        if (draft.settings.discovery && draft.settings.visibility === 'unlisted')
            throw new ContentPreparationError('discovery_requires_public', 'Discovery requires a public native Work. Choose public visibility or turn Discovery off.');
        if (action === 'schedule' && !draft.settings.releaseTime)
            throw new ContentPreparationError('time_required', 'Resolve a release date, local time and IANA zone before scheduling.');
        if (draft.settings.releaseTime && Date.parse(draft.settings.releaseTime.instant) <= Date.now())
            throw new ContentPreparationError('time_elapsed', 'The chosen release time has passed. Review a new time.');
        const publicationFingerprints = Object.fromEntries(await Promise.all(draft.units.filter(u => u.kind === 'work').map(async (unit) => [unit.id, publicationIdentityHash((await this.store.listPublicationsByWork(this.config.tenantId, unit.id)).filter(p => this.host.isNativeDestination(p.destination)))])));
        const protectedOutput = draft.settings.access !== 'free';
        if (draft.settings.access === 'premium' && !draft.previews.some(p => p.previewCollectionId))
            throw new ContentPreparationError('preview_missing', 'Prepare the linked Preview Gallery before reviewing the premium release.');
        if (protectedOutput) {
            if (!draft.units.some(u => u.kind === 'collection'))
                throw new ContentPreparationError('access_unresolved', 'Individual premium/member access remains available through Work management. Bind that existing offering before releasing full content.');
            await this.host.validateNativeCollectionOffer(creatorId, draft.settings.access === 'premium' ? 'premium' : 'followers', draft.settings.offerId);
        }
        const storedPreviews = await Promise.all(draft.previews.flatMap(p => p.representationIds ?? []).map(id => this.atomic().get(this.workflows.kind(creatorId, 'representation'), id))) as PreparedContentRepresentation<M['file']>[];
        const previews = storedPreviews.length ? { outputs: storedPreviews, relationships: draft.previews } : await this.representations.previews(draft, recipes), outputs: PreparedContentRepresentation<M['file']>[] = [], fullOutputs: PreparedContentRepresentation<M['file']>[] = [];
        for(const ref of draft.units.filter(u=>u.kind==='work'&&!previews.outputs.some(p=>p.subject.id===u.id))){const publication=(await this.store.listPublicationsByWork(this.config.tenantId,ref.id)).find(p=>this.host.isNativeDestination(p.destination)&&p.status==='live'&&['public','unlisted'].includes(p.visibility)),manifest=contentPublicationBinding<M['file']>(publication)?.manifest;if(manifest?.kind==='preview'&&manifest.subject.revision===ref.revision)previews.outputs.push(manifest);}
        for (const ref of draft.units.filter(u => u.kind === 'work')) {
            if (draft.releaseScope && !draft.releaseScope.workIds.includes(ref.id)) {
                const preview = previews.outputs.find(output => output.subject.id === ref.id), publication = (await this.store.listPublicationsByWork(this.config.tenantId, ref.id)).find(p => this.host.isNativeDestination(p.destination));
                if (!preview || contentPublicationBinding<M['file']>(publication)?.manifest.id === preview.id)
                    continue;
            }
            const work = await this.workflows.target(creatorId, ref) as M['work'];
            if (!await this.allowed(work))
                throw new ContentPreparationError('content_held', 'A selected Work has an active publication hold.', 423);
            if (protectedOutput || draft.settings.publishDestinations.some(d => this.host.isNativeDestination(d.destination) && d.representation === 'preview') || (!nativeSelected && draft.settings.publishDestinations.every(d => d.representation === 'preview'))) {
                const preview = previews.outputs.find(p => p.subject.id === work.workId);
                if (!preview)
                    throw new ContentPreparationError('preview_missing', 'Prepare an approved preview for every selected Work. Full originals are never substituted.');
                outputs.push(preview);
            }
            else
                outputs.push(await this.representations.full(work));
            if (protectedOutput || draft.settings.publishDestinations.some(d => d.representation === 'full'))
                fullOutputs.push(await this.representations.full(work, true));
        }
        if (!outputs.length && !draft.units.some(u => u.kind === 'collection'))
            throw new ContentPreparationError('content_pending', 'No complete Work representation is ready.');
        const atomic = this.atomic();
        await atomic.run(async () => {
            const current = await this.workflows.get(creatorId, id);
            if (current.revision !== draft.revision)
                throw new ContentPreparationError('revision_conflict', 'Content changed during preparation. Review it again.');
            current.previews = previews.relationships;
            await atomic.put(this.workflows.kind(creatorId), id, current);
        });
        if (creatorBefore !== publicationIdentityHash(await this.store.getCreatorById(creatorId)))
            throw new ContentPreparationError('review_stale', 'Creator preparation settings changed. Prepare a fresh review.');
        const prepared = await this.workflows.review(creatorId, id, expectedRevision, action);
        const release: PreparedRelease<M> = { id: prepared.review.id, draftId: id, creatorId, actorId: actorId ?? draft.actorId, revision: draft.revision, reviewId: prepared.review.id, fingerprint: prepared.review.fingerprint, state: 'prepared', creatorFingerprint: publicationIdentityHash(await this.store.getCreatorById(creatorId)), blockRulesRevision: (await this.host.announcementRules()).revision, scheduledAt: draft.settings.releaseTime?.instant, createdAt: new Date().toISOString(), outputs, fullOutputs, publicationFingerprints, previousExposure: (await Promise.all(outputs.map(async (output) => (await this.store.listPublicationsByWork(this.config.tenantId, output.subject.id)).filter(p => this.host.isNativeDestination(p.destination) && p.status === 'live' && ['public', 'unlisted'].includes(p.visibility)).map(p => ({ workId: output.subject.id, revision: String(p.sync.localRevision ?? 'unknown'), publicationId: p.publicationId }))))).flat(), completed: [] };
        release.hierarchyFingerprint = hierarchyFingerprint;
        if(this.host.announcementActivation)release.announcementActivationProtocol=1;
        release.connected = await this.host.contentPublishing()?.prepare(draft, outputs, fullOutputs, previews.outputs, release.actorId) ?? [];
        if (draft.settings.announce.mode !== 'off' && draft.settings.announce.destinationIds.length) {
            const plans = this.host.announcementPlans(), organization = await this.store.getCollectionOrganization(this.config.tenantId, creatorId);
            release.collectionBaselines = {};
            for (const ref of draft.units.filter(u => u.kind === 'collection'))
                release.collectionBaselines[ref.id] = await plans.baseline(creatorId, await this.workflows.target(creatorId, ref) as M['collection'], organization, release.actorId);
        }
        if (draft.settings.access === 'premium') {
            const offer = await this.host.resolvedContentOffer(creatorId, draft.settings.offerId!);
            if (offer?.status !== 'published')
                throw new ContentPreparationError('offering_unavailable', 'Publish the configured premium gallery offer before releasing its protected contents.');
            await this.checkCommerceScope(draft, offer);
            release.offerFingerprint = publicationIdentityHash(offer);
        }
        // Resolve selected announcement bindings before approval, using the existing authoring contract.
        if (draft.settings.announce.mode === 'after_publication' && !draft.settings.announce.destinationIds.length)
            throw new ContentPreparationError('destination_required', 'Choose announcement destinations, or prepare an unsent draft.');
        const destinations = await this.host.announcementDestinations(creatorId);
        const announcementTrigger = contentAnnouncementTrigger(draft.settings.announce, destinations.filter(d => d.available).map(d => ({ binding: d.binding, settings: { destinationId: d.communityDestinationId } })), nativeSelected ? 'native' : announcementDestinationKey(release.connected![0].requirements[0].target));
        release.announcementTrigger = structuredClone(announcementTrigger);
        release.announcementMedia = { initial: {}, follow_up: {} };
        release.announcementMediaFiles = [];
        release.announcementMediaSources = {};
        if (draft.settings.announce.destinationIds.some(id => !destinations.some(d => d.communityDestinationId === id && d.available)))
            throw new ContentPreparationError('destination_unavailable', 'Rebind the unavailable announcement destinations.');
        const creator = await this.store.getCreatorById(creatorId), subjectCollection = draft.previews.find(p => p.previewCollectionId)?.previewCollectionId ?? draft.units.find(u => u.kind === 'collection')?.id, collection = subjectCollection ? await this.store.getCreatorCollection(this.config.tenantId, subjectCollection) : undefined, work = !collection ? await this.store.getWork(this.config.tenantId, outputs[0].subject.id) : undefined;
        const url = `${this.config.appOrigin?.replace(/\/$/, '') ?? ''}/creators/${encodeURIComponent(creator!.slug)}/${collection ? 'collections' : 'works'}/${encodeURIComponent(collection?.slug ?? work!.slug)}`;
        const announcementPreviews = [];
        if (draft.settings.announce.mode !== 'off')
            for (const step of ['initial', 'follow_up'] as const) {
                const selected = step === 'initial' ? announcementTrigger : announcementTrigger.followUp;
                if (!selected)
                    continue;
                const selection = selected.media;
                for (const assetId of selection.mode === 'managed_previews' ? selection.assets.map(a => a.assetId) : []) {
                    const asset = await this.store.getCanonicalAsset(this.config.tenantId, assetId);
                    release.announcementMediaSources![assetId] = publicationIdentityHash(asset);
                }
                if (selection.mode === 'cover' && collection)
                    release.announcementMediaSources![`collection:${collection.collectionId}`] = publicationIdentityHash(collection.coverImage ?? collection.coverAssetId);
                for (const destination of destinations.filter(d => selected.destinations.some(s => s.settings.destinationId === d.communityDestinationId))) {
                    const staged = await this.host.stageAnnouncementMedia(async () => {
                        const media = await this.host.pinCollectionAnnouncementMedia(creatorId, collection?.collectionId ?? '', (() => { const media = structuredClone(selected.media), values = { 'collection.title': draft.title, 'creator.name': creator!.name, 'release.newWorkCount': outputs.length }; if (media.mode === 'cover') {
                            media.altText = renderAnnouncementTemplateText(media.altText, values);
                            if (media.caption)
                                media.caption = renderAnnouncementTemplateText(media.caption, values);
                        } if (media.mode === 'managed_previews')
                            media.assets = media.assets.map(asset => ({ ...asset, altText: renderAnnouncementTemplateText(asset.altText, values), caption: asset.caption ? renderAnnouncementTemplateText(asset.caption, values) : undefined })); return media; })(), outputs.map(o => o.subject.id), outputs);
                        const document = { version: 1, blocks: [...renderAnnouncementTemplate({ template: selected.template, links: { primary: { url, publishedWorkCount: outputs.length }, native: { url, publishedWorkCount: outputs.length } }, platform: destination.binding.provider, destinationKey: destination.destinationKey, values: { 'collection.title': draft.title, 'collection.description': '', 'creator.name': creator!.name, 'primaryLink.url': url, 'primaryLink.label': 'View content', 'release.newWorkCount': outputs.length, 'release.totalPublishedWorkCount': draft.units.filter(u => u.kind === 'work').length } }), ...media.blocks] };
                        const content = this.host.parseAnnouncement({ title: draft.title, document, url, format: 'recommended' }, outputs.map(o => o.subject.id));
                        await this.host.validateAnnouncement(content, [destination], creatorId, release.blockRulesRevision);
                        return content;
                    });
                    const content = staged.value;
                    release.announcementMediaFiles!.push(...staged.files);
                    const frozen = this.host.announcementDocumentForDestination(content.document!, destination.communityDestinationId).blocks.filter(b => ['image', 'file', 'video'].includes(b.type));
                    release.announcementMedia![step][destination.communityDestinationId] = frozen;
                    announcementPreviews.push({ step, destinationId: destination.communityDestinationId, label: destination.displayName, document: { version: 1, blocks: content.document!.blocks.map(block => ['image', 'file'].includes(block.type) ? { id: block.id, type: block.type, alt: block.alt, caption: block.caption, filename: block.filename } : block) }, text: content.text, url, timing: selected.timing, images: frozen.filter(b => b.type === 'image').map(b => ({ id: b.id, altText: b.alt ?? '', caption: b.caption })), files: frozen.filter(b => b.type === 'file').map(b => ({ id: b.id, filename: b.filename ?? 'Attachment', mime: b.mime, bytes: b.sizeBytes })), representationId: `announcement-${step}-${destination.communityDestinationId}` });
                }
            }
        if (draft.settings.announce.mode === 'draft' && !draft.settings.announce.destinationIds.length)
            announcementPreviews.push(...await this.stageDraftAnnouncement(draft, outputs, release));
        if (Buffer.byteLength(JSON.stringify(release)) > 300000)
            throw new ContentPreparationError('preparation_too_large', 'Split this release into smaller batches before reviewing publication.');
        await atomic.run(async () => {
            const current = await this.workflows.get(creatorId, id);
            if (current.review?.id !== prepared.review.id)
                throw new ContentPreparationError('review_stale', 'Review changed during preparation.');
            await atomic.put(this.key(creatorId), release.id, release);
        });
        return { ...prepared, release: { id: release.id, connected: await this.host.contentPublishing()?.summaries(release.connected ?? []) ?? [], outputs: await Promise.all(outputs.map(async (o) => ({ workId: o.subject.id, title: (await this.store.listPublicationsByWork(this.config.tenantId, o.subject.id)).find(p => this.host.isNativeDestination(p.destination))?.metadataOverrides?.title ?? (await this.store.getWork(this.config.tenantId, o.subject.id))?.title, revision: o.subject.revision, representation: o.kind, representationId: o.id, body: o.body, files:o.assets.filter(asset=>asset.kind==='document').map(asset=>({id:asset.id,filename:asset.file.filename,mime:asset.file.mimeType,bytes:asset.file.sizeBytes})), images: o.assets.filter(asset => asset.kind === 'image').map(asset => ({ id: asset.id, altText: asset.altText ?? '', caption: asset.caption })), components: o.assets.length, hasText: !!o.body?.length }))), scheduledAt: release.scheduledAt, announcement: draft.settings.announce, announcementPreviews } };
    }
    async accept(creatorId: string, id: string, expectedRevision: number, operationId: string, reviewId: string, fingerprint: string) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(operationId))
            throw new ContentPreparationError('invalid_input', 'Use a stable release operation identity.', 400);
        const pending = await this.atomic().get(this.key(creatorId), reviewId) as PreparedRelease<M> | undefined;
        if (pending?.state === 'prepared' && pending.connected?.length)
            await this.host.contentPublishing()!.validate(pending.connected, pending.actorId);
        const atomic = this.atomic();
        const mediaAcceptance=pending?.state==='prepared'?await this.prepareAnnouncementMediaAcceptance(pending):undefined;
        const release = await atomic.run(async () => {
            const digest = publicationIdentityHash([id, expectedRevision, reviewId, fingerprint]), previousReceipt = await atomic.get(this.workflows.kind(creatorId, 'release-receipt'), operationId);
            if (previousReceipt && previousReceipt.digest !== digest)
                throw new ContentPreparationError('revision_conflict', 'This release request identity was used for a different review.');
            const draft = await this.workflows.get(creatorId, id), stored = await atomic.get(this.key(creatorId), reviewId) as PreparedRelease<M> | undefined;
            if (stored?.state === 'accepted' || stored?.state === 'completed') {
                if (stored.fingerprint !== fingerprint || stored.draftId !== id)
                    throw new ContentPreparationError('review_stale', 'This release identity belongs to another review.');
                return stored;
            }
            if (stored?.hierarchyFingerprint && await this.hierarchyFingerprint(draft) !== stored.hierarchyFingerprint)
                throw new ContentPreparationError('review_stale', 'Included grouping contents changed after review.');
            const review = draft.review;
            if (draft.state !== 'draft' || draft.revision !== expectedRevision || !review || review.id !== reviewId || review.fingerprint !== fingerprint || review.blockers.length || Date.parse(review.expiresAt) <= Date.now() || publicationIdentityHash({ ...draft, review: undefined }) !== fingerprint || !stored || stored.fingerprint !== fingerprint)
                throw new ContentPreparationError('review_stale', 'Review the current exact release before publishing.');
            if (publicationIdentityHash(await this.store.getCreatorById(creatorId)) !== stored.creatorFingerprint || stored.blockRulesRevision !== (await this.host.announcementRules()).revision)
                throw new ContentPreparationError('review_stale', 'Creator settings or announcement rules changed since review.');
            for (const [workId, fingerprint] of Object.entries(stored.publicationFingerprints))
                if (publicationIdentityHash((await this.store.listPublicationsByWork(this.config.tenantId, workId)).filter(p => this.host.isNativeDestination(p.destination))) !== fingerprint)
                    throw new ContentPreparationError('review_stale', 'A selected Publication changed after review.');
            await this.checkOffer(creatorId, stored);
            if(!pending||publicationIdentityHash(pending.announcementMediaFiles??[])!==publicationIdentityHash(stored.announcementMediaFiles??[]))
                throw new ContentPreparationError('review_stale','The exact prepared media changed during acceptance.');
            await this.checkPreparedAnnouncementMedia(creatorId, stored, false);
            await mediaAcceptance?.enlist();
            await this.checkAnnouncementBindings(creatorId, stored);
            for (const ref of draft.units)
                await this.workflows.target(creatorId, ref);
            if (stored.purpose !== 'announcement_draft' && draft.settings.access === 'premium')
                await this.host.validateNativeCollectionOffer(creatorId, 'premium', draft.settings.offerId);
            stored.state = 'accepted';
            draft.state = 'accepted';
            await atomic.put(this.workflows.kind(creatorId, 'release-receipt'), operationId, { digest, reviewId });
            draft.operationIds.push(operationId);
            await atomic.put(this.key(creatorId), reviewId, stored);
            await atomic.put(this.workflows.kind(creatorId), id, draft);
            return stored;
        });
        await this.run(creatorId, release.id);
        return this.status(creatorId, release.id);
    }
    async reviewMedia(creatorId: string, draftId: string, reviewId: string, representationId: string, componentId: string) {
        const draft = await this.workflows.get(creatorId, draftId), release = await this.atomic().get(this.key(creatorId), reviewId) as PreparedRelease<M> | undefined;
        if (!release || release.draftId !== draftId || draft.review?.id !== reviewId || Date.parse(draft.review.expiresAt) <= Date.now())
            throw new ContentPreparationError('review_stale', 'Prepare the current exact release to inspect this media.', 404);
        if (representationId.startsWith('connected-'))
            return this.host.contentPublishing()!.media(release.connected ?? [], representationId, componentId);
        if (representationId.startsWith('announcement-')) {
            const match = Object.entries(release.announcementMedia ?? {}).flatMap(([step, documents]) => Object.entries(documents).map(([destination, blocks]) => ({ id: `announcement-${step}-${destination}`, blocks }))).find(row => row.id === representationId);
            const block = match?.blocks.find(b => b.id === componentId && ['image', 'file'].includes(b.type)), file = release.announcementMediaFiles?.find(f => f.mediaKey === block?.mediaKey);
            if (block?.mediaKey && block.type === 'file') {
                const attachment = await this.host.readAnnouncementFile(block.mediaKey);
                return { bytes: attachment.bytes, file: { mimeType: attachment.mime, filename: block.filename ?? attachment.filename } };
            }
            if (!file && block?.mediaKey && block.type === 'image') {
                const image = await this.host.readAnnouncementImage(block.mediaKey, 10485760, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], true);
                return { bytes: image.bytes, file: { mimeType: image.mime } };
            }
            if (!file)
                throw new ContentPreparationError('not_found', 'The reviewed announcement image is unavailable.', 404);
            return { bytes: await this.host.readStagedAnnouncementMedia(file), file: { mimeType: file.mime } };
        }
        const manifest = release.outputs.find(output => output.id === representationId), component = manifest?.assets.find(asset => asset.id === componentId && ['image','document'].includes(asset.kind));
        if (!manifest || !component)
            throw new ContentPreparationError('not_found', 'The reviewed image is unavailable.', 404);
        return this.representations.read(manifest, componentId);
    }
    private async prepareAnnouncementMediaAcceptance(release:PreparedRelease<M>){
        if(this.atomic().active())throw new ContentPreparationError('unsupported_operation','Capture immutable media validation before entering acceptance.',503);
        if(this.host.prepareAnnouncementMediaAcceptance){const prepared=await this.host.prepareAnnouncementMediaAcceptance(release.announcementMediaFiles??[]);if(typeof prepared?.enlist!=='function')throw new ContentPreparationError('unsupported_operation','Actual media acceptance guards are required.',503);return prepared;}
        for(const file of release.announcementMediaFiles??[])await this.host.readStagedAnnouncementMedia(file);
        return undefined;
    }
    private async checkPreparedAnnouncementMedia(creatorId: string, release: PreparedRelease<M>, readPhysical=true) {
        for (const [id, fingerprint] of Object.entries(release.announcementMediaSources ?? {})) {
            const current = id.startsWith('work:') ? await this.store.getWork(this.config.tenantId, id.slice(5)) : id.startsWith('collection:') ? await this.store.getCreatorCollection(this.config.tenantId, id.slice(11)) : await this.store.getCanonicalAsset(this.config.tenantId, id);
            if (id.startsWith('work:') && (!current || !await this.allowed(current as M['work'])))
                throw new ContentPreparationError('content_held', 'An announcement source Work is unavailable.');
            const value = id.startsWith('collection:') ? (current as M['collection'])?.coverImage ?? (current as M['collection'])?.coverAssetId : current;
            if (publicationIdentityHash(value) !== fingerprint)
                throw new ContentPreparationError('review_stale', 'Selected announcement media changed. Prepare a fresh review.');
        }
        if(readPhysical)for (const file of release.announcementMediaFiles ?? [])
            await this.host.readStagedAnnouncementMedia(file);
    }
    async status(creatorId: string, id: string) {
        await this.workflows.list(creatorId);
        const release = await this.atomic().get(this.key(creatorId), id) as PreparedRelease<M> | undefined;
        if (!release)
            throw new ContentPreparationError('not_found', 'Release not found.', 404);
        return { id: release.id, state: release.state, completed: release.completed.length, total: release.outputs.length, scheduledAt: release.scheduledAt, error: release.error, announcementReleaseId: release.announcementReleaseId, announcementActivation:release.announcementActivation?{phase:release.announcementActivation.phase,resources:release.announcementActivation.resources}:undefined, draft: await this.workflows.get(creatorId, release.draftId) };
    }
    async cancel(creatorId: string, id: string, expectedRevision: number) {
        const atomic = this.atomic();
        const draft = await atomic.run(async () => {
            const release = await atomic.get(this.key(creatorId), id) as PreparedRelease<M> | undefined;
            if (!release)
                throw new ContentPreparationError('not_found', 'Release not found.', 404);
            const draft = await this.workflows.get(creatorId, release.draftId);
            for (const ref of draft.units.filter(u => u.kind === 'collection'))
                await this.workflows.target(creatorId, ref);
            if (release.state === 'cancelled')
                return draft;
            if (!['accepted', 'needs_review'].includes(release.state) || draft.revision !== expectedRevision)
                throw new ContentPreparationError('revision_conflict', 'The release progressed. Reload its status before cancelling remaining work.');
            release.state = 'cancelled';
            release.cancellationPending = true;
            draft.state = 'draft';
            draft.revision++;
            delete draft.review;
            draft.updatedAt = new Date().toISOString();
            await atomic.put(this.key(creatorId), id, release);
            await atomic.put(this.workflows.kind(creatorId), draft.id, draft);
            return draft;
        });
        await this.cancelConnected(creatorId, id);
        return draft;
    }
    private async cancelConnected(creatorId: string, id: string) {
        const atomic = this.atomic(), release = await atomic.get(this.key(creatorId), id) as PreparedRelease<M>;
        if (release.state !== 'cancelled' || !release.cancellationPending)
            return;
        await this.host.contentPublishing()?.cancel(id, release.actorId, release.connected ?? []);
        await atomic.run(async () => { const current = await atomic.get(this.key(creatorId), id) as PreparedRelease<M>; if (current.state === 'cancelled')
            await atomic.put(this.key(creatorId), id, { ...current, cancellationPending: false }); });
    }
    async run(creatorId: string, id: string) {
        const atomic = this.atomic(), initial = await atomic.get(this.key(creatorId), id) as PreparedRelease<M> | undefined;
        if (initial?.state === 'accepted' && initial.purpose === 'announcement_draft') {
            try {
                await this.finishAnnouncementDraft(creatorId, initial);
            }
            catch (error) {
                await atomic.run(async () => { const current = await atomic.get(this.key(creatorId), id) as PreparedRelease<M>; if (current.state === 'accepted')
                    await atomic.put(this.key(creatorId), id, { ...current, state: 'needs_review', error: error instanceof Error ? error.message : 'The announcement draft needs review.' }); });
            }
            return;
        }
        if (!initial || initial.state !== 'accepted' || initial.scheduledAt && Date.parse(initial.scheduledAt) > Date.now())
            return;
        try {
            if (initial.scheduledAt && !Number.isFinite(Date.parse(initial.scheduledAt)))
                throw new ContentPreparationError('schedule_invalid', 'The saved release time is invalid. Review a new release time.');
            if (initial.scheduledAt && Date.now() - Date.parse(initial.scheduledAt) > 86400000)
                throw new ContentPreparationError('schedule_expired', 'The release exceeded its allowed lateness. Review a new release time.');
            if (publicationIdentityHash(await this.store.getCreatorById(creatorId)) !== initial.creatorFingerprint || initial.blockRulesRevision !== (await this.host.announcementRules()).revision)
                throw new ContentPreparationError('review_stale', 'Creator settings or announcement block rules changed. Review this release again.');
            await this.checkAnnouncementBindings(creatorId, initial);
            if (!await this.actorAllowed(creatorId, initial))
                throw new ContentPreparationError('access_denied', 'Publishing access changed. Review this release.', 403);
            if (initial.hierarchyFingerprint && await this.hierarchyFingerprint(await this.workflows.get(creatorId, initial.draftId)) !== initial.hierarchyFingerprint)
                throw new ContentPreparationError('review_stale', 'Included grouping contents changed. Review this release again.');
            for (const output of initial.outputs) {
                await atomic.run(async () => {
                    const release = await atomic.get(this.key(creatorId), id) as PreparedRelease<M>;
                    if (release.state !== 'accepted' || release.completed.includes(output.id))
                        return;
                    if (!await this.actorAllowed(creatorId, release))
                        throw new ContentPreparationError('access_denied', 'Publishing access changed.', 403);
                    await this.checkOffer(creatorId, release);
                    const draft = await this.workflows.get(creatorId, release.draftId), work = await this.workflows.target(creatorId, output.subject) as M['work'];
                    if (!await this.allowed(work) || !(await this.host.evaluatePublicationPolicy({ operation: 'publish', targets: [{ type: 'creator', id: creatorId }, { type: 'work', id: work.workId }, ...output.assets.filter(a => a.sourceAssetId).map(a => ({ type: 'asset' as const, id: a.sourceAssetId! }))] })).allowed)
                        throw new ContentPreparationError('content_held', 'Publication access changed. Review this release.', 423);
                    for (const preparedOutput of [output, ...(release.fullOutputs ?? []).filter(f => f.subject.id === output.subject.id)])
                        for (const component of preparedOutput.assets) {
                            if (component.sourceFileId) {
                                const file = await this.store.getSourceFileById?.(component.sourceFileId);
                                if (!file || file.creatorId !== creatorId || file.uploadState !== 'ready' || file.restricted || file.checksumSha256 && file.checksumSha256 !== component.sourceChecksum || preparedOutput.kind === 'preview' && file.premium)
                                    throw new ContentPreparationError('content_held', 'A reviewed source file changed or is no longer available.');
                            }
                            if (component.sourceAssetId) {
                                const asset = await this.store.getCanonicalAsset(this.config.tenantId, component.sourceAssetId);
                                if (!asset || asset.creatorId !== creatorId || asset.status !== 'ready' || asset.deletedAt || asset.replacedByAssetId || asset.checksumSha256 !== component.sourceChecksum)
                                    throw new ContentPreparationError('content_held', 'A reviewed source component changed.');
                            }
                        }
                    if (!draft.settings.publishDestinations.some(d => this.host.isNativeDestination(d.destination))) {
                        release.completed.push(output.id);
                        await atomic.put(this.key(creatorId), id, release);
                        return;
                    }
                    const existing = (await this.store.listPublicationsByWork(this.config.tenantId, work.workId)).filter(p => this.host.isNativeDestination(p.destination));
                    if (publicationIdentityHash(existing) !== release.publicationFingerprints[work.workId])
                        throw new ContentPreparationError('review_stale', 'The reviewed native Publication changed.');
                    if (existing.length > 1)
                        throw new ContentPreparationError('publication_ambiguous', 'Choose the native Publication copy from Work management.');
                    const retainedPlacements = { ...contentPublicationBinding<M['file']>(existing[0])?.placements };
                    const previousManifest = contentPublicationBinding<M['file']>(existing[0])?.manifest;
                    if (previousManifest)
                        for (const collection of await this.store.listCreatorCollections(this.config.tenantId, creatorId)) {
                            const membership = (await this.store.listCollectionWorks(this.config.tenantId, collection.collectionId)).find(m => m.workId === work.workId && m.representationId === previousManifest.id);
                            if (membership)
                                retainedPlacements[collection.collectionId] = previousManifest;
                        }
                    const now = new Date().toISOString(), publication = this.host.nativeWorkPublication(work, existing[0], { published: true, visibility: draft.settings.visibility ?? 'public', metadata: { title: existing[0]?.metadataOverrides?.title ?? work.title, description: output.kind === 'full' ? existing[0]?.metadataOverrides?.description ?? work.description : undefined, tags: existing[0]?.metadataOverrides?.tags ?? work.tags }, providerData: { ...existing[0]?.providerData, contentRepresentation: { manifest: output, placements: { ...retainedPlacements, ...(release.fullOutputs?.find(f => f.subject.id === output.subject.id) ? Object.fromEntries(draft.units.filter(u => u.kind === 'collection' && !draft.previews.some(p => p.previewCollectionId === u.id)).map(u => [u.id, release.fullOutputs!.find(f => f.subject.id === output.subject.id)!])) : {}) } }, imageRenditions: [] }, now });
                    await atomic.savePublication(publication);
                    const discovery = await this.store.getWorkDiscoveryParticipation(this.config.tenantId, work.workId);
                    if (draft.settings.discovery || discovery?.state === 'opted_in')
                        await this.store.upsertWorkDiscoveryParticipation({ workId: work.workId, tenantId: this.config.tenantId, creatorId, state: draft.settings.discovery ? 'opted_in' : 'none', optedInAt: draft.settings.discovery ? discovery?.optedInAt ?? now : undefined, withdrawnAt: draft.settings.discovery ? undefined : now, updatedAt: now });
                    const intent = (await this.store.listPublicationIntentsByWork(this.config.tenantId, work.workId)).find(i => this.host.isNativeDestination(i.destination) && !i.integrationAccountId);
                    await this.store.upsertPublicationIntent({ publicationIntentId: intent?.publicationIntentId ?? randomUUID(), publicationId: publication.publicationId, tenantId: this.config.tenantId, creatorId, workId: work.workId, destination: this.host.nativeWorkDestination(), enabled: true, desiredStatus: 'live', createdAt: intent?.createdAt ?? now, updatedAt: now });
                    release.completed.push(output.id);
                    await atomic.put(this.key(creatorId), id, release);
                });
            }
            if (initial.connected?.length) {
                const connected = await this.host.contentPublishing()!.dispatch(creatorId, id, initial.actorId, initial.connected, async () => { const current = await atomic.get(this.key(creatorId), id) as PreparedRelease<M>; if (current.state !== 'accepted')
                    throw new ContentPreparationError('release_cancelled', 'Remaining connected publication work was cancelled.'); });
                if (!connected.ready)
                    return;
            }
            await this.finish(creatorId, id);
        }
        catch (error) {
            await atomic.run(async () => {
                const release = await atomic.get(this.key(creatorId), id);
                if (release?.state === 'accepted')
                    await atomic.put(this.key(creatorId), id, { ...release, state: 'needs_review', error: error instanceof Error ? error.message : 'Release needs review.' });
            });
        }
    }
    private async finishAnnouncementDraft(creatorId: string, release: PreparedRelease<M>) {
        if (!await this.actorAllowed(creatorId, release))
            throw new ContentPreparationError('access_denied', 'Announcement preparation access changed.', 403);
        const draft = await this.workflows.get(creatorId, release.draftId);
        for (const ref of draft.units)
            await this.workflows.target(creatorId, ref);
        if (publicationIdentityHash(await this.store.getCreatorById(creatorId)) !== release.creatorFingerprint || release.blockRulesRevision !== (await this.host.announcementRules()).revision)
            throw new ContentPreparationError('review_stale', 'Creator settings or announcement rules changed.');
        await this.checkAnnouncementBindings(creatorId, release);
        await this.checkPreparedAnnouncementMedia(creatorId, release);
        await this.atomic().run(async () => { const current = await this.atomic().get(this.key(creatorId), release.id) as PreparedRelease<M>; if (current.state !== 'accepted')
            return; await this.announcementDraft(creatorId, draft.id, draft.revision, release.actorId, release.id); const now = new Date().toISOString(); await this.atomic().put(this.key(creatorId), release.id, { ...current, state: 'completed', completedAt: now }); await this.atomic().put(this.workflows.kind(creatorId), draft.id, { ...draft, state: 'completed', review: undefined, updatedAt: now }); });
    }
    /** Each gallery commits independently with its receipt; one announcement activates only after all results. */
    private async finishCollection(creatorId: string, id: string, collectionId: string, preview: boolean) {
        const atomic = this.atomic();
        await atomic.run(async () => {
            const release = await atomic.get(this.key(creatorId), id) as PreparedRelease<M>;
            if (release.state !== 'accepted' || release.collectionsCompleted?.includes(collectionId))
                return;
            if (!await this.actorAllowed(creatorId, release))
                throw new ContentPreparationError('access_denied', 'Publishing access changed.', 403);
            await this.checkOffer(creatorId, release);
            const draft = await this.workflows.get(creatorId, release.draftId), ref = draft.units.find(u => u.kind === 'collection' && u.id === collectionId);
            if (!ref)
                throw new ContentPreparationError('revision_conflict', 'The reviewed gallery is unavailable.');
            const collection = await this.workflows.target(creatorId, ref) as M['collection'], state = await this.store.getCollectionOrganization(this.config.tenantId, creatorId), destination = this.host.nativeCollectionDestination(), previous = state.publications.find(p => p.collectionId === collectionId && p.destination === destination), now = new Date().toISOString();
            if (!preview && draft.settings.access === 'premium')
                await this.host.validateNativeCollectionOffer(creatorId, 'premium', draft.settings.offerId);
            const members = preview ? draft.previews.flatMap(p => (p.representationIds ?? []).map(representationId => ({ collectionId, workId: p.target.id, representationId, position: 0, addedAt: now }))).map((member, position) => ({ ...member, position })) : await this.host.resolvedCollectionMembers(this.config.tenantId, collection);
            if (preview) {
                for (const member of members) {
                    const publication = (await this.store.listPublicationsByWork(this.config.tenantId, member.workId)).find(p => this.host.isNativeDestination(p.destination));
                    if (contentPublicationBinding<M['file']>(publication)?.manifest.id !== member.representationId)
                        throw new ContentPreparationError('preview_pending', 'An updated preview needs its reviewed Publication before gallery placement.');
                }
                await this.store.replaceCollectionWorks(this.config.tenantId, collectionId, members);
            }
            const memberIds = members.map(m => m.workId), releasedIds = preview ? memberIds : [...new Set([...(previous?.releasedWorkIds ?? []), ...release.outputs.map(o => o.subject.id)])].filter(workId => memberIds.includes(workId));
            const publication = await this.host.evaluateNativeCollectionPublication(creatorId, { collectionId, destination, revision: (previous?.revision ?? 0) + 1, release: 'published', audience: preview || draft.settings.access === 'free' ? 'public' : 'premium', offerId: preview ? undefined : draft.settings.offerId, scope: 'selected', selectedWorkIds: memberIds, releasedWorkIds: releasedIds, includedWorkIds: [], excluded: [], updatedAt: now, publishedAt: previous?.publishedAt ?? now }, this.allowed);
            if (publication.excluded.length)
                throw new ContentPreparationError('publication_pending', 'Required gallery results are unavailable.');
            state.publications = [...state.publications.filter(p => p.collectionId !== collectionId || p.destination !== destination), publication];
            state.revision++;
            const next = { ...collection, revision: (collection.revision ?? 0) + 1, status: 'published' as const, visibility: preview ? 'public' as const : draft.settings.visibility ?? 'public', updatedAt: now };
            await this.store.commitCollectionOrganization({ tenantId: this.config.tenantId, creatorId, expectedRevision: state.revision - 1, state, collection: next, expectedCollectionRevision: collection.revision ?? 0 });
            draft.units = draft.units.map(u => u.id === collectionId ? { ...u, revision: next.revision } : u);
            if (draft.entry.target?.id === collectionId)
                draft.entry.target = { ...draft.entry.target, revision: next.revision };
            release.collectionsCompleted = [...(release.collectionsCompleted ?? []), collectionId];
            await atomic.put(this.workflows.kind(creatorId), draft.id, draft);
            await atomic.put(this.key(creatorId), id, release);
        });
    }
    private async finish(creatorId: string, id: string) {
        const atomic = this.atomic(), initial = await atomic.get(this.key(creatorId), id) as PreparedRelease<M>;
        if (initial.state !== 'accepted' || initial.completed.length !== initial.outputs.length)
            return;
        const initialDraft = await this.workflows.get(creatorId, initial.draftId), previewId = initialDraft.previews.find(p => p.previewCollectionId)?.previewCollectionId;
        for (const ref of initialDraft.units.filter(u => u.kind === 'collection' && initialDraft.settings.publishDestinations.some(d => this.host.isNativeDestination(d.destination))))
            await this.finishCollection(creatorId, id, ref.id, ref.id === previewId);
        const release = await atomic.get(this.key(creatorId), id) as PreparedRelease<M>;
        if (release.state !== 'accepted')
            return;
        const draft = await this.workflows.get(creatorId, release.draftId), collectionRef = draft.units.find(u => u.kind === 'collection' && (!previewId || u.id === previewId)), releasedCollection = collectionRef ? await this.workflows.target(creatorId, collectionRef) as M['collection'] : undefined;
        let announcementCommit: M['orchestrationCommit']|undefined;
        // One release-level announcement. Legacy per-file send hooks are never invoked by these commits.
        if (release.outputs.length && draft.settings.announce.mode !== 'off' && draft.settings.announce.destinationIds.length) {
            const plans = this.host.announcementPlans(), subject = { kind: release.outputs.length === 1 ? 'work' as const : 'works' as const, ids: release.outputs.map(o => o.subject.id) }, scopeId = `work-release:${publicationIdentityHash(subject).slice(0, 40)}`;
            const now = new Date().toISOString(), descriptor: M['collection'] = this.host.collection({ collectionId: scopeId, tenantId: this.config.tenantId, creatorId, title: draft.title, slug: scopeId, slugHistory: [scopeId], type: 'collection', status: 'draft', visibility: 'private', revision: draft.revision, createdAt: now, updatedAt: now });
            const native = this.host.nativeWorkAnnouncementBinding(creatorId, subject.ids[0]), key = announcementDestinationKey(releasedCollection ? this.host.nativeCollectionAnnouncementBinding(creatorId, releasedCollection.collectionId) : native), requirements: CollectionReleaseRequirement[] = [];
            for (const output of draft.settings.publishDestinations.some(d => this.host.isNativeDestination(d.destination)) ? release.outputs : []) {
                const pub = (await this.store.listPublicationsByWork(this.config.tenantId, output.subject.id)).find(p => this.host.isNativeDestination(p.destination))!;
                requirements.push({ resultId: publicationIdentityHash([pub.publicationId, output.id]), publicationId: pub.publicationId, workId: output.subject.id, target: native, contentRevision: String(output.subject.revision), collectionRevision: String(draft.revision), placementId: output.subject.id, audience: pub.visibility, required: true, kind: 'native', representationId: output.id });
            }
            if (releasedCollection && draft.settings.publishDestinations.some(d => this.host.isNativeDestination(d.destination))) {
                const organization = await this.store.getCollectionOrganization(this.config.tenantId, creatorId);
                requirements.splice(0, requirements.length, ...await this.host.captureCollectionReleaseRequirements({ creatorId, actorId: release.actorId, collection: releasedCollection, organization, workIds: release.outputs.map(o => o.subject.id) }));
            }
            requirements.push(...(release.connected ?? []).flatMap(c => c.requirements));
            const trigger = structuredClone(release.announcementTrigger);
            if (!trigger)
                throw new ContentPreparationError('review_stale', 'This release needs a fresh exact announcement review.');
            const stored = await this.store.getAnnouncementOrchestration<{
                reference: ReleaseValueReference;
            }>(plans.scope(creatorId), 'baseline', scopeId);
            const value: CollectionReleaseBaseline = stored ? await this.host.readOrchestrationValue(plans.scope(creatorId), stored.value.reference) : { ...plans.scope(creatorId), collectionId: scopeId, schemaVersion: 1, revision: 0, initialized: true, releasedWorkIds: release.previousExposure?.map(p => p.workId) ?? [], evidence: release.previousExposure?.map(p => ({ workId: p.workId, contentRevision: p.revision, destinationKey: key, evidenceReference: `historical:${p.publicationId}` })) ?? [], initialReleaseId: release.previousExposure?.length ? 'historical-baseline' : undefined, reservations: [] };
            const organization = await this.store.getCollectionOrganization(this.config.tenantId, creatorId);
            announcementCommit = await plans.prepareRelease({ creatorId, actorId: release.actorId, collection: releasedCollection ?? descriptor, previousCollection: releasedCollection ?? descriptor, organization, previousOrganization: organization, operationKey: id, exactRequirements: requirements, memberWorkIds: draft.units.filter(u => u.kind === 'work').map(u => u.id), preparedMedia: release.announcementMedia, ...(releasedCollection ? { subjectBaseline: release.collectionBaselines?.[releasedCollection.collectionId] } : { subject, subjectBaseline: { stored, value } }), workIds: subject.ids, overrides: { initial: trigger, additions: { ...trigger } } });
            release.announcementReleaseId = publicationIdentityHash([plans.scope(creatorId), releasedCollection?.collectionId ?? scopeId, id]);
        }
        if(this.host.announcementActivation&&(announcementCommit||release.announcementActivation||release.announcementMediaFiles?.length)){
            await this.finishAnnouncementActivation(creatorId,id,release,draft,announcementCommit);
            await this.runtime?.tick();return;
        }
        // Publish only the reviewed immutable announcement copies, after explicit release approval.
        if (release.announcementMediaFiles?.length) {
            await this.checkPreparedAnnouncementMedia(creatorId, release);
            await this.host.activateAnnouncementMedia(creatorId, release.announcementMediaFiles);
        }
        // This conditional commit alone activates announcement ownership.
        await atomic.run(async () => {
            const current = await atomic.get(this.key(creatorId), id) as PreparedRelease<M>;
            if (current.state !== 'accepted')
                return;
            const currentDraft = await this.workflows.get(creatorId, release.draftId);
            if (publicationIdentityHash(currentDraft) !== publicationIdentityHash(draft) || publicationIdentityHash(await this.store.getCreatorById(creatorId)) !== release.creatorFingerprint || release.blockRulesRevision !== (await this.host.announcementRules()).revision || !await this.actorAllowed(creatorId, release))
                throw new ContentPreparationError('review_stale', 'Release settings or publishing access changed before completion.');
            await this.checkAnnouncementBindings(creatorId, release);
            await this.checkOffer(creatorId, release);
            for (const ref of draft.units.filter(u => u.kind === 'collection'))
                await this.workflows.target(creatorId, ref);
            if (announcementCommit && !await this.store.commitAnnouncementOrchestration(announcementCommit))
                throw new ContentPreparationError('revision_conflict', 'Announcement ownership changed. Review the release.');
            if (draft.settings.announce.mode === 'draft' && !draft.settings.announce.destinationIds.length)
                await this.announcementDraft(creatorId, draft.id, draft.revision, release.actorId, id);
            release.state = 'completed';
            release.completedAt = new Date().toISOString();
            draft.state = 'completed';
            draft.updatedAt = release.completedAt;
            delete draft.review;
            await atomic.put(this.key(creatorId), id, release);
            await atomic.put(this.workflows.kind(creatorId), draft.id, draft);
        });
        await this.runtime?.tick();
    }
    async resumeAnnouncementActivation(creatorId:string,id:string){
        const atomic=this.atomic();
        await atomic.run(async()=>{const release=await atomic.get(this.key(creatorId),id) as PreparedRelease<M>|undefined;
            if(!release||release.announcementActivationProtocol!==1||(release.announcementActivation?release.announcementActivation.releaseFingerprint!==release.fingerprint:Boolean(release.announcementReleaseId))||!['accepted','needs_review'].includes(release.state))throw new ContentPreparationError('announcement_reconciliation_required','This release needs its original activation-phase provenance.',409);
            if(!await this.actorAllowed(creatorId,release))throw new ContentPreparationError('access_denied','Current release actor access is required.',403);
            const draft=await this.workflows.get(creatorId,release.draftId);if(draft.state!=='accepted')throw new ContentPreparationError('review_stale','The original accepted preparation changed.');
            await atomic.put(this.key(creatorId),id,{...release,state:'accepted',error:undefined});
        });
        await this.run(creatorId,id);return this.status(creatorId,id);
    }
    private async finishAnnouncementActivation(creatorId:string,id:string,initial:PreparedRelease<M>,draft:ContentWorkflowDraft,commit:M['orchestrationCommit']|undefined){
        const port=this.host.announcementActivation!,atomic=this.atomic();
        if(initial.announcementActivationProtocol!==1)throw new ContentPreparationError('announcement_reconciliation_required','This older accepted release requires its actual announcement activation migration.',409);
        const assertCurrent=async()=>{const release=await atomic.get(this.key(creatorId),id) as PreparedRelease<M>|undefined,currentDraft=await this.workflows.get(creatorId,initial.draftId);
            if(!release||release.state!=='accepted'||release.fingerprint!==initial.fingerprint||publicationIdentityHash(currentDraft)!==publicationIdentityHash(draft)||publicationIdentityHash(await this.store.getCreatorById(creatorId))!==initial.creatorFingerprint||initial.blockRulesRevision!==(await this.host.announcementRules()).revision||!await this.actorAllowed(creatorId,release))throw new ContentPreparationError('review_stale','The exact original release or current authority changed before announcement activation.');
            await this.checkAnnouncementBindings(creatorId,release);await this.checkOffer(creatorId,release);return release;
        };
        if(!initial.announcementActivation){
            if(!commit)throw new ContentPreparationError('announcement_reconciliation_required','Actual announcement plan ownership is required before public activation.',409);
            const staged=port.stageOwnership(commit,{creatorId,releaseId:id,releaseFingerprint:initial.fingerprint}),ownership=staged.ownership;
            if(ownership.schemaVersion!==1||!/^[a-f0-9]{64}$/.test(ownership.fingerprint)||!ownership.references.length||ownership.references.some(row=>!row.id||!row.kind||!Number.isSafeInteger(row.revision)||row.revision<1||!/^[a-f0-9]{64}$/.test(row.fingerprint)))throw new ContentPreparationError('unsupported_operation','The host must identify the actual complete accepted announcement ownership.',503);
            await atomic.run(async()=>{const release=await assertCurrent();if(release.announcementActivation)return;
                await atomic.put(this.key(creatorId),id,{...release,announcementReleaseId:initial.announcementReleaseId,announcementActivation:{schemaVersion:1,phase:'ownership_accepted',releaseFingerprint:initial.fingerprint,ownership}});
                if(!await this.store.commitAnnouncementOrchestration(staged.commit))throw new ContentPreparationError('revision_conflict','Original announcement ownership changed.');
            });
        }
        const prepare=async()=>{const release=await atomic.get(this.key(creatorId),id) as PreparedRelease<M>,phase=release.announcementActivation;
            if(!phase||phase.schemaVersion!==1||phase.releaseFingerprint!==initial.fingerprint)throw new ContentPreparationError('announcement_reconciliation_required','The actual accepted activation phase is missing.',409);
            const prepared=await port.prepare({creatorId,releaseId:id,draftId:release.draftId,releaseFingerprint:release.fingerprint,announcementReleaseId:release.announcementReleaseId,files:release.announcementMediaFiles??[],ownership:phase.ownership});
            const keys=(release.announcementMediaFiles??[]).map(file=>file.mediaKey),active=prepared.activeMediaKeys,deferred=prepared.deferredMediaKeys,all=[...active,...deferred];
            if(typeof prepared.enlist!=='function'||typeof prepared.activate!=='function'||!Array.isArray(prepared.resources)||(active.length>0&&!prepared.resources.length)||prepared.resources.some(resource=>!['announcement','collection'].includes(resource.kind)||!resource.id||!resource.revision||!/^[a-f0-9]{64}$/.test(resource.contentFingerprint)||!resource.destination)||new Set(keys).size!==keys.length||new Set(all).size!==all.length||all.length!==keys.length||all.some(key=>!keys.includes(key)))throw new ContentPreparationError('unsupported_operation','Actual materialized resources and every owned active/deferred media key are required.',503);
            if(phase.resources&&publicationIdentityHash([phase.resources,phase.activeMediaKeys,phase.deferredMediaKeys])!==publicationIdentityHash([prepared.resources,active,deferred]))throw new ContentPreparationError('review_stale','The materialized announcement resource or exact selected media changed.');return prepared;
        };
        let prepared=await prepare();
        await atomic.run(async()=>{const release=await assertCurrent(),phase=release.announcementActivation!;await prepared.enlist();
            if(!phase.resources)await atomic.put(this.key(creatorId),id,{...release,announcementActivation:{...phase,phase:'admission_accepted',resources:structuredClone(prepared.resources),activeMediaKeys:[...prepared.activeMediaKeys],deferredMediaKeys:[...prepared.deferredMediaKeys]}});
        });
        // Actual alias visibility is accepted under its own same-resource/current
        // admission CAS. A lost reply is recovered by that original media journal.
        await prepared.activate();
        // Visibility acceptance changes actual repository revisions. Capture fresh
        // guards again; the immutable resource/media identities must remain EXACT.
        prepared=await prepare();
        await atomic.run(async()=>{const release=await assertCurrent(),phase=release.announcementActivation!;await prepared.enlist();
            const now=new Date().toISOString();await atomic.put(this.key(creatorId),id,{...release,announcementActivation:{...phase,phase:'media_activated'},state:'completed',completedAt:now,error:undefined});
            await atomic.put(this.workflows.kind(creatorId),draft.id,{...draft,state:'completed',review:undefined,updatedAt:now});
        });
    }
    /** One due release or pending cancellation per worker poll. Discovery is
     * read-only; run/cancel retain the existing durable claims and live guards. */
    async runNextJob() {
        const candidates: Array<{key:string;creatorId:string;id:string;cancel:boolean}> = [];
        for (const creator of await this.store.listCreators()) {
            if (creator.status !== 'active' || creator.deletion) continue;
            const rows=await this.atomic().list(this.key(creator.creatorId)) as PreparedRelease<M>[];
            for (const row of rows) {
                if (row.creatorId !== creator.creatorId) continue;
                const cancel=row.state==='cancelled' && row.cancellationPending===true;
                if (cancel || row.state==='accepted' && (!row.scheduledAt || !Number.isFinite(Date.parse(row.scheduledAt)) || Date.parse(row.scheduledAt)<=Date.now()))
                    candidates.push({key:JSON.stringify([creator.creatorId,row.id]),creatorId:creator.creatorId,id:row.id,cancel});
            }
        }
        candidates.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
        const next=candidates.find(candidate=>!this.workerCursor || candidate.key>this.workerCursor)??candidates[0];
        if (!next) return;
        this.workerCursor=next.key;
        if (next.cancel) await this.cancelConnected(next.creatorId,next.id);
        else await this.run(next.creatorId,next.id);
        const current=await this.atomic().get(this.key(next.creatorId),next.id) as PreparedRelease<M> | undefined;
        return current?{kind:next.cancel?'content-cancellation' as const:'content-release' as const,creatorId:next.creatorId,id:next.id,state:current.state}:undefined;
    }
    async tick() {
        await this.workflows.recover();
        for (const creator of await this.store.listCreators()) {
            if (creator.status !== 'active' || creator.deletion)
                continue;
            const rows = this.store.publicationAtomic ? await this.atomic().list(this.key(creator.creatorId)) as PreparedRelease<M>[] : undefined;
            for (const row of rows ?? [])
                if (row.state === 'cancelled' && row.cancellationPending)
                    await this.cancelConnected(creator.creatorId, row.id);
                else if (row.state === 'accepted')
                    await this.run(creator.creatorId, row.id);
        }
    }
}
