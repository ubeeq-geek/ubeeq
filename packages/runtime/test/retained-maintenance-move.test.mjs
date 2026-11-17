import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {RepositoryRetainedContentStore,createRetainedRepositoryCreator} from '../dist/retained-repository-store.js';
import {scope,creatorInput} from './retained-repository-fixture.mjs';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'retained-maintenance-move-')),local=createLocalAdapterSet({databasePath:join(directory,'core.sqlite'),dataDirectory:directory,cellId:scope.cellId,publicBaseUrl:'http://localhost'});t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 await local.repositories.transaction(tx=>createRetainedRepositoryCreator(local.repositories,creatorInput,scope.tenantId,tx));
 const bindings={resolveActorRole:async actor=>actor==='actual-editor'?'editor':null,validateAssetAttachment:async()=>{throw Error('No source/provider acceptance in this neutral storage contract.');}};
 return {local,bindings};
}
test('omitted maintenance seam denies a role-less exact move and keeps the original row',async t=>{
 const {local,bindings}=await fixture(t),raw=new RepositoryRetainedContentStore(local.repositories,scope,bindings),original={opaque:{full:['Native','JSON']}};
 await raw.asActor('actual-editor',()=>raw.putRetainedEntity('compatibility-publication','pending',original));
 await assert.rejects(raw.moveRetainedEntity({kind:'compatibility-publication',fromKey:'pending',toKey:'remote',expected:original,next:{...original,remoteId:'verified-protocol-only'}}),error=>error.status===403);
 assert.deepEqual(await raw.getRetainedEntity('compatibility-publication','pending'),original);assert.equal(await raw.getRetainedEntity('compatibility-publication','remote'),undefined);
});
test('allowing the move hook alone cannot authorize final maintenance flush',async t=>{
 const {local,bindings}=await fixture(t);class MoveOnly extends RepositoryRetainedContentStore {mayMoveRetainedEntityAsMaintenance(){return true;}}
 const raw=new MoveOnly(local.repositories,scope,bindings),original={keep:true};await raw.asActor('actual-editor',()=>raw.putRetainedEntity('compatibility-publication','pending',original));
 await assert.rejects(raw.moveRetainedEntity({kind:'compatibility-publication',fromKey:'pending',toKey:'remote',expected:original,next:{keep:true,remoteId:'protocol'}}),error=>error.status===403);assert.deepEqual(await raw.getRetainedEntity('compatibility-publication','pending'),original);
});
test('a private exact move AND complete delta control commits once; an unrelated joined mutation rolls everything back',async t=>{
 const {local,bindings}=await fixture(t),original={opaque:{full:['JSON']}},next={...original,remoteId:'protocol-only'};
 class ExactMove extends RepositoryRetainedContentStore {
  intent;
  mayMoveRetainedEntityAsMaintenance(input){return !!this.intent&&equal(input,this.intent);}
  mayCommitMaintenance(changes){return !!this.intent&&changes.length===2&&changes.every(change=>change.category==='entity'&&change.kind===this.intent.kind&&(change.key===this.intent.fromKey?equal(change.previous,this.intent.expected)&&change.next===undefined:change.key===this.intent.toKey&&change.previous===undefined&&equal(change.next,this.intent.next)));}
  async commit(input,extra=false){this.intent=input;try{return await this.publicationAtomic.run(async()=>{await this.moveRetainedEntity(input);if(extra)await this.putRetainedEntity('unrelated','not-authorized',{bad:true});});}finally{this.intent=undefined;}}
 }
 const raw=new ExactMove(local.repositories,scope,bindings);await raw.asActor('actual-editor',()=>raw.putRetainedEntity('compatibility-publication','pending',original));const input={kind:'compatibility-publication',fromKey:'pending',toKey:'remote',expected:original,next};
 await assert.rejects(raw.commit(input,true),error=>error.status===403);assert.deepEqual(await raw.getRetainedEntity('compatibility-publication','pending'),original);assert.equal(await raw.getRetainedEntity('unrelated','not-authorized'),undefined);
 await raw.commit(input);assert.equal(await raw.getRetainedEntity('compatibility-publication','pending'),undefined);assert.deepEqual(await raw.getRetainedEntity('compatibility-publication','remote'),next);await assert.rejects(raw.commit(input),error=>error.status===409);
});
