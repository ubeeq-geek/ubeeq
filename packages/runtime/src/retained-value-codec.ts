import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
export interface Scope {instanceId:string;tenantId:string;creatorId:string;cellId:string;region:string}
export interface Address {category:'canonical'|'command'|'entity';kind:string;key:string}
export interface Chunk extends Record<string,unknown> {schemaVersion:2;physicalKind:'retained-json-chunk';scope:Scope;address:Address;generation:string;index:number;byteLength:number;checksumSha256:string;data:string}
interface Encoding {generation:string;byteLength:number;checksumSha256:string}
export interface Header extends Address,Record<string,unknown> {schemaVersion:2;encoding:Encoding&({format:'json-utf8-inline-v1'}|{format:'json-utf8-chunks-v1';chunkIds:string[]});json?:string}
export interface LegacyHeader extends Address,Record<string,unknown> {schemaVersion:1;payload:Record<string,unknown>}
export interface PhysicalValue {header:Header;chunks:Array<{id:string;value:Chunk}>}
/** A mathematical sizing port from the actual target repository, including its
 * complete physical HostRecord envelope. It is never a configurable byte flag
 * and confers no write, actor, migration, receipt or provider authority. */
export interface PhysicalStorage {fits(id:string,key:string,value:Record<string,unknown>):boolean}
export interface Limits {maximumLogicalBytes:number;chunkBytes:number}
const defaults:Limits={maximumLogicalBytes:Number.MAX_SAFE_INTEGER,chunkBytes:120000};
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,ordered(child)])):value;
const same=(a:unknown,b:unknown)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
const invalid=():never=>{throw Error('Retained physical JSON requires reconciliation.');};
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value),'utf8');
export const retainedLogicalAddressKey=(address:Address)=>JSON.stringify([address.category,address.kind,address.key]);
export const retainedLogicalRecordId=(scope:Scope,address:Address)=>'retained-'+hash(JSON.stringify([scope.instanceId,scope.tenantId,scope.creatorId,address]));
export const retainedPhysicalChunkKey=(id:string)=>'physical:'+id;
function validate(scope:Scope,address:Address,storage:PhysicalStorage,limits:Limits):void {
 if(!scope||Object.keys(scope).length!==5||['instanceId','tenantId','creatorId','cellId','region'].some(key=>typeof scope[key as keyof Scope]!=='string'||!scope[key as keyof Scope]||scope[key as keyof Scope].length>200)||!address||!['canonical','command','entity'].includes(address.category)||typeof address.kind!=='string'||!address.kind||typeof address.key!=='string'||!address.key||typeof storage?.fits!=='function'||!Number.isSafeInteger(limits.maximumLogicalBytes)||limits.maximumLogicalBytes<1||!Number.isSafeInteger(limits.chunkBytes)||limits.chunkBytes<1||limits.chunkBytes>120000)invalid();
}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value as Record<string,unknown>;}
function ownership(scope:Scope,value:Record<string,unknown>):void {if(Object.hasOwn(value,'tenantId')&&value.tenantId!==scope.tenantId||Object.hasOwn(value,'creatorId')&&value.creatorId!==scope.creatorId)invalid();}
const generation=(scope:Scope,address:Address,checksum:string)=>hash(JSON.stringify(ordered([scope,address,checksum])));
const chunkId=(scope:Scope,address:Address,gen:string,index:number)=>'retained-chunk-'+hash(JSON.stringify(ordered([scope,address,gen,index])));
/** One opaque JSON string is the preferred physical representation. Dynamo
 * stores its UTF-8 string bytes; JSON wire escaping does not multiply item size.
 * Actual Local repository storage has no new 300KiB physical-row limit, so a
 * Native-sized 1MiB logical record remains one row. The complete original JSON,
 * including unknown fields, is never stored in a second editable aggregate. */
