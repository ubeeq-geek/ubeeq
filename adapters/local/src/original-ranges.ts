import {createHash} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {requireCreatorScopedObject,type StoredObject,type StoredObjectRangeReader} from '@ubeeq/storage';
import type {LocalSqliteDatabase} from './index.js';
const maximumRange=8*1024*1024;
const sameFile=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const descriptor=(value:unknown):value is StoredObject=>!!value&&typeof value==='object'&&typeof Reflect.get(value,'bucket')==='string'&&typeof Reflect.get(value,'key')==='string'&&typeof Reflect.get(value,'versionId')==='string'&&typeof Reflect.get(value,'contentType')==='string'&&!!Reflect.get(value,'contentType')&&Number.isSafeInteger(Reflect.get(value,'byteLength'))&&Reflect.get(value,'byteLength')>=0&&['private','restricted','public'].includes(Reflect.get(value,'scope'))&&(Reflect.get(value,'checksum')===undefined||typeof Reflect.get(value,'checksum')==='string');
/** Same configured physical store as normal original streams. A pinned fd plus
 * whole original hash and before/after stat fences preserves the original
 * Native upload reader without loading the entire original into memory. */
export async function openOwnedLocalRanges(local:LocalSqliteDatabase,input:Pick<StoredObject,'bucket'|'key'>&{versionId:string}):Promise<StoredObjectRangeReader>{
 if(!input.bucket||Buffer.byteLength(input.bucket)>255||/[\\/\r\n\u0000]/.test(input.bucket)||['.','..'].includes(input.bucket)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.versionId??''))throw Error('An exact local object bucket/version is required.');
 const match=input.key.match(/^cells\/([^/]+)\/creators\/([^/]+)\//);if(!match||match[1]!==local.configuration.cellId)throw Error('Original range is outside its cell.');requireCreatorScopedObject(input.key,{cellId:match[1],creatorId:match[2]});
 const root=await realpath(resolve(local.configuration.dataDirectory,'objects',input.bucket)),path=resolve(root,input.key,input.versionId);
 if(!path.startsWith(root+'/')||await realpath(path)!==path||await realpath(path+'.json')!==path+'.json')throw Error('Original range location escapes its owned root.');
 const metadata=await open(path+'.json',constants.O_RDONLY|constants.O_NOFOLLOW);let value:unknown;
 try{const stat=await metadata.stat();if(!stat.isFile()||stat.size>64*1024)throw Error('Original range metadata exceeds its safe size.');value=JSON.parse(await metadata.readFile('utf8'));}finally{await metadata.close();}
 if(!descriptor(value)||value.bucket!==input.bucket||value.key!==input.key||value.versionId!==input.versionId)throw Error('Original range metadata conflicts.');
 const saved=structuredClone(value),handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const initial=await handle.stat({bigint:true});if(!initial.isFile()||initial.size!==BigInt(saved.byteLength))throw Error('Original range size conflicts.');
  const unchanged=async()=>{if(!sameFile(initial,await handle.stat({bigint:true})))throw Error('Original changed during its immutable range session.');};
  const hash=createHash('sha256');let size=0;for await(const bytes of handle.createReadStream({autoClose:false,highWaterMark:64*1024})){size+=bytes.byteLength;if(size>saved.byteLength)throw Error('Original range size changed.');hash.update(bytes);}
  const checksum=hash.digest('hex');if(size!==saved.byteLength||saved.checksum!==undefined&&saved.checksum.toLowerCase()!==checksum)throw Error('Original checksum changed.');await unchanged();
  const object=Object.freeze({...saved,checksum});let closed=false;
  return {object,async read(offset,length){if(closed)throw Error('Original range session is closed.');if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>maximumRange||offset>object.byteLength-length)throw Error('Original range is outside its bounded exact version.');await unchanged();const buffer=Buffer.alloc(length);let copied=0;while(copied<length){const result=await handle.read(buffer,copied,length-copied,offset+copied);if(!result.bytesRead)throw Error('Original range ended before its exact size.');copied+=result.bytesRead;}await unchanged();if(closed)throw Error('Original range session closed before completion.');return buffer;},async close(){if(!closed){closed=true;await handle.close();}}};
 }catch(error){await handle.close();throw error;}
}
