import type {PublicationAdmissionResult} from './index.js';
/** A genuine non-Work resource. A host must derive this identity/revision and
 * fingerprint from its actual current canonical source and rendered inventory.
 * Neither field is a surrogate Work ID or a client-supplied readiness proof. */
export type PublicationResource={kind:'announcement'|'professional-intent'|'reddit-intent'|'ghost-outbound'|'wordpress-outbound'|'vimeo-publication'|'fanvue-publication'|'native-metadata-update'|'provider-outbound';id:string;revision:string;contentFingerprint:string}|{kind:'collection';id:string;revision:string;contentFingerprint:string};
export interface ResourceAdmissionEvaluationInput{resource:PublicationResource;creatorId:string;actorUserId:string;destination:string;visibility:string;}
/** Additive companion on the EXISTING publicationAdmission host object. The six
 * host slots and Work-only evaluatePublication behavior remain unchanged. */
export interface ResourcePublicationAdmissionPort{evaluateResource(input:ResourceAdmissionEvaluationInput):Promise<PublicationAdmissionResult>}
