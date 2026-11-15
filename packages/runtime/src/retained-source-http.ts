import {randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {AuthenticatedSession} from '@ubeeq/auth';
import type {RetainedCreatorContentModels} from '@ubeeq/persistence';
import type {DeliveryAdapter,StreamingObjectStorage,StoredObject} from '@ubeeq/storage';
import {prepareSourceFileIntake,SourceFileIntakeError} from './retained-preparation-host.js';
import type {RetainedIntakeFile} from './retained-preparation-host-types.js';
import {RepositoryRetainedSourceFiles,SourceFileConflict,type RetainedSourceFile} from './retained-source-files.js';
import {RetainedRepositoryError} from './retained-repository-store.js';
import {SourceFileUploads,SourceFileUploadError,sourceFileOriginalCreatorPrefix,sourceFileOriginalObjectKey} from './source-file-uploads.js';

export interface RetainedSourceHttpRequest {incoming:IncomingMessage;session:AuthenticatedSession;query:URLSearchParams|Record<string,unknown>;body:Record<string,unknown>}
export interface RetainedSourceUploadDescriptor<F extends RetainedSourceFile>{file:F;requiresAuth:boolean;uploadPath?:string;uploadUrl?:string;requiredHeaders:Record<string,string>;expiresAt:string;completed:boolean}
export type RetainedSourceOperation='list'|'upload'|'complete'|'cancel'|'download';
export interface RetainedSourceHttpContext<M extends RetainedCreatorContentModels=RetainedCreatorContentModels,F extends RetainedSourceFile=RetainedSourceFile>{
 files:RepositoryRetainedSourceFiles<M,F>;uploads:SourceFileUploads<M,F>;storage:StreamingObjectStorage;
 bucket:string;maximumUploadBytes:number;
 /** Retain the host's complete JSON model, including its original opaque fields. */
 file(value:RetainedIntakeFile):F;
 /** Managed providers may issue an exact-version URL instead of proxying bytes. */
 delivery?:DeliveryAdapter;
}
export interface RetainedSourceHttpBindings<M extends RetainedCreatorContentModels=RetainedCreatorContentModels,F extends RetainedSourceFile=RetainedSourceFile>{
 resolve(request:RetainedSourceHttpRequest,target:{creatorId:string}|{fileId:string}):Promise<RetainedSourceHttpContext<M,F>>;
 listCreators(request:RetainedSourceHttpRequest):Promise<Array<RetainedSourceHttpContext<M,F>>>;
 /** Actual fixed-bucket/private-storage configuration, never a no-op presigner. */
 verifyStorage(request:RetainedSourceHttpRequest,context:RetainedSourceHttpContext<M,F>):Promise<void>;
 /** The actual host rechecks current safety/holds and operation-specific admission. */
 checkAccess(request:RetainedSourceHttpRequest,input:{context:RetainedSourceHttpContext<M,F>;operation:RetainedSourceOperation;file?:Readonly<F>}):Promise<void>;
 /** Explicit compatibility driver only. New-session seals must never be passed
  * to an old all-version purger. Current principal/source access is checked first. */
 legacy?(request:RetainedSourceHttpRequest,response:ServerResponse,input:{context:RetainedSourceHttpContext<M,F>;operation:RetainedSourceOperation;file:Readonly<F>}):Promise<boolean>;
}
const fail=(code:string,status:number,message:string):never=>{throw new SourceFileUploadError(code,status,message);};
const string=(value:unknown,field:string)=>typeof value==='string'&&value?value:fail('invalid_input',400,`${field} is required.`);
function contextValid<M extends RetainedCreatorContentModels,F extends RetainedSourceFile>(context:RetainedSourceHttpContext<M,F>){
 if(!context?.files||!context.uploads||typeof context.storage?.openReadStream!=='function'||!context.bucket||typeof context.file!=='function'||!Number.isSafeInteger(context.maximumUploadBytes)||context.maximumUploadBytes<1||context.maximumUploadBytes>5*1024**3)throw Error('Retained source HTTP requires actual scoped files, owned uploads, versioned streams and a bounded byte allowance.');
 if(Object.entries(context.files.scope).some(([name,value])=>(context.uploads.scope as unknown as Record<string,string>)[name]!==value))throw Error('Original metadata and upload journal scopes must match.');
}
/** Metadata-only intake. Safe inside stageUpload's accepting transaction: this
 * never initiates an upload, reserves quota or queries provider storage. */
export async function prepareRetainedSourceFile<M extends RetainedCreatorContentModels,F extends RetainedSourceFile>(request:RetainedSourceHttpRequest,context:RetainedSourceHttpContext<M,F>,input:Record<string,unknown>,fileId:string=randomUUID()):Promise<F>{
 contextValid(context);const checksum=string(input.checksumSha256,'checksumSha256');
 if(!/^[a-f0-9]{64}$/.test(checksum)||!Number.isSafeInteger(input.sizeBytes)||Number(input.sizeBytes)<1||Number(input.sizeBytes)>context.maximumUploadBytes)fail('invalid_input',400,'Choose a bounded original and its exact SHA-256 checksum.');
 const actor=request.session.subject.id,scope=context.files.scope;
 return prepareSourceFileIntake(context.files,{tenantId:scope.tenantId,externalContentMaxBytes:context.maximumUploadBytes},{creatorId:scope.creatorId,originalFilename:input.originalFilename,mimeType:input.mimeType,sizeBytes:input.sizeBytes,checksumSha256:checksum,...(typeof input.publishingWorkId==='string'?{publishingWorkId:input.publishingWorkId}:{}),fileId},await context.files.captureSourceAccess(actor),async()=>{throw Error('Metadata-only original staging cannot query physical storage.');},{originalCreatorPrefix:()=>sourceFileOriginalCreatorPrefix(scope),file:value=>context.file(value)});
}
/** Call only after the source/workflow transaction has committed. The actual
 * upload journal then fences quota, provider capability, actor and source. */
export async function retainedSourceUploadDescriptor<M extends RetainedCreatorContentModels,F extends RetainedSourceFile>(request:RetainedSourceHttpRequest,context:RetainedSourceHttpContext<M,F>,file:F):Promise<RetainedSourceUploadDescriptor<F>>{
 contextValid(context);
 const result=await context.uploads.initiate({actorId:request.session.subject.id,fileId:file.fileId,checksumSha256:string(file.checksumSha256,'checksumSha256')});
 const upload=result.upload;
 if(upload.parts?.length){
  if(upload.parts.length!==1||upload.parts[0].partNumber!==1)fail('upload_multipart_required',503,'This original requires a multipart uploader.');
  return {file:result.file,requiresAuth:false,uploadUrl:upload.parts[0].url,requiredHeaders:{...upload.parts[0].headers},expiresAt:upload.expiresAt,completed:result.completed};
 }
 return {file:result.file,requiresAuth:true,uploadPath:`/studio/files/${encodeURIComponent(file.fileId)}/local-upload`,requiredHeaders:{'Content-Type':'application/octet-stream'},expiresAt:upload.expiresAt,completed:result.completed};
}
async function bodyBytes(request:IncomingMessage,limit:number):Promise<Buffer>{
 const chunks:Buffer[]=[];let size=0;
 for await(const raw of request){const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw);if(chunk.length>limit-size)fail('payload_too_large',413,'The original transfer exceeds its admitted byte allowance.');size+=chunk.length;chunks.push(chunk);}
 return Buffer.concat(chunks,size);
}
async function jsonBody(request:IncomingMessage,limit:number):Promise<Record<string,unknown>>{
 const bytes=await bodyBytes(request,limit);if(!bytes.length)return {};
 try{const value:unknown=JSON.parse(bytes.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('object required');return value as Record<string,unknown>;}catch{return fail('invalid_json',400,'A JSON object is required.');}
}
const json=(response:ServerResponse,status:number,value:unknown)=>{response.statusCode=status;response.setHeader('Content-Type','application/json; charset=utf-8');response.end(JSON.stringify(value));};
const metadataKeys=new Set(['creatorId','originalFilename','mimeType','sizeBytes','checksumSha256','publishingWorkId']);
const intakeShape=(input:Record<string,unknown>)=>{if(Object.keys(input).some(key=>!metadataKeys.has(key)))fail('invalid_input',400,'Upload location and identity are assigned by the server.');};
function matchReceipt(file:RetainedSourceFile,object:StoredObject,bucket:string){
 if(file.uploadState!=='ready'||file.storageKey!==object.key||object.bucket!==bucket||!object.versionId||object.scope!=='private'||file.sizeBytes!==object.byteLength||file.mimeType!==object.contentType||file.checksumSha256!==object.checksum)fail('original_unavailable',409,'The exact completed original is unavailable.');
}
/** Actual retained source routes, mounted under both Native /studio/files and
 * the /api alias. Authentication precedes body reads and composition lookup. */
export function createRetainedSourceFileNodeHandler<M extends RetainedCreatorContentModels,F extends RetainedSourceFile>(bindings:RetainedSourceHttpBindings<M,F>,authenticate:(request:IncomingMessage)=>Promise<AuthenticatedSession>,options:{publicBaseUrl:string;maxJsonBodyBytes?:number;maxProxyUploadBytes?:number}){
 for(const name of ['resolve','listCreators','verifyStorage','checkAccess'] as const)if(typeof bindings?.[name]!=='function')throw Error('Retained source HTTP requires actual authority, safety and storage bindings.');
 if(typeof authenticate!=='function')throw Error('Retained source HTTP requires verified sessions.');
 const maximumJson=options.maxJsonBodyBytes??32*1024,maximumProxy=options.maxProxyUploadBytes??64*1024*1024;
 if(!Number.isSafeInteger(maximumJson)||maximumJson<1||maximumJson>1024*1024||!Number.isSafeInteger(maximumProxy)||maximumProxy<1||maximumProxy>128*1024*1024)throw Error('Retained source HTTP requires bounded JSON and local transfer sizes.');
 const access=async(request:RetainedSourceHttpRequest,context:RetainedSourceHttpContext<M,F>,operation:RetainedSourceOperation,file?:F)=>{
  contextValid(context);if(!await context.files.authorizeActor(request.session.subject.id,operation==='list'||operation==='download'?'read':'edit'))fail('creator_access_denied',403,'Current Creator access is required.');
  await bindings.checkAccess(request,{context,operation,file});
 };
 return {async handle(incoming:IncomingMessage,response:ServerResponse):Promise<boolean>{
  const url=new URL(incoming.url??'/',options.publicBaseUrl),path=url.pathname.startsWith('/api/studio/files')?url.pathname.slice(4):url.pathname,method=incoming.method??'GET';
  if(path!=='/studio/files'&&!path.startsWith('/studio/files/'))return false;
  const match=path.match(/^\/studio\/files\/([^/]+)\/(upload-url|local-upload|complete|cancel|download)\/?$/);
  if(!(path==='/studio/files'&&method==='GET'||path==='/studio/files/uploads'&&method==='POST'||match&&((match[2]==='local-upload'&&method==='PUT')||(match[2]==='download'&&method==='GET')||(['upload-url','complete','cancel'].includes(match[2])&&method==='POST'))))return false;
  response.setHeader('Cache-Control','private, no-store');response.setHeader('X-Content-Type-Options','nosniff');
  try{
   const session=await authenticate(incoming);
   if(!session?.subject?.id||!Array.isArray(session.subject.roles)||!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=Date.now())fail('authentication_invalid',401,'A verified, unexpired session is required.');
   if(session.subject.accountScope==='customer_account'||session.subject.roles.includes('customer_account'))fail('creator_access_denied',403,'Customer accounts do not have creator access.');
   const request:RetainedSourceHttpRequest={incoming,session,query:url.searchParams,body:{}};
   if(method==='POST')request.body=await jsonBody(incoming,maximumJson);
   if(path==='/studio/files'&&method==='GET'){
    const creatorId=url.searchParams.get('creatorId'),contexts=creatorId?[await bindings.resolve(request,{creatorId})]:await bindings.listCreators(request),files:F[]=[];
    const seen=new Set<string>();for(const context of contexts){if(seen.has(context.files.scope.creatorId))throw Error('Original directory contains duplicate Creator scopes.');seen.add(context.files.scope.creatorId);await access(request,context,'list');files.push(...await context.files.listSourceFilesByCreatorId(context.files.scope.creatorId));}
    json(response,200,files);return true;
   }
   if(path==='/studio/files/uploads'){
    intakeShape(request.body);const creatorId=string(request.body.creatorId,'creatorId'),context=await bindings.resolve(request,{creatorId});
    if(context.files.scope.creatorId!==creatorId)fail('creator_scope_conflict',403,'Original Creator scope does not match.');
    await access(request,context,'upload');await bindings.verifyStorage(request,context);
    const file=await prepareRetainedSourceFile(request,context,request.body);
    json(response,201,await retainedSourceUploadDescriptor(request,context,file));return true;
   }
   let fileId:string;try{fileId=decodeURIComponent(match![1]);}catch{fail('invalid_input',400,'Choose a valid original identity.');}
   if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(fileId!))fail('invalid_input',400,'Choose a valid original identity.');
   const action=match![2],context=await bindings.resolve(request,{fileId:fileId!}),file=await context.files.getSourceFileById(fileId!);
   if(!file)fail('file_not_found',404,'Original file was not found.');
   const operation:RetainedSourceOperation=action==='download'?'download':action==='complete'?'complete':action==='cancel'?'cancel':'upload';
   await access(request,context,operation,file!);
   if(file!.storageKey!==sourceFileOriginalObjectKey({...context.files.scope,fileId:fileId!})){
    if(bindings.legacy&&await bindings.legacy(request,response,{context,operation,file:file!}))return true;
    fail('original_legacy_driver_required',503,'This retained original requires its existing storage driver. Its location has been preserved.');
   }
   if(action==='upload-url'){
    intakeShape(request.body);if(request.body.creatorId!==undefined&&request.body.creatorId!==file!.creatorId||request.body.sizeBytes!==file!.sizeBytes||request.body.mimeType!==file!.mimeType||request.body.originalFilename!==file!.originalFilename||request.body.checksumSha256!==file!.checksumSha256)fail('upload_source_conflict',409,'Choose the same original file to retry this upload.');
    if(file!.uploadState!=='pending')fail('upload_not_pending',409,'Only pending originals can resume an upload.');
    await bindings.verifyStorage(request,context);json(response,201,await retainedSourceUploadDescriptor(request,context,file!));return true;
   }
   if(action==='local-upload'){
    if(incoming.headers['content-type']?.split(';')[0]!=='application/octet-stream')fail('invalid_upload_type',415,'The local original transfer requires application/octet-stream.');
    if(!file!.sizeBytes||file!.sizeBytes>maximumProxy)fail('direct_upload_required',413,'This original requires a direct storage upload.');
    if(incoming.headers['content-length']!==undefined&&Number(incoming.headers['content-length'])!==file!.sizeBytes)fail('upload_content_conflict',409,'Original transfer size differs from the prepared upload.');
    await context.uploads.accept({actorId:session.subject.id,fileId:fileId!,body:await bodyBytes(incoming,file!.sizeBytes!)});response.statusCode=204;response.end();return true;
   }
   if(action==='complete'){
    const result=await context.uploads.complete({actorId:session.subject.id,fileId:fileId!});
    if(result.state!=='completed')fail('original_recovery_pending',409,'Original bytes are retained and await authorized finalization.');
    json(response,200,result.file);return true;
   }
   if(action==='cancel'){
    if(!Number.isSafeInteger(request.body.expectedRevision))fail('invalid_input',400,'The current original revision is required.');
    const result=await context.uploads.cancel({actorId:session.subject.id,fileId:fileId!,expectedRevision:Number(request.body.expectedRevision)});json(response,200,{file:result.file,cleanup:result.state==='sealed'?'sealed':'retained',usagePending:result.usagePending});return true;
   }
   const object=await context.uploads.readPhysicalReceipt(fileId!);if(!object)fail('original_unavailable',409,'The completed original receipt is unavailable.');matchReceipt(file!,object!,context.bucket);
   if(context.delivery){const result=await context.delivery.issue({object:object!,expiresAt:new Date(Date.now()+60_000).toISOString(),disposition:'attachment'});json(response,200,{...result,filename:file!.originalFilename??file!.fileId});return true;}
   const stream=await context.storage.openReadStream({...object!,versionId:object!.versionId!});
   try{
    matchReceipt(file!,stream.object,context.bucket);if(stream.object.versionId!==object!.versionId)fail('original_unavailable',409,'Original stream version changed.');
    response.setHeader('Content-Type','application/octet-stream');response.setHeader('Content-Length',object!.byteLength);response.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file!.originalFilename??file!.fileId).replace(/['()*]/g,value=>'%'+value.charCodeAt(0).toString(16).toUpperCase())}`);
    await pipeline(Readable.from(stream.body),response);
   }finally{await stream.close();}
   return true;
  }catch(error){
   if(response.headersSent){response.destroy(error instanceof Error?error:undefined);return true;}
   if(error instanceof SourceFileUploadError||error instanceof SourceFileConflict||error instanceof RetainedRepositoryError||error instanceof SourceFileIntakeError){json(response,error.status,{code:error.code,message:error.message});return true;}
   const status=(error as {status?:unknown})?.status;
   if(typeof status==='number'&&[401,403,404,409,423,503].includes(status)){json(response,status,{code:status===401?'authentication_required':'original_access_unavailable',message:status===401?'A verified session is required.':'Original access is unavailable.'});return true;}
   if((error as {code?:string})?.code==='ENOENT'||(error as {name?:string})?.name==='NotFound'){json(response,409,{code:'original_bytes_missing',message:'Upload the original bytes before completing this file.'});return true;}
   throw error;
  }
 }};
}
