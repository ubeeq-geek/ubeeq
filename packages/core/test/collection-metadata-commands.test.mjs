import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as metadata from '../dist/collection-metadata.js';
import {createMetadataService} from '../dist/collection-metadata-service.js';
import {createMetadataCommandProcessor} from '../dist/collection-metadata-commands.js';
const at='2026-11-14T00:00:00.000Z';
function fixture(){
 let sequence=0;const createId=()=>String(++sequence),now=()=>at;
 const domain=metadata.createMetadataDomain({sha256Hex:value=>createHash('sha256').update(value).digest('hex'),createId,now});
 const collection={tenantId:'tenant',creatorId:'creator',collectionId:'collection',title:'Native title',description:'Native description',revision:1,metadataRevision:1,status:'draft',updatedAt:at,slug:'retained-url',workIds:['work'],opaque:{futureField:true}};
 const endpoint={kind:'platform',identity:'authorized-remote',platform:'provider',remoteCollectionId:'remote-id',title:'Remote collection'};
 const runtime={enabled:true,allowed:true,tenantId:'tenant',actors:new Set(),graph:metadata.emptyMetadataGraph(),remote:{title:'Remote title',description:'Remote description',cover:null},reads:0,legacyReads:0,authorizations:0,offline:false};
 const capabilities=()=>({revision:'adapter-v1',fields:Object.fromEntries(metadata.metadataFields.map(field=>[field,{readable:true,writable:true,clearable:true}])),automatic:true,freshnessMs:30000,conditionalWrite:true,emptyCreation:false});
 const service=createMetadataService({domain,createId,now,tenantId:r=>r.tenantId,enabled:r=>r.enabled,canManage:async r=>r.allowed,recordAuthorization:(r,actor)=>r.actors.add(actor),getGraph:async r=>structuredClone(r.graph),publicationIdentity:(tenant,id,destination)=>`publication:${tenant}:${destination}:${id}`,legacyRelationships:async r=>{r.legacyReads++;return {endpoints:[],publications:[{destination:'native'}]};},adapter:async r=>({capabilities,readCollectionMetadata:async target=>{r.reads++;if(r.offline)throw Error('Offline');return domain.metadataSnapshot(target.identity,metadata.cellsFromValues(r.remote));}}),validateDestination:async()=>{}});
 const ports={domain,service,createId,now,tenantId:r=>r.tenantId,enabled:r=>r.enabled,authorize:async(r,c,actor)=>{r.authorizations++;if(!r.allowed||c.tenantId!==r.tenantId||actor!=='actor')metadata.metadataError('permission_denied','Denied');},recordAuthorization:(r,actor)=>r.actors.add(actor),getGraph:async r=>structuredClone(r.graph),endpoints:async()=>[endpoint]};
 const processor=createMetadataCommandProcessor(ports),state=metadata.emptyMetadataState();
 const execute=(operation,body={})=>processor.execute(runtime,collection,state,'actor',operation,body);
 const relate=()=>execute('relate',{endpointIdentity:endpoint.identity});
 const source=async()=>{const related=await relate(),preview=await execute('configure-preview',{connectionId:related.resultId,role:'SOURCE',fields:['title'],policy:'APPROVAL_REQUIRED'}),applied=await execute('apply',{proposalId:preview.resultId});runtime.graph=applied.graph;return state.connections.find(value=>value.id===related.resultId);};
 return {domain,collection,endpoint,runtime,state,ports,processor,execute,relate,source};
}
test('command composition has no fallback authorization or observation service',()=>{
 const f=fixture();for(const key of ['authorize','enabled','getGraph','endpoints','recordAuthorization'])assert.throws(()=>createMetadataCommandProcessor({...f.ports,[key]:undefined}),/required/);
 assert.throws(()=>createMetadataCommandProcessor({...f.ports,service:{...f.ports.service,observeMetadata:undefined}}),/required/);
});
test('disabled or denied commands perform no discovery, observation or working-state mutation',async()=>{
 for(const reason of ['disabled','denied']){
  const f=fixture(),before=structuredClone(f.state);f.runtime.enabled=reason!=='disabled';f.runtime.allowed=reason!=='denied';
  await assert.rejects(f.execute('initialize'),{code:reason==='disabled'?'unsupported_field':'permission_denied'});
  assert.deepEqual(f.state,before);assert.equal(f.runtime.legacyReads,0);assert.equal(f.runtime.reads,0);assert.equal(f.runtime.actors.size,0);
 }
});
test('initialization is metadata-only and leaves revisions and command receipts to the host',async()=>{
 const f=fixture(),before=structuredClone(f.collection);await f.execute('initialize');await f.execute('initialize');
 assert.equal(f.runtime.legacyReads,1);assert.equal(f.runtime.reads,0);assert.equal(f.state.initialized,true);assert.equal(f.state.legacyMigrated,true);
 assert.deepEqual(f.state.commands,[]);assert.equal(f.state.revision,0);assert.deepEqual(f.collection,before);assert.deepEqual([...f.runtime.actors],['actor']);
 assert.equal(f.state.published['publication:tenant:native:collection'].values.title,'Native title');
});
test('relating selects an authorized endpoint and preserves Related-only semantics without duplicates',async()=>{
 const f=fixture(),first=await f.relate(),second=await f.relate();assert.equal(first.resultId,second.resultId);assert.equal(f.state.connections.length,1);
 assert.equal(f.state.connections[0].role,'RELATED');assert.equal(f.state.connections[0].activated,false);assert.deepEqual(f.state.connections[0].fields,[]);assert.equal(f.state.snapshots.length,2);assert.deepEqual(f.state.provenance,[]);
 await assert.rejects(f.execute('relate',{endpointIdentity:'foreign'}),{code:'permission_denied'});assert.equal(f.runtime.reads,2);
});
test('source preview and application preserve opaque catalogue fields and independent public values',async()=>{
 const f=fixture(),connection=await f.source();assert.equal(f.collection.title,'Native title');
 const proposed=await f.execute('propose',{connectionId:connection.id}),result=await f.execute('apply',{proposalId:proposed.resultId});
 assert.equal(result.collection.title,'Remote title');assert.equal(result.collection.slug,'retained-url');assert.deepEqual(result.collection.workIds,['work']);assert.deepEqual(result.collection.opaque,{futureField:true});
 assert.equal(f.collection.title,'Native title');assert.equal(f.state.published['publication:tenant:native:collection'].values.title,'Native title');assert.equal(f.state.revision,0);assert.deepEqual(f.state.commands,[]);
});
test('copy and proposal field selections cannot bypass configured source ownership',async()=>{
 const f=fixture(),related=await f.relate();await assert.rejects(f.execute('propose',{connectionId:related.resultId}),{code:'invalid_request'});
 const copied=await f.execute('copy-preview',{connectionId:related.resultId,fields:['description']});assert.equal(f.state.proposals.find(p=>p.id===copied.resultId).direction,'COPY');
 const s=fixture(),source=await s.source();await assert.rejects(s.execute('propose',{connectionId:source.id,fields:['description']}),{code:'invalid_request'});await assert.rejects(s.execute('copy-preview',{connectionId:source.id,fields:['title']}),{code:'invalid_request'});
 assert.equal(s.collection.title,'Native title');assert.deepEqual(s.state.commands,[]);
});
test('offline refresh retains attention and blocks pending proposals without changing native content',async()=>{
 const f=fixture(),connection=await f.source(),proposal=await f.execute('propose',{connectionId:connection.id});f.runtime.offline=true;
 await f.execute('refresh',{connectionId:connection.id});assert.equal(connection.lifecycle,'PAUSED');assert.equal(connection.activated,false);assert.match(connection.attention,/Offline/);assert.equal(f.state.proposals.find(p=>p.id===proposal.resultId).state,'BLOCKED');
 assert.equal(f.collection.title,'Native title');assert.equal(f.state.audit.at(-1).event,'metadata.observed');
});
test('pause, resume and detach retain history while returning conditional graph updates to the host',async()=>{
 const f=fixture(),connection=await f.source(),proposal=await f.execute('propose',{connectionId:connection.id});
 const paused=await f.execute('pause',{connectionId:connection.id});assert.equal(paused.expectedGraphRevision,1);assert.equal(paused.graph.routes.length,1);assert.equal(f.runtime.graph.revision,1);assert.equal(f.state.proposals.find(p=>p.id===proposal.resultId).state,'SUPERSEDED');f.runtime.graph=paused.graph;
 const resumed=await f.execute('resume',{connectionId:connection.id});assert.equal(resumed.expectedGraphRevision,2);assert.equal(connection.lifecycle,'ACTIVE');assert.equal(connection.activated,false);assert.ok(resumed.resultId);f.runtime.graph=resumed.graph;
 const snapshots=structuredClone(f.state.snapshots),detached=await f.execute('detach',{connectionId:connection.id});assert.equal(detached.expectedGraphRevision,3);assert.deepEqual(detached.graph.routes,[]);assert.equal(connection.lifecycle,'DETACHED');assert.deepEqual(f.state.snapshots,snapshots);assert.ok(f.state.connections.includes(connection));
 await assert.rejects(f.execute('resume',{connectionId:connection.id}),{code:'invalid_request'});
});
test('rejection remembers reviewed values and only explicit review-again clears them',async()=>{
 const f=fixture(),connection=await f.source(),proposal=await f.execute('propose',{connectionId:connection.id}),p=f.state.proposals.find(p=>p.id===proposal.resultId),change=p.changes[0];
 await f.execute('reject',{proposalId:p.id});assert.equal(p.state,'REJECTED');assert.equal(connection.rejected.title,f.domain.metadataHash([change.observedHash,f.domain.fieldHash(change.field,change.proposed)]));
 const suppressed=await f.execute('propose',{connectionId:connection.id});assert.deepEqual(f.state.proposals.find(p=>p.id===suppressed.resultId).changes,[]);
 const reviewed=await f.execute('propose',{connectionId:connection.id,reviewAgain:true});assert.equal(f.state.proposals.find(p=>p.id===reviewed.resultId).changes.length,1);
 await assert.rejects(f.execute('reject',{proposalId:p.id}),{code:'stale_revision'});
});
test('archived collections and unknown operations cannot create command receipts',async()=>{
 const f=fixture();f.collection.managementState='archived';await assert.rejects(f.execute('initialize'),{code:'route_paused'});assert.equal(f.runtime.legacyReads,0);
 delete f.collection.managementState;await assert.rejects(f.execute('unknown'),{code:'invalid_request'});assert.deepEqual(f.state.commands,[]);assert.equal(f.state.revision,0);
});