export function encodeRetainedValue(scope:Scope,address:Address,value:Readonly<Record<string,unknown>>,storage:PhysicalStorage,limits:Limits=defaults):PhysicalValue {
 validate(scope,address,storage,limits);const normalized=object(JSON.parse(JSON.stringify(value)));ownership(scope,normalized);const original=bytes(normalized);if(original.length>limits.maximumLogicalBytes)throw Error('Original logical record budget exceeded.');
 const checksum=hash(original),gen=generation(scope,address,checksum),identity=retainedLogicalRecordId(scope,address),key=retainedLogicalAddressKey(address),inline:Header={schemaVersion:2,...structuredClone(address),encoding:{format:'json-utf8-inline-v1',generation:gen,byteLength:original.length,checksumSha256:checksum},json:original.toString('utf8')};
 if(storage.fits(identity,key,inline))return {header:inline,chunks:[]};
 const chunks:PhysicalValue['chunks']=[];
 for(let offset=0,index=0;offset<original.length;offset+=limits.chunkBytes,index++){
  const part=original.subarray(offset,Math.min(offset+limits.chunkBytes,original.length)),id=chunkId(scope,address,gen,index),value:Chunk={schemaVersion:2,physicalKind:'retained-json-chunk',scope:structuredClone(scope),address:structuredClone(address),generation:gen,index,byteLength:part.length,checksumSha256:hash(part),data:part.toString('base64')};
  if(!storage.fits(id,retainedPhysicalChunkKey(id),value))throw Error('The complete physical chunk exceeds the actual target item budget.');chunks.push({id,value});
 }
 const header:Header={schemaVersion:2,...structuredClone(address),encoding:{format:'json-utf8-chunks-v1',generation:gen,byteLength:original.length,checksumSha256:checksum,chunkIds:chunks.map(value=>value.id)}};
 if(!storage.fits(identity,key,header))throw Error('The complete physical header exceeds the actual target item budget.');return {header,chunks};
}
/** Reads are strict and read-only. Schema1, original schema2 chunk headers and
 * inline schema2 coexist without initialization, rewriting, missing-part repair
 * or schema migration on read. The accepting cohort supplies exact inventory. */
export function decodeRetainedValue(scope:Scope,address:Address,header:Header|LegacyHeader,readChunk:(id:string)=>unknown,storage:PhysicalStorage,limits:Limits=defaults):Record<string,unknown> {
 validate(scope,address,storage,limits);if(!header||!same({category:header.category,kind:header.kind,key:header.key},address))invalid();
 if(header.schemaVersion===1){const value=object(JSON.parse(JSON.stringify(header.payload)));ownership(scope,value);if(bytes(value).length>limits.maximumLogicalBytes)invalid();return value;}
 if(header.schemaVersion!==2||!storage.fits(retainedLogicalRecordId(scope,address),retainedLogicalAddressKey(address),header))invalid();const e=header.encoding;
 if(!e||!['json-utf8-inline-v1','json-utf8-chunks-v1'].includes(e.format)||!Number.isSafeInteger(e.byteLength)||e.byteLength<2||e.byteLength>limits.maximumLogicalBytes||!/^[a-f0-9]{64}$/.test(e.checksumSha256)||e.generation!==generation(scope,address,e.checksumSha256))invalid();let original:Buffer;
 if(e.format==='json-utf8-inline-v1'){
  if(typeof header.json!=='string'||Object.hasOwn(e,'chunkIds'))return invalid();original=Buffer.from(header.json,'utf8');
 }else{
  if(Object.hasOwn(header,'json')||!Array.isArray(e.chunkIds)||e.chunkIds.length!==Math.ceil(e.byteLength/limits.chunkBytes)||new Set(e.chunkIds).size!==e.chunkIds.length)invalid();const parts:Buffer[]=[];
  for(let index=0;index<e.chunkIds.length;index++){const id=e.chunkIds[index],value=readChunk(id) as Chunk;
   if(id!==chunkId(scope,address,e.generation,index)||!value||value.schemaVersion!==2||value.physicalKind!=='retained-json-chunk'||!same(value.scope,scope)||!same(value.address,address)||value.generation!==e.generation||value.index!==index||typeof value.data!=='string'||!storage.fits(id,retainedPhysicalChunkKey(id),value))invalid();const part=Buffer.from(value.data,'base64'),length=Math.min(limits.chunkBytes,e.byteLength-index*limits.chunkBytes);if(part.toString('base64')!==value.data||part.length!==length||value.byteLength!==length||value.checksumSha256!==hash(part))invalid();parts.push(part);
  }original=Buffer.concat(parts,e.byteLength);
 }
 if(original.length!==e.byteLength||hash(original)!==e.checksumSha256)invalid();let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(original);}catch{return invalid();}let value:Record<string,unknown>;try{value=object(JSON.parse(text));}catch{return invalid();}ownership(scope,value);return value;
}
