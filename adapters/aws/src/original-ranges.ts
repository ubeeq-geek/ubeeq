import {GetObjectCommand,HeadObjectCommand,type GetObjectCommandOutput,type HeadObjectCommandOutput} from '@aws-sdk/client-s3';
import {readBoundedBytes,requireCellScopedObject,type StoredObject,type StoredObjectRangeReader} from '@ubeeq/storage';
import type {AwsCommandClient} from './client-port.js';
const maximumRange=8*1024*1024;
const stream=(value:unknown):value is AsyncIterable<Uint8Array>&{destroy?:()=>void}=>!!value&&typeof value==='object'&&typeof Reflect.get(value,Symbol.asyncIterator)==='function';
/** Exact configured bucket/physical key/immutable version. The host keeps its
 * current SourceFile/receipt/access guards and full original integrity check;
 * this adapter does not infer any of those domain authorities. */
export async function openOwnedS3Ranges(client:AwsCommandClient,configuration:{bucket:string;cellId?:string;keyPrefix?:string},input:Pick<StoredObject,'bucket'|'key'>&{versionId:string}):Promise<StoredObjectRangeReader>{
 if(!input.versionId||input.versionId==='null'||input.bucket!==configuration.bucket)throw Error('An exact version in the configured object bucket is required.');
 const key=configuration.keyPrefix&&!input.key.startsWith(configuration.keyPrefix+'/')?configuration.keyPrefix+'/'+input.key:input.key;if(key!==input.key)throw Error('An exact physical object key is required.');if(configuration.cellId)requireCellScopedObject(key,configuration.cellId);
 const head:HeadObjectCommandOutput=await client.send(new HeadObjectCommand({Bucket:configuration.bucket,Key:key,VersionId:input.versionId}));
 if(head.$metadata.httpStatusCode!==200||head.VersionId!==input.versionId||typeof head.ETag!=='string'||!head.ETag||/[\r\n]/.test(head.ETag)||!Number.isSafeInteger(head.ContentLength)||head.ContentLength===undefined||head.ContentLength<0||head.Metadata?.scope!==undefined&&!['private','restricted','public'].includes(head.Metadata.scope))throw Error('Original storage did not identify its exact immutable range version.');
 const total=head.ContentLength,etag=head.ETag,scope:StoredObject['scope']=head.Metadata?.scope==='public'?'public':head.Metadata?.scope==='restricted'?'restricted':'private',object:StoredObject=Object.freeze({bucket:configuration.bucket,key,versionId:input.versionId,contentType:head.ContentType??'application/octet-stream',byteLength:total,scope,...(head.Metadata?.checksum?{checksum:head.Metadata.checksum}:{}),...(head.LastModified?{writtenAt:head.LastModified.toISOString()}:{})});let closed=false;
 return{object,async read(offset,length){if(closed)throw Error('Original range session is closed.');if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>maximumRange||offset>total-length)throw Error('Original range is outside its bounded exact version.');const end=offset+length-1,response:GetObjectCommandOutput=await client.send(new GetObjectCommand({Bucket:configuration.bucket,Key:key,VersionId:input.versionId,IfMatch:etag,Range:'bytes='+offset+'-'+end})),body=response.Body;
  try{if(closed||!stream(body)||response.$metadata.httpStatusCode!==206||response.VersionId!==input.versionId||response.ETag!==etag||response.ContentLength!==length||response.ContentRange!=='bytes '+offset+'-'+end+'/'+total)throw Error('Original storage returned a different or incomplete immutable range.');const bytes=await readBoundedBytes(body,length);if(bytes.byteLength!==length||closed)throw Error('Original range ended before its exact size or closed.');return bytes;}finally{if(stream(body)&&typeof body.destroy==='function')body.destroy();}
 },async close(){closed=true;}};
}
