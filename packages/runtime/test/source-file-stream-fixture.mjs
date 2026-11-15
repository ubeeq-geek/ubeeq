import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,realpath,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {inspectStoredObjectStream} from '@ubeeq/storage';
import {RepositoryRetainedSourceFiles} from '../dist/retained-source-files.js';
import {createRetainedRepositoryCreator} from '../dist/retained-repository-store.js';
import {SourceFileUploads,SourceFileUploadError} from '../dist/source-file-uploads.js';
import {createRetainedSourceFileNodeHandler} from '../dist/retained-source-http.js';

/** Real Local provider/identity/HTTP fixture. Quota is a truthful journal-port
 * unit model; it is not a claim of cloud quota or provider acceptance. */
export async function sourceFileStreamFixture(t,{maximumUploadBytes=130*1024*1024,maximumProxyUploadBytes=maximumUploadBytes,localMode=true}={}){
 const directory=await mkdtemp(join(tmpdir(),'source-stream-http-')),configuration={databasePath:join(directory,'local.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'},scope={instanceId:'instance',tenantId:'tenant',creatorId:'creator',cellId:'cell',region:'ca-central-1'};
 let local=createLocalAdapterSet(configuration),files,uploads,server,finalizerFailure=false;
 const credentials={email:'actual-owner@source-stream.test',password:'Actual stream owner password 123!'},account=await local.identity.register(credentials),signed=await local.identity.authenticate(credentials);
 const home={homeCellId:'cell',dataHomeRegion:scope.region,dataHomeAssignedAt:new Date().toISOString(),routingRevision:1};
 await local.repositories.transaction(tx=>createRetainedRepositoryCreator(local.repositories,{id:'creator',instanceId:scope.instanceId,subjectId:account.subjectId,handle:'stream-creator',displayName:'Stream Creator',...home},scope.tenantId,tx));
 const reservations=new Map(),settlements=new Map(),closures=new Map(),quota={
  async checkAndReserveQuota(input){assert.equal(files.transaction(),undefined);const before=reservations.get(input.idempotencyKey);if(before)assert.deepEqual(before,input);reservations.set(input.idempotencyKey,structuredClone(input));return {allowed:!closures.has(input.idempotencyKey)};},
  async recordUsageSettlement(input){assert.equal(closures.has(input.idempotencyKey),false);assert.ok(reservations.has(input.idempotencyKey));const before=settlements.get(input.idempotencyKey);if(before)assert.deepEqual(before,input);settlements.set(input.idempotencyKey,structuredClone(input));},
  async closeStorageReservation(input){assert.equal(settlements.has(input.idempotencyKey),false);const before=closures.get(input.idempotencyKey);if(before)assert.deepEqual(before,input);closures.set(input.idempotencyKey,structuredClone(input));}
 };
 const boot=async()=>{
  class Files extends RepositoryRetainedSourceFiles {async getCreatorById(id){const row=await local.repositories.creators.get(id);return row?{...row,creatorId:row.id,name:row.displayName,status:'active'}:null;}}
  files=new Files(local.repositories,scope,{resolveSourceAccess:async(actor,creator,transaction)=>{const [current,subject]=await Promise.all([local.identity.getAccount(actor),local.identity.getAuthorizationSubject(actor)]);if(current?.status!=='active'||subject?.accountScope!=='creator_operator'||creator.subjectId!==actor)return null;await local.repositories.creators.checkRevision(creator.id,creator.revision,{transaction});return {actorUserId:actor,isAdmin:false,expectedRole:null,expectedMember:null,expectedOwner:creator};},validateAssetAttachment:async()=>{throw Error('This source-only fixture has no Work attachment commands.');}});
  local.storage.get=async()=>{throw Error('Whole-object reads are forbidden for streamed originals.');};
  uploads=new SourceFileUploads({repositories:local.repositories,uploads:local.storage,quota,files,bucket:'cell',prepareCompletion:async(file,object)=>{if(finalizerFailure)throw new SourceFileUploadError('decoder_unavailable',503,'Actual finalization is temporarily unavailable.');const verified=await inspectStoredObjectStream(local.storage,object,maximumUploadBytes);return {...verified,metadata:{...file.metadata,streamVerified:true}};}});
  const context={files,uploads,storage:local.storage,bucket:'cell',maximumUploadBytes,...(localMode?{localMediaDirectory:directory}:{}),file:value=>({...value,opaque:{retained:['full','source','JSON']}})};
  const handler=createRetainedSourceFileNodeHandler({maximumProxyUploadBytes,resolve:async(_request,target)=>{if('creatorId'in target&&target.creatorId!==scope.creatorId)throw new SourceFileUploadError('creator_not_found',404,'Creator not found.');if('fileId'in target&&!await files.getSourceFileById(target.fileId))throw new SourceFileUploadError('file_not_found',404,'Source not found.');return context;},listCreators:async()=>[context],verifyStorage:async()=>{const root=await realpath(directory),info=await stat(root);assert.equal(info.isDirectory(),true);assert.equal(info.mode&0o077,0);assert.equal(await realpath(local.database.configuration.dataDirectory),root);assert.equal(context.bucket,local.database.configuration.cellId);},checkAccess:async(_request,{operation})=>{const holds=(await local.repositories.moderationHolds.list({limit:100})).items;if(operation!=='cancel'&&holds.some(hold=>hold.state==='active'&&hold.subjectId===scope.creatorId))throw new SourceFileUploadError('safety_hold',423,'A current hold blocks this operation.');}},async incoming=>{const token=/^Bearer (.+)$/.exec(incoming.headers.authorization??'')?.[1],session=token?await local.identity.verifySession({credential:token}):undefined;if(!session)throw new SourceFileUploadError('authentication_required',401,'A current actual Local session is required.');return session;},{publicBaseUrl:configuration.publicBaseUrl});
  server=createServer((req,res)=>{void handler.handle(req,res).then(handled=>{if(!handled){res.statusCode=404;res.end();}}).catch(error=>{if(res.headersSent){res.destroy(error);return;}res.statusCode=503;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:error.message}));});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 };
 await boot();const stop=()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));t.after(async()=>{await stop();local.database.close();await rm(directory,{recursive:true,force:true});});
 const request=async(path,{method='GET',body,stream,headers={},token=signed.token}={})=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body===undefined||body instanceof Uint8Array?{}:{'content-type':'application/json'}),...headers},...(stream?{body:Readable.toWeb(Readable.from(stream)),duplex:'half'}:body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})});const bytes=Buffer.from(await response.arrayBuffer());let value;try{value=JSON.parse(bytes);}catch{}return {status:response.status,body:value,bytes};};
 return {directory,account,scope,reservations,settlements,closures,request,get origin(){return 'http://127.0.0.1:'+server.address().port;},token:signed.token,get local(){return local;},get files(){return files;},get uploads(){return uploads;},setFinalizerFailure(value){finalizerFailure=value;},async restart(){await stop();local.database.close();local=createLocalAdapterSet(configuration);await boot();},async revoke(){local.database.database.prepare("UPDATE ubeeq_accounts SET status='closed' WHERE id=?").run(account.subjectId);}};
}
