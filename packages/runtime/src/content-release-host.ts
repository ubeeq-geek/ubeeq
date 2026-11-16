import type {
 AnnouncementDestinationBinding, AnnouncementMediaSelection, CollectionAnnouncementPreferencePatch,
 CollectionReleaseBaseline, CollectionReleaseRequirement, ContentPreviewRecipe, ContentReleaseSubject,
 ContentUnitRef, ContentWorkflowDraft, ContentWorkflowReview, NativeCollectionPublication, PublicationVisibility
} from '@ubeeq/core';
import type {RetainedContentAtomic} from '@ubeeq/persistence';
import type {PreparationAsset,PreparationCollection,PreparationCollectionMember,PreparationSourceFile,PreparationWork} from './content-preparation-host.js';
import type {ContentRepresentationFile,PreparedContentRepresentation} from './content-representations.js';

export interface ReleaseAnnouncementBlock {
 id:string;type:'paragraph'|'heading'|'quote'|'list'|'divider'|'link'|'image'|'poll'|'video'|'file';
 mediaKey?:string;sourceWorkId?:string;sourceAssetId?:string;alt?:string;caption?:string;
 filename?:string;mime?:string;sizeBytes?:number;
}
export interface ReleaseAnnouncementDocument {version:1;blocks:ReleaseAnnouncementBlock[]}
export interface ReleaseAnnouncementContent {
 document?:ReleaseAnnouncementDocument;destinationDocuments?:Record<string,ReleaseAnnouncementDocument>;
 text:string;primary?:{url:string;label:string};
}
export interface ReleasePrivateAnnouncementMedia {mediaKey:string;privateKey:string;checksum:string;sizeBytes:number;mime:string}
export interface ReleasePublication {
 publicationId:string;destination:string;status:string;visibility:PublicationVisibility;
 sync:{localRevision?:number};metadataOverrides?:{title?:string;description?:string;tags?:string[]};
 providerData?:Record<string,unknown>;
}
export interface ReleaseCollection extends PreparationCollection {
 relationships?:{premiumCollectionIds?:string[];relatedCollectionIds?:string[]};coverImage?:unknown;
}
export interface ReleaseDestination {
 communityDestinationId:string;destinationKey:string;displayName:string;available:boolean;binding:AnnouncementDestinationBinding;
}
export interface ReleaseConnectedCommand {id:string;requirements:CollectionReleaseRequirement[]}
export interface ReleaseOrchestrationScope {tenantId:string;creatorId:string}
export interface ReleaseValueReference {checksum:string;chunks:number}
export type ReleaseOrchestrationKind='preferences'|'release'|'baseline'|'chunk'|'plan'|'due'|'review'|'activity'|'row'|'publication_dispatch';
export interface ReleaseOrchestrationRecord<T> extends ReleaseOrchestrationScope {kind:ReleaseOrchestrationKind;id:string;revision:number;value:T}
export interface ReleaseBaseline {stored:ReleaseOrchestrationRecord<{reference:ReleaseValueReference}>|null;value:CollectionReleaseBaseline}

/** These constraints describe only fields consumed by orchestration. The actual
 * host supplies its complete record types; objects are never projected into a
 * compact Work or copied to an independent repository. */
