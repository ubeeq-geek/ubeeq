import assert from 'node:assert/strict';
import {RepositoryRetainedSourceFiles} from '../dist/retained-source-files.js';
import {scope,at,creatorInput} from './retained-repository-fixture.mjs';
export {scope,at,creatorInput};
export const accessId='source-actor';
export const actorRecord={id:accessId,instanceId:scope.instanceId,homeCellId:scope.cellId,dataHomeRegion:scope.region,dataHomeAssignedAt:at,routingRevision:1,namespace:'test-source-actors',scopeId:'actor',key:'access',value:{actorId:'actor',active:true,platformRole:null}};
export const sourceFile=(id='original',patch={})=>({fileId:id,creatorId:scope.creatorId,sourceKind:'document',mimeType:'text/plain',storageKey:`creator/originals/${id}/source`,originalFilename:'Original.txt',sizeBytes:14,revision:1,uploadState:'pending',downloadable:false,premium:false,restricted:false,createdAt:at,updatedAt:at,metadata:{legacy:'retained'},opaque:{keep:['all','original','fields']},...patch});
export const sourceAudit=(id='source-created',actor='actor',patch={})=>({auditId:id,actorUserId:actor,actorRole:'creator',action:'source_file.upload.prepared',createdAt:at,detail:{fileId:'original',creatorId:'creator',opaque:{preserved:true}},...patch});

export function sourceStore(repositories,options={}){
 let store;
 const read=async(actor,creator,transaction)=>{
  const row=await repositories.hostRecords.get(accessId,{transaction});
  if(!row||row.value.actorId!==actor||row.value.active!==true)return null;
  if(transaction)await repositories.hostRecords.checkRevision(row.id,row.revision,{transaction});
  if(transaction)await repositories.creators.checkRevision(creator.id,creator.revision,{transaction});
  if(row.value.platformRole?.userId===actor&&row.value.platformRole.role==='admin')return {actorUserId:actor,isAdmin:true,expectedRole:row.value.platformRole,expectedMember:null};
  if(creator.subjectId===actor)return {actorUserId:actor,isAdmin:false,expectedRole:row.value.platformRole,expectedMember:null,expectedOwner:creator};
  const member=await repositories.hostRecords.get('source-member',{transaction});
  if(!member||member.value.creatorId!==creator.id||member.value.userId!==actor||!['owner','admin','manager','editor'].includes(member.value.role))return null;
  if(transaction)await repositories.hostRecords.checkRevision(member.id,member.revision,{transaction});
  return {actorUserId:actor,isAdmin:false,expectedRole:row.value.platformRole,expectedMember:member.value};
 };
 store=new RepositoryRetainedSourceFiles(repositories,scope,{
  resolveSourceAccess:read,
  validateAssetAttachment:async input=>{assert.ok(store.transaction());assert.equal(input.asset.storage.mode,'hosted');assert.match(input.asset.checksumSha256,/^[a-f0-9]{64}$/);assert.ok(input.asset.storage.objectKey.startsWith('creator/originals/'));},
  ...options
 });
 return {store,access:async()=>read('actor',await repositories.creators.get('creator'))};
}
