import assert from 'node:assert/strict';
import {RepositoryRetainedContentStore} from '../dist/retained-repository-store.js';

export const at='2026-11-15T00:00:00.000Z';
export const scope={instanceId:'instance',tenantId:'tenant',creatorId:'creator',cellId:'cell',region:'ca-central-1'};
export const creatorInput={id:scope.creatorId,instanceId:scope.instanceId,homeCellId:scope.cellId,dataHomeRegion:scope.region,dataHomeAssignedAt:at,routingRevision:1,handle:'creator',displayName:'Retained Creator',subjectId:'actor'};
export const work=(id='work',extra={})=>({tenantId:scope.tenantId,creatorId:scope.creatorId,workId:id,kind:'article',title:'Retained '+id,slug:id,slugHistory:['ever-'+id,id],description:'Original subject',tags:['kept'],body:[{id:'paragraph',type:'paragraph',text:'Full original text'}],contentRating:'general',aiDisclosure:'none',heavyTopics:[],status:'draft',origin:{type:'creator'},revision:1,createdAt:at,updatedAt:at,fieldMetadata:{shared:{title:'Subject'},overrides:[{destination:'native',values:{allowComments:false}}]},opaque:{keep:['all','fields']},...extra});
export const asset=(id='asset',extra={})=>({tenantId:scope.tenantId,creatorId:scope.creatorId,assetId:id,kind:'image',status:'ready',mimeType:'image/png',sizeBytes:123,checksumSha256:'a'.repeat(64),storage:{mode:'hosted',objectKey:`creator/originals/${id}/source`},metadata:{legacy:'retained'},createdAt:at,updatedAt:at,...extra});
export const publication=(extra={})=>({tenantId:scope.tenantId,creatorId:scope.creatorId,workId:'work',publicationId:'publication',destination:'native',remoteId:'ever-remote',status:'live',visibility:'public',createdAt:at,updatedAt:at,providerData:{remoteGallery:['original']},opaque:{legacy:true},...extra});

/** Tests resolve the persisted owner and source in the actual accepting scope.
 * There is no unconditional authority or no-op source validator.
 */
export function retainedStore(repositories,options={}){
 let store;
 class Store extends RepositoryRetainedContentStore {
  async getCreatorById(id){const c=await repositories.creators.get(id);return c?.contentAuthority==='retained-v1'?{...c,creatorId:c.id,name:c.displayName,status:'active'}:null;}
  async listCreators(){return (await repositories.creators.list({limit:100})).items.filter(c=>c.contentAuthority==='retained-v1').map(c=>({...c,creatorId:c.id,status:'active'}));}
  async getAnnouncementOrchestration(){return null;}
 }
 store=new Store(repositories,scope,{
  resolveActorRole:async(actor,creator,transaction)=>{
   const current=await repositories.creators.get(creator.id,{transaction});
   await repositories.creators.checkRevision(current.id,current.revision,{transaction});
   return current.subjectId===actor?'owner':null;
  },
  validateAssetAttachment:async input=>{
   assert.ok(store.transaction(),'source validation shares the accepting transaction');
   const source=await store.getRetainedEntity('source-file',input.asset.assetId);
   assert.ok(source&&source.creatorId===input.work.creatorId&&source.uploadState==='ready'&&!source.restricted&&!source.premium&&source.storageKey===input.asset.storage.objectKey,'actual admitted source is required');
   if(input.sourceFileGuard)assert.deepEqual(source,input.sourceFileGuard.file,'saved source evidence must still match');
  },...options
 });return store;
}
export async function seedAsset(store,value=asset()){
 await store.putRetainedEntity('source-file',value.assetId,{fileId:value.assetId,creatorId:scope.creatorId,storageKey:value.storage.objectKey,uploadState:'ready',revision:1,opaque:{original:true}});
 await store.createCanonicalAsset(value);
}