export interface ContentReleaseModels {
 work:PreparationWork;
 collection:ReleaseCollection;
 publication:ReleasePublication;
 collectionPublication:NativeCollectionPublication;
 organization:{revision:number;publications:NativeCollectionPublication[]};
 file:ContentRepresentationFile;
 announcementContent:ReleaseAnnouncementContent;
 announcementPublication:{announcementPublicationId:string};
 announcementDestination:ReleaseDestination;
 connectedCommand:ReleaseConnectedCommand;
 connectedSummary:unknown;
 orchestrationCommit:unknown;
}
export type ReleaseOutput<M extends ContentReleaseModels>=PreparedContentRepresentation<M['file']>;
export interface ReleaseAnnouncementDraft<M extends ContentReleaseModels> {
 announcementPublicationId:string;tenantId:string;userId:string;creatorIdentityId:string;
 provider:'discord';preset:'recommended';origin:'manual';kind:'ad_hoc';
 subject:{type:'work'|'collection';ids:string[]};status:'draft';idempotencyKey:string;
 payload:{planVersion:1;revision:1;title:string;text:string;document?:ReleaseAnnouncementDocument;
  destinationDocuments?:Record<string,ReleaseAnnouncementDocument>;announcement:M['announcementContent'];
  url?:string;sourceWorkId?:string;sourceCollectionId?:string;format:'recommended';destinationIds:string[]};
 attemptCount:0;createdAt:string;updatedAt:string;
}
export interface ContentReleaseStore<M extends ContentReleaseModels> {
 readonly publicationAtomic?:RetainedContentAtomic<M['publication']>;
 getCreatorById(id:string):Promise<{creatorId:string;status:string;deletion?:unknown;slug:string;name:string}|null>;
 listCreators():Promise<Array<{creatorId:string;status:string;deletion?:unknown}>>;
 getWork(tenantId:string,id:string):Promise<M['work']|null>;
 getCreatorCollection(tenantId:string,id:string):Promise<M['collection']|null>;
 listCreatorCollections(tenantId:string,creatorId:string):Promise<M['collection'][]>;
 listCollectionWorks(tenantId:string,id:string):Promise<PreparationCollectionMember[]>;
 replaceCollectionWorks(tenantId:string,id:string,members:PreparationCollectionMember[]):Promise<void>;
 getCollectionOrganization(tenantId:string,creatorId:string):Promise<M['organization']>;
 commitCollectionOrganization(input:{tenantId:string;creatorId:string;expectedRevision:number;state:M['organization'];collection:M['collection'] & {revision:number};expectedCollectionRevision:number;members?:PreparationCollectionMember[]}):Promise<void>;
 getCanonicalAsset(tenantId:string,id:string):Promise<PreparationAsset|null>;
 getSourceFileById?(id:string):Promise<(PreparationSourceFile & {premium?:boolean})|null>;
 getPlatformRoleAssignment(id:string):Promise<{role:string}|null>;
 listCreatorMembers(id:string):Promise<Array<{userId:string;role:string}>>;
 listPublicationsByWork(tenantId:string,id:string):Promise<M['publication'][]>;
 getWorkDiscoveryParticipation(tenantId:string,id:string):Promise<{state:string;optedInAt?:string}|null>;
 upsertWorkDiscoveryParticipation(input:{tenantId:string;creatorId:string;workId:string;state:'opted_in'|'none';optedInAt?:string;withdrawnAt?:string;updatedAt:string}):Promise<void>;
 listPublicationIntentsByWork(tenantId:string,id:string):Promise<Array<{publicationIntentId:string;destination:string;integrationAccountId?:string;createdAt:string}>>;
 upsertPublicationIntent(input:{publicationIntentId:string;publicationId:string;tenantId:string;creatorId:string;workId:string;destination:M['publication']['destination'];enabled:true;desiredStatus:'live';createdAt:string;updatedAt:string}):Promise<void>;
 getAnnouncementPublication(id:string):Promise<M['announcementPublication']|null>;
 claimAnnouncementPublication(expected:null,next:M['announcementPublication']):Promise<boolean>;
 getAnnouncementOrchestration<T>(scope:ReleaseOrchestrationScope,kind:ReleaseOrchestrationKind,id:string):Promise<ReleaseOrchestrationRecord<T>|null>;
 commitAnnouncementOrchestration(input:M['orchestrationCommit']):Promise<boolean>;
}
export interface ContentReleaseWorkflow<M extends ContentReleaseModels> {
 readonly store:ContentReleaseStore<M>;readonly config:{tenantId:string;appOrigin?:string};
 kind(creatorId:string,suffix?:string):string;
 get(creatorId:string,id:string):Promise<ContentWorkflowDraft>;
 list(creatorId:string):Promise<unknown>;
 target(creatorId:string,ref:ContentUnitRef):Promise<PreparationWork|PreparationCollection>;
 review(creatorId:string,id:string,revision:number,action:ContentWorkflowReview['action']):Promise<{draft:ContentWorkflowDraft;review:ContentWorkflowReview}>;
 recover():Promise<unknown>;
}
export interface ReleaseRepresentations<M extends ContentReleaseModels> {
 full(work:M['work'],protectedOutput?:boolean):Promise<ReleaseOutput<M>>;
 previews(draft:ContentWorkflowDraft,recipes?:Record<string,ContentPreviewRecipe>):Promise<{relationships:ContentWorkflowDraft['previews'];outputs:ReleaseOutput<M>[]} >;
 read(manifest:ReleaseOutput<M>,id:string):Promise<{bytes:Buffer;file:M['file']}>;
}
export interface ReleaseConnectedPublishing<M extends ContentReleaseModels> {
 prepare(draft:ContentWorkflowDraft,outputs:ReleaseOutput<M>[],full:ReleaseOutput<M>[],previews:ReleaseOutput<M>[],actorId:string):Promise<M['connectedCommand'][]>;
 validate(commands:M['connectedCommand'][],actorId:string):Promise<void>;
 dispatch(creatorId:string,releaseId:string,actorId:string,commands:M['connectedCommand'][],guard:()=>Promise<void>):Promise<{ready:boolean}>;
 cancel(releaseId:string,actorId:string,commands:M['connectedCommand'][]):Promise<void>;
 summaries(commands:M['connectedCommand'][]):Promise<M['connectedSummary'][]>;
 media(commands:M['connectedCommand'][],representationId:string,componentId:string):Promise<{bytes:Buffer;file:{mimeType:string;filename?:string}}>;
}
export interface ReleaseAnnouncementPlans<M extends ContentReleaseModels> {
 scope(creatorId:string):ReleaseOrchestrationScope;
 baseline(creatorId:string,collection:M['collection'],organization:M['organization'],actorId:string):Promise<ReleaseBaseline>;
 prepareRelease(input:{creatorId:string;actorId:string;collection:M['collection'];previousCollection:M['collection'];organization:M['organization'];previousOrganization:M['organization'];operationKey:string;exactRequirements:CollectionReleaseRequirement[];memberWorkIds:string[];preparedMedia?:{initial:Record<string,ReleaseAnnouncementBlock[]>;follow_up:Record<string,ReleaseAnnouncementBlock[]>};subject?:ContentReleaseSubject;subjectBaseline?:ReleaseBaseline;workIds:string[];overrides:CollectionAnnouncementPreferencePatch}):Promise<M['orchestrationCommit']|undefined>;
}
export type ReleaseOffer={status:string}|{status:string;snapshot:{offer:{benefits:Array<{type:string;resourceId?:string}>;currency:string;amountMinor:number;terms?:string;supportEmail?:string;billing?:string}}};

