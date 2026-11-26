import {createHash} from 'node:crypto';
import type {StoredObject,StreamingObjectStorage} from './index.js';
/** Stream a receipt's exact physical version. This never materializes the body. */
export async function inspectStoredObjectStream(storage:StreamingObjectStorage,expected:StoredObject,maximumBytes:number):Promise<{checksumSha256:string;sizeBytes:number}>{
 if(!expected.versionId||expected.versionId==='null'||!Number.isSafeInteger(maximumBytes)||maximumBytes<1||!Number.isSafeInteger(expected.byteLength)||expected.byteLength<1||expected.byteLength>maximumBytes||!/^[a-f0-9]{64}$/.test(expected.checksum??''))throw Error('An exact original receipt and bounded byte allowance are required.');
 const stream=await storage.openReadStream({...expected,versionId:expected.versionId});
 try{
  const object=stream.object;
  if(object.bucket!==expected.bucket||object.key!==expected.key||object.versionId!==expected.versionId||object.contentType!==expected.contentType||object.byteLength!==expected.byteLength||object.scope!==expected.scope||object.checksum!==undefined&&object.checksum!==expected.checksum)throw Error('Original stream does not match its physical receipt.');
  let size=0;const hash=createHash('sha256');
  for await(const chunk of stream.body){if(!(chunk instanceof Uint8Array)||chunk.byteLength>expected.byteLength-size)throw Error('Original stream exceeds its exact byte allowance.');size+=chunk.byteLength;hash.update(chunk);}
  const checksum=hash.digest('hex');if(size!==expected.byteLength||checksum!==expected.checksum)throw Error('Original bytes do not match their physical receipt.');
  return {checksumSha256:checksum,sizeBytes:size};
 }finally{await stream.close();}
}
