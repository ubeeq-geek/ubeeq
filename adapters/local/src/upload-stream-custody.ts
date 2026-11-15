import {createHash,randomUUID} from 'node:crypto';
import {constants,rmSync,realpathSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {open,mkdir,link,readFile,stat,realpath} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {requireCreatorScopedObject,type StoredObject,type UploadStreamAcceptance,type UploadCompletion,type UploadSealInput,type UploadSealResult} from '@ubeeq/storage';
import type {LocalSqliteDatabase} from './index.js';

type Session={id:string;object_payload:string;body:Uint8Array|null;cell_id:string;creator_id:string;expires_at:string;expected_checksum:string|null;expected_byte_length:number;operation:string};
type Custody={id:string;lease_id:string;lease_expires_at:number;state:'receiving'|'accepted';byte_length:number|null;checksum:string|null};
type Receipt={cell_id:string;creator_id:string;object_payload:string;state:'prepared'|'completed'};
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const missing=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==='ENOENT';
const same=(a:StoredObject,b:StoredObject)=>JSON.stringify([a.bucket,a.key,a.scope,a.contentType,a.byteLength,a.checksum,a.versionId])===JSON.stringify([b.bucket,b.key,b.scope,b.contentType,b.byteLength,b.checksum,b.versionId]);
/** Real Local provider custody. Existing upload/completion/seal rows remain the
 * capability and receipt authorities. No success or quota ledger is added. */
export class LocalUploadStreamCustody {
 private readonly leaseMilliseconds=60_000;
 private readonly root:string;
 constructor(private readonly local:LocalSqliteDatabase){this.root=realpathSync(resolve(local.configuration.dataDirectory));}
 private session(id:string){return this.local.database.prepare('SELECT * FROM ubeeq_uploads WHERE id=?').get(id) as Session|undefined;}
 private custody(id:string){return this.local.database.prepare('SELECT * FROM ubeeq_upload_stream_custody WHERE id=?').get(id) as Custody|undefined;}
 private receipt(input:UploadSealInput){
  const row=this.local.database.prepare('SELECT * FROM ubeeq_upload_completions WHERE id=?').get(input.uploadId) as Receipt|undefined;
  if(row&&(row.cell_id!==input.cellId||row.creator_id!==input.creatorId))throw Error('Upload completion scope does not match.');
  return row;
 }
 private scope(row:Session|undefined,input:UploadSealInput):Session{
  if(!row||row.cell_id!==input.cellId||row.creator_id!==input.creatorId||input.cellId!==this.local.configuration.cellId||row.operation!=='upload_content')throw Error('Upload scope does not match the authenticated creator and cell.');
  const object:StoredObject=JSON.parse(row.object_payload);requireCreatorScopedObject(object.key,input);
  if(typeof object.bucket!=='string'||!object.bucket.trim()||!['private','restricted','public'].includes(object.scope)||!Number.isFinite(Date.parse(row.expires_at))||!Number.isSafeInteger(row.expected_byte_length)||row.expected_byte_length<0||object.byteLength!==row.expected_byte_length||!object.contentType||(object.checksum??null)!==row.expected_checksum||row.expected_checksum!==null&&!/^[a-f0-9]{64}$/.test(row.expected_checksum))throw Error('Upload capability requires reconciliation.');
  return row;
 }
 private temporary(id:string,lease:string){
  if(!/^[a-f0-9-]{36}$/.test(lease))throw Error('Upload custody lease is invalid.');
  return resolve(this.root,'.upload-content',hash(id),lease);
 }
 private unlinkTemporary(id:string,lease:string){
  const path=this.temporary(id,lease);rmSync(path,{force:true});let fd:number|undefined;
  try{fd=openSync(resolve(path,'..'),constants.O_RDONLY);fsyncSync(fd);}catch(error){if(!missing(error))throw error;}finally{if(fd!==undefined)closeSync(fd);}
 }
 private objectPath(object:StoredObject){
  requireCreatorScopedObject(object.key,{cellId:this.local.configuration.cellId,creatorId:object.key.split('/')[3]??''});
  if(typeof object.bucket!=='string'||!object.bucket.trim()||!object.versionId||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(object.versionId))throw Error('An exact local upload version is required.');
  const objectsRoot=resolve(this.root,'objects'),root=resolve(objectsRoot,object.bucket),path=resolve(root,object.key,object.versionId);
  if(!root.startsWith(objectsRoot+'/'))throw Error('Upload bucket escapes its owned root.');
  if(relative(root,path).startsWith('..'))throw Error('Upload object escapes its owned root.');return path;
 }
 private async directory(path:string){await mkdir(path,{recursive:true,mode:0o700});if(await realpath(path)!==resolve(path))throw Error('Upload location contains an unsupported symlink.');}
 private async syncDirectory(path:string){const handle=await open(path,constants.O_RDONLY);try{await handle.sync();}finally{await handle.close();}}
 private active(input:UploadSealInput,lease:string){
  const session=this.scope(this.session(input.uploadId),input),custody=this.custody(input.uploadId);
  // Lease expiry permits a competing receiver to replace this token. It does
  // not impose another client idle timeout: the same still-owned token may
  // renew until the actual issued capability expires.
  if(Date.parse(session.expires_at)<=Date.now()||this.local.database.prepare('SELECT id FROM ubeeq_upload_seals WHERE id=?').get(input.uploadId)||this.receipt(input)||session.body||custody?.lease_id!==lease||custody.state!=='receiving')throw Error('Upload custody was closed, replaced or expired.');return {session,custody};
 }
 async acceptStream(input:UploadStreamAcceptance):Promise<void>{
  if(input.operation!=='upload_content'||!input.body||typeof input.body[Symbol.asyncIterator]!=='function')throw Error('An actual upload stream is required.');
  let old:Custody|undefined;
  const lease=randomUUID(),session=await this.local.transaction(async()=>{
   const row=this.scope(this.session(input.uploadId),input);old=this.custody(input.uploadId);
   if(Date.parse(row.expires_at)<=Date.now()||this.receipt(input)||this.local.database.prepare('SELECT id FROM ubeeq_upload_seals WHERE id=?').get(input.uploadId)||row.body||old?.state==='accepted'||old&&old.lease_expires_at>Date.now())throw Error('Upload is expired, received, sealed or currently receiving.');
   if(old)this.unlinkTemporary(input.uploadId,old.lease_id);
   this.local.database.prepare("INSERT INTO ubeeq_upload_stream_custody(id,lease_id,lease_expires_at,state) VALUES(?,?,?,'receiving') ON CONFLICT(id) DO UPDATE SET lease_id=excluded.lease_id,lease_expires_at=excluded.lease_expires_at,state='receiving',byte_length=NULL,checksum=NULL").run(input.uploadId,lease,Math.min(Date.parse(row.expires_at),Date.now()+this.leaseMilliseconds));return row;
  });
  const path=this.temporary(input.uploadId,lease);let accepted=false,handle:Awaited<ReturnType<typeof open>>|undefined;
  try{
   // The claim was committed first, so a crash retains a named cleanup target.
   // Serialize only allocation metadata with sealing; never hold this provider
   // transaction while receiving or hashing the body.
   await this.local.transaction(async()=>{this.active(input,lease);await this.directory(resolve(path,'..'));handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);});
   if(!handle)throw Error('Upload file allocation did not return its owned descriptor.');
   let size=0;const checksum=createHash('sha256');
   for await(const chunk of input.body){
    if(!(chunk instanceof Uint8Array)||chunk.byteLength>session.expected_byte_length-size)throw Error('Upload stream exceeds its admitted byte allowance.');
    // The durable lease is checked before every write. A replacement or seal
    // cannot later accept this descriptor, even if an old writer resumes.
    await this.local.transaction(async()=>{this.active(input,lease);this.local.database.prepare('UPDATE ubeeq_upload_stream_custody SET lease_expires_at=? WHERE id=? AND lease_id=?').run(Math.min(Date.parse(session.expires_at),Date.now()+this.leaseMilliseconds),input.uploadId,lease);});
    for(let offset=0;offset<chunk.byteLength;){const result=await handle.write(chunk,offset,Math.min(64*1024,chunk.byteLength-offset));if(!result.bytesWritten)throw Error('Upload file write made no progress.');offset+=result.bytesWritten;}
    size+=chunk.byteLength;checksum.update(chunk);
   }
   const digest=checksum.digest('hex');if(size!==session.expected_byte_length||session.expected_checksum!==null&&digest!==session.expected_checksum)throw Error('Upload stream does not match its precommitted size and checksum.');
   await handle.sync();await handle.close();handle=undefined;await this.syncDirectory(resolve(path,'..'));
   await this.local.transaction(async()=>{this.active(input,lease);this.local.database.prepare("UPDATE ubeeq_upload_stream_custody SET state='accepted',byte_length=?,checksum=? WHERE id=? AND lease_id=?").run(size,digest,input.uploadId,lease);});accepted=true;
  }finally{
   await handle?.close();
   if(!accepted){await this.local.transaction(async()=>{this.unlinkTemporary(input.uploadId,lease);this.local.database.prepare("DELETE FROM ubeeq_upload_stream_custody WHERE id=? AND lease_id=? AND state='receiving'").run(input.uploadId,lease);});}
  }
 }
 private async verify(path:string,object:StoredObject){
  if(await realpath(path)!==path)throw Error('Upload bytes contain an unsupported symlink.');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const info=await handle.stat();if(!info.isFile()||info.size!==object.byteLength)throw Error('Physical upload size requires reconciliation.');
   let size=0;const checksum=createHash('sha256');
   for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:64*1024})){size+=chunk.byteLength;if(size>object.byteLength)throw Error('Physical upload grew during verification.');checksum.update(chunk);}
   const after=await handle.stat();if(size!==object.byteLength||checksum.digest('hex')!==object.checksum||after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ino!==info.ino)throw Error('Physical upload checksum requires reconciliation.');
   return info;
  }finally{await handle.close();}
 }
 private evidence(input:UploadCompletion){
  const row=this.receipt(input);if(!row)return undefined;const object:StoredObject=JSON.parse(row.object_payload);this.objectPath(object);requireCreatorScopedObject(object.key,input);
  if(object.byteLength!==input.byteLength||object.checksum!==input.checksum||!['prepared','completed'].includes(row.state))throw Error('Upload completion evidence conflicts.');return {row,object};
 }
 private async metadata(path:string,object:StoredObject,writtenAt:string){
  const info=await stat(path+'.json');if(info.size>64*1024||await realpath(path+'.json')!==path+'.json')throw Error('Physical upload metadata requires reconciliation.');
  const value:StoredObject=JSON.parse(await readFile(path+'.json','utf8'));if(!same(value,object)||value.writtenAt!==writtenAt)throw Error('Physical upload metadata conflicts.');return value;
 }
 private currentPrepared(input:UploadCompletion,object:StoredObject){
  if(this.local.database.prepare('SELECT id FROM ubeeq_upload_seals WHERE id=?').get(input.uploadId))throw Error('Upload is permanently sealed.');
  const current=this.evidence(input);if(!current||!same(current.object,object))throw Error('The exact current upload completion receipt is required.');return current;
 }
 private async finish(input:UploadCompletion,object:StoredObject):Promise<StoredObject>{
  // Large SHA verification remains outside the SQLite writer window. Every
  // actual metadata write then joins the SAME BEGIN IMMEDIATE used by removal.
  const path=this.objectPath(object),info=await this.verify(path,object),writtenAt=info.mtime.toISOString(),completed={...object,writtenAt};
  if(object.writtenAt&&object.writtenAt!==writtenAt)throw Error('Physical upload write time requires reconciliation.');
  return this.local.transaction(async()=>{
   const current=this.currentPrepared(input,object);
   if(current.row.state==='completed'){
    // Another genuine finalizer won while this reader hashed. Completed state
    // permits read-only recovery, never recreation of a missing sidecar.
    if(current.object.writtenAt!==writtenAt)throw Error('Physical upload write time requires reconciliation.');await this.metadata(path,current.object,writtenAt);return current.object;
   }
   if(await realpath(path)!==path)throw Error('The prepared final version path changed.');
   const held=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    const actual=await held.stat();if(!actual.isFile()||actual.dev!==info.dev||actual.ino!==info.ino||actual.size!==info.size||actual.mtimeMs!==info.mtimeMs)throw Error('The prepared final version changed after exact verification.');
    let metadataHandle:Awaited<ReturnType<typeof open>>|undefined;try{metadataHandle=await open(path+'.json',constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await metadataHandle.writeFile(JSON.stringify(completed));await metadataHandle.sync();}catch(error){if((error as NodeJS.ErrnoException)?.code!=='EEXIST')throw error;}finally{await metadataHandle?.close();}
    await this.metadata(path,object,writtenAt);await this.syncDirectory(resolve(path,'..'));
    const custody=this.custody(input.uploadId);if(custody)this.unlinkTemporary(input.uploadId,custody.lease_id);
    this.local.database.prepare("UPDATE ubeeq_upload_completions SET state='completed',object_payload=? WHERE id=? AND cell_id=? AND creator_id=?").run(JSON.stringify(completed),input.uploadId,input.cellId,input.creatorId);
    this.local.database.prepare('DELETE FROM ubeeq_upload_stream_custody WHERE id=?').run(input.uploadId);this.local.database.prepare('DELETE FROM ubeeq_uploads WHERE id=? AND cell_id=? AND creator_id=?').run(input.uploadId,input.cellId,input.creatorId);return completed;
   }finally{await held.close();}
  });
 }
 private async verifyCompleted(object:StoredObject):Promise<StoredObject>{
  // Read-only physical recovery is the sole completed-success path. A receipt
  // never authorizes reconstruction of purged bytes or a missing sidecar.
  const path=this.objectPath(object),info=await this.verify(path,object),writtenAt=info.mtime.toISOString();
  if(object.writtenAt!==writtenAt)throw Error('Physical upload write time requires reconciliation.');
  await this.metadata(path,object,writtenAt);return object;
 }
 private async completedWinner(input:UploadCompletion):Promise<StoredObject|undefined>{
  const saved=await this.local.transaction(async()=>{
   if(this.local.database.prepare('SELECT id FROM ubeeq_upload_seals WHERE id=?').get(input.uploadId))return undefined;
   const current=this.evidence(input);return current?.row.state==='completed'?current.object:undefined;
  });
  return saved?this.verifyCompleted(saved):undefined;
 }
 async recoverCompletion(input:UploadCompletion):Promise<StoredObject|undefined>{
  const saved=await this.local.transaction(async()=>this.evidence(input));if(!saved)return undefined;
  if(saved.row.state==='completed')return this.verifyCompleted(saved.object);
  try{return await this.finish(input,saved.object);}catch(error){
   const winner=await this.completedWinner(input);if(winner)return winner;
   if(missing(error)&&saved.row.state==='prepared')return undefined;throw error;
  }
 }
 private async stageLegacy(input:UploadCompletion,object:StoredObject):Promise<Custody>{
  // Old accepted BLOBs move through the SAME existing file-custody row. The BLOB
  // stays authoritative until the staged file is fsynced and its lease accepted;
  // no anonymous temporary link or second upload/receipt authority is added.
  const lease=randomUUID();let previous:Custody|undefined;
  let body:Uint8Array;
  for(;;){
   const decision=await this.local.transaction<{kind:'claimed';body:Uint8Array}|{kind:'accepted';custody:Custody}|{kind:'receiving'}>(async()=>{
    const current=this.currentPrepared(input,object);if(current.row.state!=='prepared')throw Error('Upload content has already completed.');
    const row=this.scope(this.session(input.uploadId),input);previous=this.custody(input.uploadId);
    if(previous?.state==='accepted'){
     if(previous.byte_length!==object.byteLength||previous.checksum!==object.checksum)throw Error('Accepted legacy upload custody conflicts.');return {kind:'accepted',custody:previous};
    }
    if(!row.body)throw Error('Legacy upload content is unavailable.');
    // Another genuine finalizer owns the existing durable staging lease. Wait
    // outside SQLite/FS writers for its actual accepted bytes or completion;
    // neither a receiving lease nor prepared receipt is successful completion.
    if(previous&&previous.lease_expires_at>Date.now())return {kind:'receiving'};
    if(previous)this.unlinkTemporary(input.uploadId,previous.lease_id);
    this.local.database.prepare("INSERT INTO ubeeq_upload_stream_custody(id,lease_id,lease_expires_at,state) VALUES(?,?,?,'receiving') ON CONFLICT(id) DO UPDATE SET lease_id=excluded.lease_id,lease_expires_at=excluded.lease_expires_at,state='receiving',byte_length=NULL,checksum=NULL").run(input.uploadId,lease,Date.now()+this.leaseMilliseconds);return {kind:'claimed',body:row.body};
   });
   if(decision.kind==='accepted')return decision.custody;
   if(decision.kind==='receiving'){await delay(10);continue;}
   body=decision.body;break;
  }
  const path=this.temporary(input.uploadId,lease);let accepted=false,handle:Awaited<ReturnType<typeof open>>|undefined;
  try{
   if(body.byteLength!==object.byteLength||hash(body)!==object.checksum)throw Error('Legacy upload body requires reconciliation.');
   await this.directory(resolve(path,'..'));handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   for(let offset=0;offset<body.byteLength;){await this.local.transaction(async()=>{const current=this.currentPrepared(input,object),custody=this.custody(input.uploadId);if(current.row.state!=='prepared'||custody?.lease_id!==lease||custody.state!=='receiving')throw Error('Legacy upload staging was finalized, sealed or replaced.');this.local.database.prepare('UPDATE ubeeq_upload_stream_custody SET lease_expires_at=? WHERE id=? AND lease_id=?').run(Date.now()+this.leaseMilliseconds,input.uploadId,lease);});const result=await handle.write(body,offset,Math.min(1024*1024,body.byteLength-offset));if(!result.bytesWritten)throw Error('Legacy staging write made no progress.');offset+=result.bytesWritten;}
   await handle.sync();await handle.close();handle=undefined;await this.syncDirectory(resolve(path,'..'));
   const result=await this.local.transaction(async()=>{const current=this.currentPrepared(input,object),custody=this.custody(input.uploadId);if(current.row.state!=='prepared'||custody?.lease_id!==lease||custody.state!=='receiving')throw Error('Legacy upload staging was finalized, sealed or replaced.');this.local.database.prepare("UPDATE ubeeq_upload_stream_custody SET state='accepted',byte_length=?,checksum=? WHERE id=? AND lease_id=?").run(object.byteLength,object.checksum!,input.uploadId,lease);this.local.database.prepare('UPDATE ubeeq_uploads SET body=NULL WHERE id=? AND cell_id=? AND creator_id=?').run(input.uploadId,input.cellId,input.creatorId);return this.custody(input.uploadId)!;});accepted=true;return result;
  }finally{await handle?.close();if(!accepted)await this.local.transaction(async()=>{this.unlinkTemporary(input.uploadId,lease);this.local.database.prepare("DELETE FROM ubeeq_upload_stream_custody WHERE id=? AND lease_id=? AND state='receiving'").run(input.uploadId,lease);});}
 }
 async complete(input:UploadCompletion):Promise<StoredObject>{
  const existing=await this.local.transaction(async()=>this.evidence(input));if(existing?.row.state==='completed')throw Error('Upload content has already completed; recover its receipt instead.');
  try{
   let custody:Custody|undefined;
   const object=await this.local.transaction(async()=>{
    const row=this.scope(this.session(input.uploadId),input);custody=this.custody(input.uploadId);
    if(this.local.database.prepare('SELECT id FROM ubeeq_upload_seals WHERE id=?').get(input.uploadId)||row.expected_byte_length!==input.byteLength||row.expected_checksum!==null&&row.expected_checksum!==input.checksum||!row.body&&custody?.state!=='accepted')throw Error('Upload content has not been received or conflicts.');
    if(custody?.state==='accepted'&&(custody.byte_length!==input.byteLength||custody.checksum!==input.checksum))throw Error('Accepted upload custody conflicts.');
    const {writtenAt:_untrusted,...requested}=JSON.parse(row.object_payload) as StoredObject;const object={...requested,versionId:`upload-${input.uploadId}`,checksum:input.checksum,byteLength:input.byteLength};
    this.local.database.prepare("INSERT OR IGNORE INTO ubeeq_upload_completions(id,cell_id,creator_id,object_payload,state) VALUES(?,?,?,?,'prepared')").run(input.uploadId,input.cellId,input.creatorId,JSON.stringify(object));const saved=this.evidence(input);if(!saved||!same(saved.object,object))throw Error('Upload completion intent conflicts.');return object;
   });
   if(custody?.state!=='accepted')custody=await this.stageLegacy(input,object);
   const source=this.temporary(input.uploadId,custody.lease_id);await this.verify(source,object);
   const path=this.objectPath(object);await this.directory(resolve(path,'..'));
   // Both hard-link publication and sidecar finalization are fenced with removal
   // on the actual SQLite writer, including a different Local connection.
   await this.local.transaction(async()=>{
    const current=this.currentPrepared(input,object);if(current.row.state!=='prepared')throw Error('Upload content has already completed.');const actual=this.custody(input.uploadId);
    if(!actual||actual.lease_id!==custody!.lease_id||actual.state!=='accepted'||actual.byte_length!==object.byteLength||actual.checksum!==object.checksum)throw Error('The prepared upload custody was replaced.');
    try{await link(source,path);}catch(error){if((error as NodeJS.ErrnoException)?.code!=='EEXIST')throw error;}
   });
   return await this.finish(input,object);
  }catch(error){
   // This call was admitted before completion. A competing finalizer may have
   // consumed its session/temp/custody while it was outside the writer. Only a
   // current matching COMPLETED receipt is eligible for read-only recovery;
   // prepared/receiving state, permanent seals and missing bytes never succeed.
   const winner=await this.completedWinner(input);if(winner)return winner;
   throw error;
  }
 }
 async abort(input:UploadSealInput):Promise<void>{
  await this.local.transaction(async()=>{const receipt=this.local.database.prepare('SELECT * FROM ubeeq_upload_completions WHERE id=?').get(input.uploadId) as Receipt|undefined;if(receipt){if(receipt.cell_id!==input.cellId||receipt.creator_id!==input.creatorId||receipt.state==='completed')return;throw Error('A prepared physical upload requires reconciliation before abort.');}const session=this.session(input.uploadId);if(!session||session.cell_id!==input.cellId||session.creator_id!==input.creatorId)return;this.scope(session,input);const custody=this.custody(input.uploadId);if(custody)this.unlinkTemporary(input.uploadId,custody.lease_id);this.local.database.prepare('DELETE FROM ubeeq_upload_stream_custody WHERE id=?').run(input.uploadId);this.local.database.prepare('DELETE FROM ubeeq_uploads WHERE id=?').run(input.uploadId);});
 }
 async seal(input:UploadSealInput):Promise<UploadSealResult>{
  if(input.cellId!==this.local.configuration.cellId)throw Error('Upload seal is not scoped to this cell.');
  const decision=await this.local.transaction<{state:'sealed';proofId:string;closedAt:string}|{completion:UploadCompletion}>(async()=>{
   const seal=this.local.database.prepare('SELECT * FROM ubeeq_upload_seals WHERE id=?').get(input.uploadId) as {cell_id:string;creator_id:string;proof_id:string;closed_at:string}|undefined;
   if(seal){if(seal.cell_id!==input.cellId||seal.creator_id!==input.creatorId)throw Error('Upload seal scope does not match.');return {state:'sealed' as const,proofId:seal.proof_id,closedAt:seal.closed_at};}
   const receipt=this.receipt(input);if(receipt){const object:StoredObject=JSON.parse(receipt.object_payload);return {completion:{...input,checksum:object.checksum!,byteLength:object.byteLength}};}
   const row=this.scope(this.session(input.uploadId),input),custody=this.custody(input.uploadId);
   if(row.body||custody?.state==='accepted')return {completion:{...input,checksum:row.body?hash(row.body):custody!.checksum!,byteLength:row.expected_byte_length}};
   const closedAt=now(),proofId=hash(JSON.stringify([input.cellId,input.creatorId,input.uploadId,closedAt]));if(custody)this.unlinkTemporary(input.uploadId,custody.lease_id);
   this.local.database.prepare('INSERT INTO ubeeq_upload_seals(id,cell_id,creator_id,proof_id,closed_at) VALUES(?,?,?,?,?)').run(input.uploadId,input.cellId,input.creatorId,proofId,closedAt);
   this.local.database.prepare('DELETE FROM ubeeq_upload_stream_custody WHERE id=?').run(input.uploadId);this.local.database.prepare('DELETE FROM ubeeq_uploads WHERE id=?').run(input.uploadId);return {state:'sealed' as const,proofId,closedAt};
  });
  if('completion' in decision){const object=await this.recoverCompletion(decision.completion)??await this.complete(decision.completion);return {state:'completed',object};}return decision;
 }
}
