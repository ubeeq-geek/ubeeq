import {createHash} from 'node:crypto';
import {requireCreatorScopedObject} from './object-key-scope.js';
import type {StoredObject,UploadInitiation} from './index.js';
/** Trusted physical port, not permission to delete arbitrary caller paths.
 * The host must first persist its actual owned immutable receipt+intent. */
export interface OwnedVersionRemovalRequest {object:StoredObject;upload:UploadInitiation;cellId:string;creatorId:string;}
export interface OwnedVersionAbsenceProof {
 schemaVersion:1;state:'absent';targetFingerprint:string;proofId:string;observedAt:string;
 /** Permanent conditional-upload fence, retained independently of the removed
  * content version. Local uses its actual durable upload seal; S3 keeps zero bytes. */
 fence:{kind:'local-upload-seal';uploadId:string;proofId:string;closedAt:string}|{kind:'s3-current-version';object:StoredObject};
}
export interface OwnedVersionRemovalAdapter {removeOwnedVersion(input:OwnedVersionRemovalRequest):Promise<OwnedVersionAbsenceProof>;}
const instant=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export const ownedVersionFingerprint=(input:OwnedVersionRemovalRequest):string=>{
 const {object,upload}=input;
 if(!object||!object.bucket||!object.key||!object.versionId||object.versionId==='null'||!object.contentType||object.scope!=='private'||!Number.isSafeInteger(object.byteLength)||object.byteLength<1||!/^[a-f0-9]{64}$/.test(object.checksum??'')||!instant(object.writtenAt)||!upload?.uploadId||!instant(upload.expiresAt))throw Error('An exact completed private immutable upload receipt is required for removal.');
 requireCreatorScopedObject(object.key,input);
 if(['bucket','key','contentType','byteLength','checksum','scope'].some(key=>upload.object[key as keyof StoredObject]!==object[key as keyof StoredObject]))throw Error('The original upload capability does not own this exact content receipt.');
 return createHash('sha256').update(JSON.stringify([input.cellId,input.creatorId,object.bucket,object.key,object.versionId,object.contentType,object.byteLength,object.checksum,object.scope,object.writtenAt,upload.uploadId,upload.expiresAt])).digest('hex');
};
export function validateOwnedVersionAbsence(input:OwnedVersionRemovalRequest,proof:OwnedVersionAbsenceProof):void{
 const targetFingerprint=ownedVersionFingerprint(input);
 if(!proof||proof.schemaVersion!==1||proof.state!=='absent'||proof.targetFingerprint!==targetFingerprint||!/^[a-f0-9]{64}$/.test(proof.proofId)||!instant(proof.observedAt))throw Error('Actual matching immutable-version absence evidence is required.');
 const fence=proof.fence;
 if(fence?.kind==='local-upload-seal'){
  if(fence.uploadId!==input.upload.uploadId||!/^[a-f0-9]{64}$/.test(fence.proofId)||!instant(fence.closedAt)||fence.closedAt>proof.observedAt)throw Error('The durable upload fence conflicts with this deletion.');
 }else if(fence?.kind==='s3-current-version'){
  const object=fence.object;if(!object||object.bucket!==input.object.bucket||object.key!==input.object.key||!object.versionId||object.versionId==='null'||object.versionId===input.object.versionId||object.byteLength!==0||object.contentType!=='application/octet-stream'||object.scope!=='private'||object.checksum!==createHash('sha256').update(new Uint8Array()).digest('hex')||!instant(object.writtenAt)||object.writtenAt>proof.observedAt)throw Error('The permanent empty current-version fence conflicts with this deletion.');
 }else throw Error('A permanent physical upload fence is required before deletion.');
}
