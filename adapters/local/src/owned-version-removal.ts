import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fsyncSync,fstatSync,readFileSync,realpathSync,lstatSync,rmSync,createReadStream} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {ownedVersionFingerprint,validateOwnedVersionAbsence,type OwnedVersionRemovalRequest,type OwnedVersionAbsenceProof,type StoredObject} from '@ubeeq/storage';
import type {LocalSqliteDatabase} from './index.js';
interface Removal {target:string;uploadId:string;object:StoredObject;closedAt:string;sealProofId:string;phase:'fenced'|'absent';proof?:OwnedVersionAbsenceProof;}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const absent=(path:string):boolean=>{try{lstatSync(path);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}};
const same=(a:StoredObject,b:StoredObject)=>['bucket','key','versionId','contentType','byteLength','checksum','scope','writtenAt'].every(key=>a[key as keyof StoredObject]===b[key as keyof StoredObject]);
/** Genuine Local provider intent, permanent upload seal and exact physical
 * absence. Original completion receipts remain historical evidence; a replay
 * cannot recreate the removed version through the old upload capability. */
export async function removeOwnedLocalVersion(local:LocalSqliteDatabase,input:OwnedVersionRemovalRequest):Promise<OwnedVersionAbsenceProof>{
 local.assertOutsideProviderTransaction();
 const target=ownedVersionFingerprint(input),object=input.object;
 if(input.cellId!==local.configuration.cellId||!object.bucket||Buffer.byteLength(object.bucket)>255||/[\\/\r\n\u0000]/.test(object.bucket)||['.','..'].includes(object.bucket)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(object.versionId!))throw Error('Removal is outside the actual configured Local cell or immutable version.');
 const root=realpathSync(resolve(local.configuration.dataDirectory,'objects',object.bucket)),path=resolve(root,object.key,object.versionId!),parent=dirname(path);
 if(!path.startsWith(root+'/')||realpathSync(parent)!==parent)throw Error('Owned removal escapes the actual Local object directory.');
 local.database.exec("CREATE TABLE IF NOT EXISTS ubeeq_owned_version_removals(target TEXT PRIMARY KEY,cell_id TEXT NOT NULL,creator_id TEXT NOT NULL,payload TEXT NOT NULL)");
 const read=():Removal|undefined=>{const row=local.database.prepare('SELECT cell_id,creator_id,payload FROM ubeeq_owned_version_removals WHERE target=?').get(target) as {cell_id:string;creator_id:string;payload:string}|undefined;if(!row)return;if(row.cell_id!==input.cellId||row.creator_id!==input.creatorId)throw Error('Local removal scope changed.');const saved=JSON.parse(row.payload) as Removal;if(saved.target!==target||saved.uploadId!==input.upload.uploadId||!same(saved.object,object)||!['fenced','absent'].includes(saved.phase))throw Error('Local owned removal requires reconciliation.');return saved;};
 let saved=read();
 if(!saved){
  saved=local.transactionSync(()=>{
   const previous=read();if(previous)return previous;
   const receipt=local.database.prepare('SELECT cell_id,creator_id,object_payload,state FROM ubeeq_upload_completions WHERE id=?').get(input.upload.uploadId) as {cell_id:string;creator_id:string;object_payload:string;state:string}|undefined;
   if(!receipt||receipt.cell_id!==input.cellId||receipt.creator_id!==input.creatorId||receipt.state!=='completed'||!same(JSON.parse(receipt.object_payload) as StoredObject,object))throw Error('An actual matching completed Local upload receipt is required before removal.');
   const closedAt=new Date().toISOString(),sealProofId=hash([target,input.upload.uploadId,'owned-version-removal',closedAt]);
   const existing=local.database.prepare('SELECT cell_id,creator_id,proof_id,closed_at FROM ubeeq_upload_seals WHERE id=?').get(input.upload.uploadId) as {cell_id:string;creator_id:string;proof_id:string;closed_at:string}|undefined;
   if(existing)throw Error('A foreign prior upload seal requires reconciliation before owned removal.');
   local.database.prepare('INSERT INTO ubeeq_upload_seals(id,cell_id,creator_id,proof_id,closed_at) VALUES(?,?,?,?,?)').run(input.upload.uploadId,input.cellId,input.creatorId,sealProofId,closedAt);
   const value:Removal={target,uploadId:input.upload.uploadId,object:structuredClone(object),closedAt,sealProofId,phase:'fenced'};local.database.prepare('INSERT INTO ubeeq_owned_version_removals(target,cell_id,creator_id,payload) VALUES(?,?,?,?)').run(target,input.cellId,input.creatorId,JSON.stringify(value));return value;
  });
 }
 const seal=local.database.prepare('SELECT cell_id,creator_id,proof_id,closed_at FROM ubeeq_upload_seals WHERE id=?').get(saved.uploadId) as {cell_id:string;creator_id:string;proof_id:string;closed_at:string}|undefined;
 if(!seal||seal.cell_id!==input.cellId||seal.creator_id!==input.creatorId||seal.proof_id!==saved.sealProofId||seal.closed_at!==saved.closedAt)throw Error('The actual permanent Local upload fence disappeared.');
 // Crash-safe retry may observe one deletion already done; no all-version sweep.
 if(!absent(path)){
  if(realpathSync(path)!==path)throw Error('The owned Local content path changed.');
  const descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let witness:ReturnType<typeof fstatSync>;
  try{witness=fstatSync(descriptor);if(!witness.isFile()||witness.nlink!==1||witness.size!==object.byteLength)throw Error('The owned Local content size changed.');const digest=createHash('sha256');let size=0;for await(const chunk of createReadStream(path,{fd:descriptor,autoClose:false})){size+=chunk.byteLength;if(size>object.byteLength)throw Error('The owned Local version exceeded its exact receipt.');digest.update(chunk);}if(size!==object.byteLength||digest.digest('hex')!==object.checksum)throw Error('The owned Local bytes changed.');const named=lstatSync(path);if(named.dev!==witness.dev||named.ino!==witness.ino||named.mtimeMs!==witness.mtimeMs||named.size!==witness.size)throw Error('The owned Local content was replaced during verification.');rmSync(path);}finally{closeSync(descriptor);}
 }
 if(!absent(path+'.json')){if(realpathSync(path+'.json')!==path+'.json'||!same(JSON.parse(readFileSync(path+'.json','utf8')) as StoredObject,object))throw Error('The owned Local metadata path changed.');rmSync(path+'.json');}
 const directory=openSync(parent,constants.O_RDONLY);try{fsyncSync(directory);}finally{closeSync(directory);}
 if(!absent(path)||!absent(path+'.json'))throw Error('The exact Local content/metadata version is still present.');
 if(saved.proof){validateOwnedVersionAbsence(input,saved.proof);return saved.proof;}
 const observedAt=new Date().toISOString(),proof:OwnedVersionAbsenceProof={schemaVersion:1,state:'absent',targetFingerprint:target,proofId:hash([target,saved.sealProofId,'actual-fs-absence',observedAt]),observedAt,fence:{kind:'local-upload-seal',uploadId:saved.uploadId,proofId:saved.sealProofId,closedAt:saved.closedAt}};validateOwnedVersionAbsence(input,proof);
 return local.transactionSync(()=>{const current=read();if(!current)throw Error('The durable Local removal intent disappeared.');if(current.proof){validateOwnedVersionAbsence(input,current.proof);return current.proof;}local.database.prepare('UPDATE ubeeq_owned_version_removals SET payload=? WHERE target=?').run(JSON.stringify({...current,phase:'absent',proof}),target);return proof;});
}
