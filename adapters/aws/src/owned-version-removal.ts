import {createHash} from 'node:crypto';
import {HeadObjectCommand,PutObjectCommand,DeleteObjectCommand,S3ServiceException,type HeadObjectCommandOutput} from '@aws-sdk/client-s3';
import {ownedVersionFingerprint,validateOwnedVersionAbsence,type OwnedVersionRemovalRequest,type OwnedVersionAbsenceProof,type StoredObject} from '@ubeeq/storage';
import type {AwsCommandClient} from './client-port.js';
const empty=createHash('sha256').update(new Uint8Array()).digest('hex'),base64=(value:string)=>Buffer.from(value,'hex').toString('base64');
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const notFound=(error:unknown)=>error instanceof S3ServiceException&&error.$metadata.httpStatusCode===404;
/** A provider 403, timeout, arbitrary exception or void DeleteObject response is
 * never interpreted as absence. Current-key fencing survives late conditional
 * PUTs; only the one recorded immutable content VersionId is removed. */
export async function removeOwnedS3Version(s3:AwsCommandClient,configuration:{bucket:string;cellId?:string;keyPrefix?:string},input:OwnedVersionRemovalRequest):Promise<OwnedVersionAbsenceProof>{
 const targetFingerprint=ownedVersionFingerprint(input),object=input.object;
 if(object.bucket!==configuration.bucket||configuration.cellId&&input.cellId!==configuration.cellId||configuration.keyPrefix&&!object.key.startsWith(configuration.keyPrefix+'/'))throw Error('Owned removal is outside the actual configured physical bucket/cell/key prefix.');
 if(input.upload.parts?.length!==1||input.upload.parts[0].partNumber!==1||input.upload.parts[0].headers?.['if-none-match']!=='*')throw Error('Only the actual conditional one-part upload protocol can be permanently fenced by this adapter.');
 const head=async(versionId?:string):Promise<HeadObjectCommandOutput|undefined>=>{try{return await s3.send(new HeadObjectCommand({Bucket:object.bucket,Key:object.key,...(versionId?{VersionId:versionId}:{}),ChecksumMode:'ENABLED'}));}catch(error){if(notFound(error))return undefined;throw error;}};
 const matches=(value:NonNullable<Awaited<ReturnType<typeof head>>>)=>value.VersionId===object.versionId&&value.ContentLength===object.byteLength&&value.ContentType===object.contentType&&value.Metadata?.checksum===object.checksum&&value.Metadata?.scope===object.scope&&value.ChecksumSHA256===base64(object.checksum!)&&value.LastModified?.toISOString()===object.writtenAt;
 const fenceValue=(value:NonNullable<Awaited<ReturnType<typeof head>>>):StoredObject|undefined=>{
  if(value.Metadata?.['ubeeq-owned-removal']!==targetFingerprint)return;
  if(value.ContentLength!==0||value.ContentType!=='application/octet-stream'||value.Metadata.scope!=='private'||value.Metadata.checksum!==empty||value.ChecksumSHA256!==base64(empty)||!value.VersionId||value.VersionId==='null'||!value.LastModified)throw Error('The permanent owned-version fence requires reconciliation.');
  return {bucket:object.bucket,key:object.key,versionId:value.VersionId,byteLength:0,contentType:'application/octet-stream',scope:'private',checksum:empty,writtenAt:value.LastModified.toISOString()};
 };
 let fence:StoredObject|undefined;
 for(let attempt=0;attempt<5;attempt++){
  const current=await head();if(current){fence=fenceValue(current);if(fence)break;if(!matches(current)||!current.ETag)throw Error('The current version is neither the exact owned content nor its matching permanent fence.');}
  // A prior ambiguous exact-version removal may have completed. Absence alone
  // is insufficient: install the permanent empty current version before proof.
  try{await s3.send(new PutObjectCommand({Bucket:object.bucket,Key:object.key,...(current?{IfMatch:current.ETag}:{IfNoneMatch:'*'}),Body:new Uint8Array(),ContentLength:0,ContentType:'application/octet-stream',ChecksumSHA256:base64(empty),Metadata:{'ubeeq-owned-removal':targetFingerprint,scope:'private',checksum:empty,bytelength:'0'}}));}
  catch(error){const status=(error as {$metadata?:{httpStatusCode?:number}})?.$metadata?.httpStatusCode;if(status!==409&&status!==412)throw error;}
 }
 if(!fence)throw Error('The actual permanent current-version fence could not be verified.');
 const original=await head(object.versionId);if(original&&!matches(original))throw Error('The recorded immutable content version changed.');
 if(original){try{await s3.send(new DeleteObjectCommand({Bucket:object.bucket,Key:object.key,VersionId:object.versionId}));}catch(error){if(await head(object.versionId))throw error;}}
 if(await head(object.versionId))throw Error('The exact owned content version still exists.');
 const current=await head();if(!current||!fenceValue(current)||current.VersionId!==fence.versionId)throw Error('The permanent upload fence was replaced during removal.');
 const observedAt=new Date().toISOString(),proof:OwnedVersionAbsenceProof={schemaVersion:1,state:'absent',targetFingerprint,proofId:hash([targetFingerprint,fence.versionId,'actual-version-404',observedAt]),observedAt,fence:{kind:'s3-current-version',object:fence}};validateOwnedVersionAbsence(input,proof);return proof;
}
