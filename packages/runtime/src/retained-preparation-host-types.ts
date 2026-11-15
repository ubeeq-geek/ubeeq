import type {ContentMetadataField,PublicationIntentStatus} from '@ubeeq/core';
import type {PreparationCollection,PreparationCollectionMember,PreparationSourceFile,PreparationWork} from './content-preparation-host.js';

export type RetainedMetadataField='title'|'description'|ContentMetadataField;
export type RetainedMetadataValues=Partial<Record<RetainedMetadataField,string|string[]|boolean|number|null>>;
export interface RetainedMetadataOverride {destination:string;accountId?:string;publicationId?:string;values:RetainedMetadataValues}
export interface RetainedWorkFieldMetadata {shared:RetainedMetadataValues;overrides:RetainedMetadataOverride[]}
export interface RetainedSetupDestination<D extends string=string> {
 destination:D;integrationAccountId?:string;desiredStatus:PublicationIntentStatus;scheduledAt?:string;
 galleryExternalCollectionIds?:string[];galleryFeature?:boolean;
}
export interface RetainedSetupIntent<D extends string=string> extends RetainedSetupDestination<D> {
 publicationIntentId:string;publicationId?:string;tenantId:string;creatorId:string;workId:string;enabled:boolean;
 gallerySelectionEditedAt?:string;createdAt:string;updatedAt:string;
}
export interface RetainedSetupPublication<D extends string=string> {
 publicationId:string;destination:D;integrationAccountId?:string;status:string;providerData?:Record<string,unknown>;
}
export interface RetainedPreparationModels<D extends string=string> {
 work:PreparationWork;collection:PreparationCollection;file:PreparationSourceFile;
 publication:RetainedSetupPublication<D>;intent:RetainedSetupIntent<D>;externalAccount:unknown;
}
export interface RetainedSetupSettings<D extends string=string> {
 profile:RetainedWorkFieldMetadata;destinations:RetainedSetupDestination<D>[];
 publicationSettings?:Array<{destination:string;accountId?:string;galleries:string[];values:RetainedMetadataValues}>;
}
export type RetainedCollectionDestinationRequirement<D extends string=string>=RetainedSetupDestination<D>&{collectionId:string;collectionTitle:string};
export interface RetainedSetupStore<D extends string,M extends RetainedPreparationModels<D>> {
 getCreatorById(creatorId:string):Promise<{name:string}|null>;
 listPublicationsByWork(tenantId:string,workId:string):Promise<M['publication'][]>;
 listPublicationIntentsByWork(tenantId:string,workId:string):Promise<M['intent'][]>;
 upsertPublicationIntent(intent:M['intent']):Promise<void>;
 getExternalAccount(id:string):Promise<M['externalAccount']|null>;
}
/** All provider-specific metadata and gallery copies remain owned by the actual
 * host. These functions stage local choices; they never authorize publication. */
export interface RetainedSetupHost<D extends string,M extends RetainedPreparationModels<D>> {
 currentFieldMetadata(work:M['work']):RetainedWorkFieldMetadata;
 parseFieldMetadata(input:unknown):RetainedWorkFieldMetadata;
 loadFieldMetadata(tenantId:string,work:M['work']):Promise<RetainedWorkFieldMetadata>;
 requiredCollectionDestinations(work:M['work']):Promise<RetainedCollectionDestinationRequirement<D>[]>;
 mergeDestinationChoices(rows:RetainedSetupDestination<D>[]):RetainedSetupDestination<D>[];
 withoutCollectionDestinations(rows:RetainedSetupDestination<D>[],required:RetainedCollectionDestinationRequirement<D>[]):RetainedSetupDestination<D>[];
 prepareDeviantArtGalleryIntents(tenantId:string,work:M['work'],account:M['externalAccount'],ids:string[],status:'draft'|'live',mode:'add',preserveInProgress:boolean):Promise<{preservedPublicationIds:string[]}>;
 intent(value:RetainedSetupIntent<D>):M['intent'];
}
export interface RetainedOriginalConfiguration {
 tenantId:string;localMediaDirectory?:string;externalContentMaxBytes:number;privateOriginalsBucket?:string;
}
/** Match the Node stream transport; the host opens unencoded original bytes. */
export interface RetainedOriginalStream extends AsyncIterable<Buffer|string> {destroy?():void}
export interface RetainedOriginalHost {
 originalCreatorPrefix(creatorId:string,privateStorage:boolean):string;
 isPrivateOriginalKey(key:string):boolean;
 openStream(key:string):Promise<RetainedOriginalStream>;
}
export interface RetainedSourceAccess {actorUserId:string;isAdmin:boolean}
export interface RetainedIntakeFile extends PreparationSourceFile {
 originalFilename:string;sizeBytes:number;revision:1;uploadState:'pending';
 downloadable:false;premium:false;restricted:false;
}
export interface RetainedSourceAudit {
 auditId:string;actorUserId:string;actorRole:'admin'|'creator';action:'source_file.upload.prepared';createdAt:string;
 detail:{fileId:string;creatorId:string;revision:1;uploadState:'pending';downloadable:false};
}
export interface RetainedSourceIntakeStore<F extends PreparationSourceFile,A extends RetainedSourceAccess> {
 getWork(tenantId:string,workId:string):Promise<{creatorId:string;deletedAt?:string;archivedAt?:string}|null>;
 /** The host must recheck current actor/creator custody and join the original,
  * audit and expected-role/member evidence in its real conditional writer. */
 commitSourceFile(input:{expected:null;file:F;access:A;audit:RetainedSourceAudit}):Promise<void>;
}
export interface RetainedSourceIntakeHost<F extends PreparationSourceFile> {
 originalCreatorPrefix(creatorId:string,privateStorage:boolean):string;
 file(value:RetainedIntakeFile):F;
}
export interface RetainedVolumeStore<C extends PreparationCollection> {
 listCollectionWorks(tenantId:string,id:string):Promise<PreparationCollectionMember[]>;
 listCreatorCollections(tenantId:string,creatorId:string):Promise<C[]>;
}
export interface RetainedVolumeHost {conflict(message:string):Error}
