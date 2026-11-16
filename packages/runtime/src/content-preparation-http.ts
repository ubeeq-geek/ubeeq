import {AnnouncementOrchestrationError,WebsiteError,PublicationImageError,ContentWorkflowError,inferContentArrangement,suggestContentPairs} from '@ubeeq/core';
import {ContentPreparationError,type ContentWorkflowService} from './content-preparations.js';
import type {PreparationSourceFile} from './content-preparation-host.js';

/** Parsed transport input remains untrusted; the workflow domain validates it. */
export interface ContentPreparationHttpRequest {query:Record<string,unknown>;body:any;params:Record<string,string>;}
export interface ContentPreparationHttpResponse {
 readonly headersSent:boolean;
 setHeader(name:string,value:string):unknown;
 status(code:number):this;
 json(value:unknown):unknown;
 type(value:string):this;
 attachment(filename?:string):this;
 send(value:Uint8Array):unknown;
}
export interface ContentPreparationRouteRegistrar<R,V> {
 register(method:'get'|'post'|'patch',path:string,handler:(request:R,response:V)=>Promise<unknown>):void;
}
export type ContentPreparationHttpService=Pick<ContentWorkflowService<any,any>,
 'list'|'collectionChoices'|'standaloneImages'|'exportArchive'|'restoreArchive'|'begin'|'get'|'contents'|'revise'|'addObject'|'stageUpload'|'completeUpload'|'review'|'saveDraft'|'refreshReferences'|'resume'|'applyChanges'|'cancel'|'presets'|'presetVersions'|'revisePreset'|'capturePreset'|'applyPreset'>;
export interface ContentPreparationReleaseDriver {
 reviewMedia(creator:string,id:string,review:string,representation:string,component:string):Promise<{file:{mimeType:string;filename?:string};bytes:Uint8Array}>;
 prepareAnnouncementDraft(creator:string,id:string,revision:number,actor:string):Promise<unknown>;
 announcementDraft(creator:string,id:string,revision:number,actor:string):Promise<unknown>;
 preparePreviews(creator:string,id:string,revision:number,recipes:any):Promise<unknown>;
 prepare(creator:string,id:string,revision:number,action:any,recipes:any,actor:string):Promise<unknown>;
 accept(creator:string,id:string,revision:number,operation:string,review:string,fingerprint:string):Promise<unknown>;
 cancel(creator:string,id:string,revision:number):Promise<unknown>;
 status(creator:string,id:string):Promise<unknown>;
 resumeAnnouncementActivation?(creator:string,id:string):Promise<unknown>;
}
export interface ContentPreparationHttpBindings<R,V,S extends ContentPreparationHttpService> {
 basePath?:string;
 /** Must resolve the already verified session; never a caller-supplied identity hint. */
 actorId(request:R):string|undefined;
 access(request:R,response:V,creator:string):Promise<boolean>;
 createService(request:R,response:V,purpose:'operation'|'review-media'):S;
 createRelease(service:S):ContentPreparationReleaseDriver;
 enabled():boolean;
 durableDrafts():boolean;
 offerings(creator:string,request:R):Promise<unknown[]>;
 announcementDestinations(creator:string,request:R):Promise<unknown[]>;
 destinations(creator:string,actor:string):Promise<unknown[]>;
 managementUrl(creator:string):string;
 prepareUpload?(request:R,creator:string,fileId:string):Promise<PreparationSourceFile>;
 verifyUploadStorage?(request:R,creator:string):Promise<void>;
 uploadDescriptor?(file:PreparationSourceFile,request:R):Promise<unknown>;
 canManageCollections?(request:R,creator:string):Promise<boolean>;
 mapError?(error:unknown):{status:number;body:unknown}|undefined;
}

/** Complete retained HTTP contract; hosts supply their real authenticated authority
 * and feature drivers. Registration never creates substitute stores or providers. */