/** Bind every capability to the same live host, policy and durable authority as
 * the workflow. A missing capability must not authorize publication or synthesize
 * empty histories. Provider-specific review remains the provider's authority. */
export interface ReleaseActivationReference {kind:string;id:string;revision:number;fingerprint:string}
export interface ReleaseActivationOwnership {schemaVersion:1;fingerprint:string;references:ReleaseActivationReference[]}
export interface ReleaseActivationResource {kind:'announcement'|'collection';id:string;revision:string;contentFingerprint:string;destination:string}
export interface ReleaseActivationInput {creatorId:string;releaseId:string;draftId:string;releaseFingerprint:string;announcementReleaseId?:string;files:ReleasePrivateAnnouncementMedia[];ownership:ReleaseActivationOwnership}
export interface PreparedReleaseActivation {
 resources:ReleaseActivationResource[];activeMediaKeys:string[];deferredMediaKeys:string[];
 /** Genuine current resource/source/safety/organization guards, prepared before
  * the accepting transaction, then enlisted inside that SAME transaction. */
 enlist():Promise<void>;
 /** Actual idempotent visibility acceptance, gated again by the genuine resource
  * authority. Owned bytes already exist; this is not provider dispatch. */
 activate():Promise<void>;
}
export interface ReleaseAnnouncementActivation<C> {
 stageOwnership(commit:C,input:{creatorId:string;releaseId:string;releaseFingerprint:string}):{commit:C;ownership:ReleaseActivationOwnership};
 prepare(input:ReleaseActivationInput):Promise<PreparedReleaseActivation>;
}
export interface ContentReleaseHost<M extends ContentReleaseModels> {
 isNativeDestination(destination:string):boolean;
 nativeWorkDestination():M['publication']['destination'];
 nativeCollectionDestination():M['collectionPublication']['destination'];
 nativeWorkAnnouncementBinding(creatorId:string,workId:string):AnnouncementDestinationBinding;
 nativeCollectionAnnouncementBinding(creatorId:string,collectionId:string):AnnouncementDestinationBinding;
 collection(value:PreparationCollection & {revision:number;relationships?:{premiumCollectionIds:string[];relatedCollectionIds:string[]}}):M['collection'] & {revision:number};
 announcement(value:ReleaseAnnouncementDraft<M>):M['announcementPublication'];
 contentPublishing():ReleaseConnectedPublishing<M>|undefined;
 resolvedContentOffer(creatorId:string,id?:string):Promise<ReleaseOffer|null|undefined>;
 validateNativeCollectionOffer(creatorId:string,audience:'premium'|'followers',offerId?:string):Promise<unknown>;
 communityActorAllowed(actorId:string,creatorId:string):Promise<boolean>;
 announcementRules():Promise<{revision:number}>;
 announcementDestinations(creatorId:string):Promise<M['announcementDestination'][]>;
 announcementKnownLinks(creatorId:string,workId?:string,collectionId?:string):Promise<{links:Array<{url:string;label:string}>}>;
 parseAnnouncement(input:unknown,workIds:string[]):M['announcementContent'];
 validateAnnouncement(content:M['announcementContent'],destinations:M['announcementDestination'][],creatorId:string,rulesRevision:number):Promise<unknown>;
 announcementDocumentForDestination(document:ReleaseAnnouncementDocument,destinationId:string):ReleaseAnnouncementDocument;
 stageAnnouncementMedia<T>(operation:()=>Promise<T>):Promise<{value:T;files:ReleasePrivateAnnouncementMedia[]}>;
 pinCollectionAnnouncementMedia(creatorId:string,collectionId:string,selection:AnnouncementMediaSelection,workIds:readonly string[],outputs:ReleaseOutput<M>[]):Promise<{blocks:ReleaseAnnouncementBlock[]}>;
 activateAnnouncementMedia(creatorId:string,files:ReleasePrivateAnnouncementMedia[]):Promise<void>;
 /** Additive strong ordering. Existing hosts keep their legacy binding; a host
  * that installs this protocol must materialize real resource identity before
  * any public media activation. Old accepted rows are never upgraded by reads. */
 announcementActivation?:ReleaseAnnouncementActivation<M['orchestrationCommit']>;
 /** Physical immutable receipt/byte validation occurs before acceptance. The
  * returned closure binds the same exact alias/source/safety authority inside
  * the accepting transaction; it must perform no provider I/O there. */
 prepareAnnouncementMediaAcceptance?(files:readonly ReleasePrivateAnnouncementMedia[]):Promise<{enlist():Promise<void>}>;
 readStagedAnnouncementMedia(file:ReleasePrivateAnnouncementMedia):Promise<Buffer>;
 readAnnouncementFile(key:string):Promise<{bytes:Buffer;mime:string;filename:string}>;
 readAnnouncementImage(key:string,maxBytes:number,mimes:string[],allowPrivate:boolean):Promise<{bytes:Buffer;mime:string}>;
 evaluatePublicationPolicy(input:{operation:'publish';targets:Array<{type:'creator'|'work'|'asset';id:string}>}):Promise<{allowed:boolean}>;
 nativeWorkPublication(work:M['work'],existing:M['publication']|undefined,input:{published:boolean;visibility:PublicationVisibility;metadata?:ReleasePublication['metadataOverrides'];providerData:Record<string,unknown>;now:string}):M['publication'];
 resolvedCollectionMembers(tenantId:string,collection:M['collection']):Promise<PreparationCollectionMember[]>;
 evaluateNativeCollectionPublication(creatorId:string,input:M['collectionPublication'],allowed:(work:M['work'])=>Promise<boolean>):Promise<M['collectionPublication']>;
 announcementPlans():ReleaseAnnouncementPlans<M>;
 captureCollectionReleaseRequirements(input:{creatorId:string;actorId:string;collection:M['collection'];organization:M['organization'];workIds:string[]}):Promise<CollectionReleaseRequirement[]>;
 readOrchestrationValue<T>(scope:ReleaseOrchestrationScope,reference:ReleaseValueReference):Promise<T>;
}
