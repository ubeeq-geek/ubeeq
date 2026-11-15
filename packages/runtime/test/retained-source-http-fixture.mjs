import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {inspectStoredObjectStream} from '@ubeeq/storage';
import {defaultContentPreparation} from '@ubeeq/core';
import {createCoreRuntime} from '../dist/index.js';
import {ContentWorkflowService,ContentPreparationError} from '../dist/content-preparations.js';
import {createRetainedRepositoryCreator} from '../dist/retained-repository-store.js';
import {RepositoryRetainedSourceFiles} from '../dist/retained-source-files.js';
import {SourceFileUploads,SourceFileUploadError} from '../dist/source-file-uploads.js';
import {prepareRetainedSourceFile,retainedSourceUploadDescriptor} from '../dist/retained-source-http.js';
const unavailable=()=>{throw new ContentPreparationError('unsupported_operation','This upload fixture has no decoder or publishing provider.',503);};
export async function retainedSourceHttpFixture(t,selectedRepositories){
 const directory=await mkdtemp(join(tmpdir(),'retained-source-http-')),configuration={databasePath:join(directory,'data.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'};
 let local=createLocalAdapterSet(configuration),repositories=selectedRepositories??local.repositories,runtime,files,uploads,context,readyFailure=false;
 const credentials={email:'owner@source-http.test',password:'Synthetic original HTTP password 123!'},account=await local.identity.register(credentials),signed=await local.identity.authenticate(credentials);
 const buyer=await local.identity.register({email:'buyer@source-http.test',password:credentials.password});local.database.database.prepare('UPDATE ubeeq_accounts SET account_scope = ?, roles_json = ? WHERE id = ?').run('customer_account','["customer_account"]',buyer.subjectId);const buyerSession=await local.identity.authenticate({email:'buyer@source-http.test',password:credentials.password});
 const scope={instanceId:'instance',tenantId:'tenant',creatorId:'creator',cellId:'cell',region:'ca-central-1'};
 await repositories.transaction(tx=>createRetainedRepositoryCreator(repositories,{id:'creator',instanceId:'instance',subjectId:account.subjectId,handle:'creator',displayName:'Creator',homeCellId:'cell',dataHomeRegion:scope.region,dataHomeAssignedAt:new Date().toISOString(),routingRevision:1},scope.tenantId,tx));
 const reservations=new Map(),settlements=new Map(),closed=new Map();
 const quota={async checkAndReserveQuota(input){assert.equal(files.transaction(),undefined,'physical quota must run after the stage transaction');const before=reservations.get(input.idempotencyKey);if(before)assert.deepEqual(before,input);reservations.set(input.idempotencyKey,structuredClone(input));return {allowed:!closed.has(input.idempotencyKey)};},async recordUsageSettlement(input){assert.ok(reservations.has(input.idempotencyKey));const before=settlements.get(input.idempotencyKey);if(before)assert.deepEqual(before,input);settlements.set(input.idempotencyKey,structuredClone(input));},async closeStorageReservation(input){assert.equal(settlements.has(input.idempotencyKey),false);const before=closed.get(input.idempotencyKey);if(before)assert.deepEqual(before,input);closed.set(input.idempotencyKey,structuredClone(input));}};
 const boot=async()=>{
  class SourceStore extends RepositoryRetainedSourceFiles{
   async getCreatorById(id){const row=await repositories.creators.get(id);return row?{...row,creatorId:row.id,name:row.displayName,status:'active'}:null;}
   async getAnnouncementOrchestration(_scope,kind,id){return await this.getRetainedEntity('announcement-'+kind,id)??null;}
  }
  files=new SourceStore(repositories,scope,{resolveSourceAccess:async(actor,creator,transaction)=>{
   const current=await local.identity.getAccount(actor),subject=await local.identity.getAuthorizationSubject(actor);if(current?.status!=='active'||subject?.accountScope!=='creator_operator'||creator.subjectId!==actor)return null;
   await repositories.creators.checkRevision(creator.id,creator.revision,{transaction});return {actorUserId:actor,isAdmin:false,expectedRole:null,expectedMember:null,expectedOwner:creator};
  },validateAssetAttachment:unavailable});
  const rawGet=local.storage.get.bind(local.storage);local.storage.get=async()=>{throw Error('Original HTTP/finalization must stream; whole-object get is forbidden in this fixture.');};
  uploads=new SourceFileUploads({repositories,uploads:local.storage,files,quota,bucket:'cell',prepareCompletion:async(file,object)=>{if(file.mimeType.startsWith('image/')||readyFailure)throw new SourceFileUploadError('decoder_unavailable',503,'An actual original decoder is required.');return {...await inspectStoredObjectStream(local.storage,object,16*1024*1024),metadata:{...file.metadata,verifiedOriginal:true}};}});
  context={files,uploads,storage:local.storage,bucket:'cell',maximumUploadBytes:16*1024*1024,file:value=>({...value,opaque:{retained:true}})};
  const sourceBindings={resolve:async(_request,target)=>{if('creatorId'in target&&target.creatorId!=='creator')throw new SourceFileUploadError('creator_not_found',404,'Creator not found.');if('fileId'in target&&!await files.getSourceFileById(target.fileId))throw new SourceFileUploadError('file_not_found',404,'Original not found.');return context;},listCreators:async()=>[context],verifyStorage:async()=>{assert.equal((await stat(directory)).mode&0o077,0,'actual local storage root is private');},checkAccess:async(_request,{operation})=>{const rows=(await repositories.moderationHolds.list({limit:100})).items;if(operation!=='cancel'&&rows.some(row=>row.subjectId==='creator'&&row.state==='active'))throw new SourceFileUploadError('safety_hold',423,'A current Creator hold blocks this original operation.');}};
  const host=actor=>({authorizeCreator:id=>id==='creator'?files.authorizeActor(actor):Promise.resolve(false),canManageCollections:id=>id==='creator'?files.authorizeActor(actor,'manage'):Promise.resolve(false),recoveryAuthorization:host,defaultSettings:()=>({...defaultContentPreparation(),access:'private'}),inspectOriginal:async file=>{const object=await uploads.readPhysicalReceipt(file.fileId);assert.ok(object);return (await inspectStoredObjectStream(local.storage,object,context.maximumUploadBytes)).checksumSha256;},captureSetup:unavailable,contentMetadataWork:unavailable,validateCollectionVolumes:unavailable,resolvedCollectionMembers:unavailable,recordImageCompatibility:unavailable});
  runtime=createCoreRuntime({instanceId:scope.instanceId,cellId:scope.cellId,region:scope.region,publicBaseUrl:'http://localhost',adapters:{repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity},contentPreparation:()=>({sourceFiles:sourceBindings,access:(request,_response,id)=>host(request.session.subject.id).authorizeCreator(id),createService:request=>new ContentWorkflowService(files,{tenantId:scope.tenantId},host(request.session.subject.id)),createRelease:unavailable,enabled:()=>true,durableDrafts:()=>true,offerings:async()=>[],announcementDestinations:async()=>[],destinations:async()=>[],managementUrl:()=>'/works',prepareUpload:(request,_creator,fileId)=>prepareRetainedSourceFile(request,context,request.body.upload,fileId),uploadDescriptor:async(file,request)=>{assert.equal(files.transaction(),undefined);const persisted=await files.getSourceFileById(file.fileId);assert.deepEqual(persisted,file);return retainedSourceUploadDescriptor(request,context,file);},runNextJob:async()=>{const count=await uploads.repair();return count?{originals:count}:undefined;}})});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  return rawGet;
 };
 t.after(async()=>{await runtime?.close();local.database.close();await rm(directory,{recursive:true,force:true});});await boot();
 const request=async(path,{method='GET',body,token=signed.token,headers={}}={})=>{
  const response=await fetch('http://127.0.0.1:'+runtime.server.address().port+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body===undefined||body instanceof Uint8Array?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})});
  const bytes=Buffer.from(await response.arrayBuffer());let value;try{value=JSON.parse(bytes);}catch{}return {status:response.status,body:value,bytes,headers:response.headers};
 };
 return {request,scope,account,settlements,closed,get repositories(){return repositories;},get local(){return local;},get files(){return files;},get uploads(){return uploads;},get runtime(){return runtime;},buyerToken:buyerSession.token,setFinalizerFailure:value=>{readyFailure=value;},async restart(){await runtime.close();local.database.close();local=createLocalAdapterSet(configuration);if(!selectedRepositories)repositories=local.repositories;await boot();}};
}