export function registerContentPreparationRoutes<R extends ContentPreparationHttpRequest,V extends ContentPreparationHttpResponse,S extends ContentPreparationHttpService>(registrar:ContentPreparationRouteRegistrar<R,V>,options:ContentPreparationHttpBindings<R,V,S>):void {
 for(const name of ['actorId','access','createService','createRelease','enabled','durableDrafts','offerings','announcementDestinations','destinations','managementUrl'] as const)
  if(typeof options?.[name]!=='function')throw Error('Content preparation HTTP requires its authenticated host and actual capabilities.');
 if(typeof registrar?.register!=='function')throw Error('Content preparation HTTP requires its actual transport.');
 const actorId=(request:R):string=>{const value=options.actorId(request);if(typeof value!=='string'||!value)throw new ContentPreparationError('authentication_required','An authenticated creator session is required.',401);return value;};

    const base = options.basePath ?? '/api/studio/content';
    const route = (method: 'get' | 'post' | 'patch', path: string, operation: (req: R, service: S, creatorId: string) => Promise<unknown>) => {
        registrar.register(method, base + path, async (req, res) => {
            res.setHeader('Cache-Control', 'private, no-store');
            const actor = options.actorId(req);
            if (typeof actor !== 'string' || !actor) return res.status(401).json({code:'authentication_required',message:'An authenticated creator session is required.'});
            const creatorId = typeof req.query.creatorId === 'string' ? req.query.creatorId : typeof req.body?.creatorId === 'string' ? req.body.creatorId : '';
            if (await options.access(req, res, creatorId) !== true)
                return res.headersSent ? undefined : res.status(403).json({code:'access_denied',message:'Content preparation access denied.'});
            if (options.enabled() !== true && method !== 'get' && !['/workflows/:id/save', '/workflows/:id/resume', '/releases/:id/cancel','/releases/:id/resume'].includes(path))
                return res.status(503).json({ code: 'workflow_disabled', message: 'New content operations are temporarily unavailable. Saved preparations and accepted releases are retained.' });
            const service = options.createService(req, res, 'operation');
            try {
                const result = await operation(req, service, creatorId);
                if (!res.headersSent)
                    return res.json(result);
            }
            catch (error) {
                if (res.headersSent)
                    return;
                if (error instanceof AnnouncementOrchestrationError || error instanceof WebsiteError || error instanceof PublicationImageError)
                    return res.status(409).json({ code: error.code, message: error.message });
                const hostError = options.mapError?.(error);
                if (hostError) return res.status(hostError.status).json(hostError.body);
                if (error instanceof ContentPreparationError)
                    return res.status(error.status).json({ code: error.code, message: error.message });

                if (error instanceof ContentWorkflowError)
                    return res.status(error.code === 'revision_conflict' ? 409 : 400).json({ code: error.code, message: error.message });
                throw error;
            }
        });
    };
    registrar.register("get", `${base}/workflows/:id/reviews/:reviewId/images/:representationId/:componentId`, async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
            const actor = options.actorId(req);
            if (typeof actor !== 'string' || !actor) return res.status(401).json({code:'authentication_required',message:'An authenticated creator session is required.'});
        const creatorId = typeof req.query.creatorId === 'string' ? req.query.creatorId : '';
        if (await options.access(req, res, creatorId) !== true)
            return res.headersSent ? undefined : res.status(403).json({code:'access_denied',message:'Content preparation access denied.'});
        try {
            const service = options.createService(req, res, 'review-media');
            const image = await options.createRelease(service).reviewMedia(creatorId, req.params.id, req.params.reviewId, req.params.representationId, req.params.componentId);
            if (!image.file.mimeType.startsWith('image/'))
                res.attachment('filename' in image.file ? image.file.filename : 'reviewed-attachment');
            res.type(image.file.mimeType).setHeader('X-Content-Type-Options', 'nosniff');
            return res.send(image.bytes);
        }
        catch (error) {
            if (res.headersSent)
                return;
            if (error instanceof ContentPreparationError)
                return res.status(error.status).json({ code: error.code, message: error.message });
            return res.status(404).json({ message: 'The reviewed image is unavailable. Prepare a fresh review.' });
        }
    });
    const intakeCapabilities = async (req: R, creatorId: string) => ({
        durableDrafts: options.durableDrafts() === true,
        arrangements: !options.canManageCollections || await options.canManageCollections(req, creatorId) ? ['work', 'collection', 'separate_works'] : ['work', 'separate_works']
    });
    route('get', '/intake-capabilities', (req, _service, creatorId) => intakeCapabilities(req, creatorId));
    route('get', '/capabilities', async (req, _service, creatorId) => ({
        ...await intakeCapabilities(req, creatorId),
        intake: { images: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'], writing: ['article', 'literature'], files: true, existingWorks: true },
        previews: { uploaded: true, image: true, textRange: true, timeRange: { available: false, code: 'unsupported_operation', alternative: 'Upload a prepared clip or sample; source references remain available.' } },
        offerings: await options.offerings(creatorId,req),
        announcementDestinations: await options.announcementDestinations(creatorId,req),
        destinations: await options.destinations(creatorId, actorId(req)),
        managementUrl: options.managementUrl(creatorId)
    }));
    route('get', '/workflows', async (_req, service, creatorId) => ({ items: await service.list(creatorId) }));
    route('get', '/collections', (_req, service, creatorId) => service.collectionChoices(creatorId));
    route('get', '/standalone-images', (_req, service, creatorId) => service.standaloneImages(creatorId));
    route('get', '/export', (_req, service, creatorId) => service.exportArchive(creatorId));
    route('post', '/restore', (req, service, creatorId) => service.restoreArchive(creatorId, actorId(req), req.body.restoreId, req.body.archive));
    route('post', '/workflows', (req, service, creatorId) => service.begin(creatorId, actorId(req), req.body.operationId, req.body.entry));
    route('get', '/workflows/:id', async (req, service, creatorId) => {
        const draft = await service.get(creatorId, req.params.id);
        return { draft, inference: inferContentArrangement(draft.entry, draft.objects), pairSuggestions: suggestContentPairs(draft.objects) };
    });
    route('get', '/workflows/:id/contents', (req, service, creatorId) => service.contents(creatorId, req.params.id));
    route('patch', '/workflows/:id', (req, service, creatorId) => service.revise(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId, req.body.patch));
    route('post', '/workflows/:id/objects', (req, service, creatorId) => service.addObject(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId, req.body.object));
    route('post', '/workflows/:id/uploads', async (req, service, creatorId) => {
        if (!options.prepareUpload || !options.uploadDescriptor)
            throw new ContentPreparationError('unsupported_operation', 'Staged uploads are unavailable.', 503);
        await options.verifyUploadStorage?.(req,creatorId);
        const staged = await service.stageUpload(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId, req.body.upload, fileId => options.prepareUpload!(req, creatorId, fileId));
        return { ...staged, upload: await options.uploadDescriptor(staged.file,req) };
    });
    route('post', '/workflows/:id/objects/:objectId/complete', (req, service, creatorId) => service.completeUpload(creatorId, req.params.id, req.params.objectId, req.body.expectedRevision, req.body.operationId));
    route('post', '/workflows/:id/announcement-draft/review', (req, service, creatorId) => options.createRelease(service).prepareAnnouncementDraft(creatorId, req.params.id, req.body.expectedRevision, actorId(req)));
    route('post', '/workflows/:id/announcement-draft', (req, service, creatorId) => options.createRelease(service).announcementDraft(creatorId, req.params.id, req.body.expectedRevision, actorId(req)));
    route('post', '/workflows/:id/previews', (req, service, creatorId) => options.createRelease(service).preparePreviews(creatorId, req.params.id, req.body.expectedRevision, req.body.recipes));
    route('post', '/workflows/:id/review', (req, service, creatorId) => req.body.action === 'save' ? service.review(creatorId, req.params.id, req.body.expectedRevision, 'save') : options.createRelease(service).prepare(creatorId, req.params.id, req.body.expectedRevision, req.body.action, req.body.recipes, actorId(req)));
    route('post', '/workflows/:id/release', (req, service, creatorId) => options.createRelease(service).accept(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId, req.body.reviewId, req.body.fingerprint));
    route('post', '/releases/:id/cancel', (req, service, creatorId) => options.createRelease(service).cancel(creatorId, req.params.id, req.body.expectedRevision));
    route('post','/releases/:id/resume',(req,service,creatorId)=>{const release=options.createRelease(service);if(!release.resumeAnnouncementActivation)throw new ContentPreparationError('unsupported_operation','Accepted announcement activation recovery is unavailable.',503);return release.resumeAnnouncementActivation(creatorId,req.params.id);});
    route('get', '/releases/:id', (req, service, creatorId) => options.createRelease(service).status(creatorId, req.params.id));
    route('post', '/workflows/:id/save', (req, service, creatorId) => service.saveDraft(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId));
    route('post', '/workflows/:id/refresh-references', (req, service, creatorId) => service.refreshReferences(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId));
    route('post', '/workflows/:id/resume', (req, service, creatorId) => service.resume(creatorId, req.params.id));
    route('post', '/workflows/:id/apply-changes', (req, service, creatorId) => service.applyChanges(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId, req.body.reviewId, req.body.fingerprint));
    route('post', '/workflows/:id/cancel', (req, service, creatorId) => service.cancel(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId));
    route('get', '/presets', async (_req, service, creatorId) => ({ items: await service.presets(creatorId) }));
    route('get', '/presets/:id/versions', async (req, service, creatorId) => ({ items: await service.presetVersions(creatorId, req.params.id) }));
    route('patch', '/presets/:id', (req, service, creatorId) => service.revisePreset(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId, req.body.patch));
    route('post', '/workflows/:id/preset', (req, service, creatorId) => service.capturePreset(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId, req.body.preset));
    route('post', '/workflows/:id/apply-preset', (req, service, creatorId) => service.applyPreset(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId, req.body.presetId, req.body.expectedPresetRevision));
    route('post', '/workflows/:id/apply-reviewed-preset', (req, service, creatorId) => {
        if (req.body.expectedPresetRevision === undefined)
            throw new ContentPreparationError('invalid_input', 'Choose a valid reviewed preset version.', 400);
        return service.applyPreset(creatorId, req.params.id, req.body.expectedRevision, req.body.operationId, req.body.presetId, req.body.expectedPresetRevision);
    });

}
