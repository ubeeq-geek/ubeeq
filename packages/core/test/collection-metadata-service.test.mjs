import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as metadata from '../dist/collection-metadata.js';
import {createMetadataService} from '../dist/collection-metadata-service.js';

const at='2026-11-14T00:00:00.000Z';
const values=(title='Remote title',description='Remote description')=>({title,description,cover:null});
function fixture(){
 let next=0;
 const domain=metadata.createMetadataDomain({sha256Hex:v=>createHash('sha256').update(v).digest('hex'),createId:()=>String(++next),now:()=>at});
 const c={tenantId:'tenant',creatorId:'creator',collectionId:'collection',title:'Native title',description:'Native description',revision:1,metadataRevision:1,updatedAt:at,status:'draft',slug:'stable-url',workIds:['work'],opaque:{retained:true}};
 const runtime={allowed:true,enabled:true,admission:true,tenantId:'tenant',actors:new Set(),graph:metadata.emptyMetadataGraph(),remote:values(),capabilityRevision:'adapter-v1',reads:0,admissionChecks:0,legacyReads:0};
 const capabilities=()=>({revision:runtime.capabilityRevision,fields:Object.fromEntries(metadata.metadataFields.map(f=>[f,{readable:true,writable:true,clearable:true}])),automatic:true,freshnessMs:30000,conditionalWrite:true,emptyCreation:false});
 const endpoint={kind:'platform',identity:'remote',platform:'provider',remoteCollectionId:'remote-id',title:'Remote collection'};
 const connection={id:'source',endpoint,role:'SOURCE',revision:1,lifecycle:'ACTIVE',fields:['title','description'],policy:'APPROVAL_REQUIRED',overrides:{},baseline:{},rejected:{},actorId:'actor',createdAt:at,activated:true};
 const state=metadata.emptyMetadataState();state.connections.push(connection);
 const service=createMetadataService({domain,createId:()=>String(++next),now:()=>at,tenantId:r=>r.tenantId,enabled:r=>r.enabled,
  canManage:async r=>r.allowed,recordAuthorization:(r,actor)=>r.actors.add(actor),getGraph:async r=>structuredClone(r.graph),
  publicationIdentity:(tenant,id,destination)=>`publication:${tenant}:${destination}:${id}`,
  legacyRelationships:async r=>{r.legacyReads++;return {endpoints:[endpoint],publications:[{destination:'native'}]};},
  adapter:async(r,collection,state,actor,endpoint)=>({capabilities,readCollectionMetadata:async()=>{r.reads++;if(r.unreadable||r.unreadableEndpoint===endpoint.identity)throw Error('Offline');return domain.metadataSnapshot(endpoint.identity,metadata.cellsFromValues(endpoint.kind==='native-publication'?(state.published[endpoint.identity]?.values??collection.publicMetadata??metadata.nativeMetadata(collection)):r.remote));}}),
  validateDestination:async r=>{r.admissionChecks++;if(!r.admission)metadata.metadataError('permission_denied','Publication is held.');}
 });
 const preview=()=>domain.planMetadata(c,connection,domain.metadataSnapshot(endpoint.identity,metadata.cellsFromValues(runtime.remote)),capabilities(),'actor');
 return {domain,c,runtime,state,service,connection,endpoint,capabilities,preview};
}

test('legacy discovery records Related-only links once without observations, provenance or inferred automation',async()=>{
 const f=fixture();f.state.connections=[];
 await f.service.migrateLegacyMetadataRelationships(f.runtime,f.c,f.state,'actor');
 await f.service.migrateLegacyMetadataRelationships(f.runtime,f.c,f.state,'actor');
 assert.equal(f.runtime.legacyReads,1);assert.equal(f.runtime.reads,0);assert.equal(f.runtime.actors.size,0);
 assert.deepEqual(f.state.provenance,[]);assert.deepEqual(f.state.snapshots,[]);
 assert.equal(f.state.connections.length,1);assert.equal(f.state.connections[0].role,'RELATED');assert.equal(f.state.connections[0].activated,false);assert.deepEqual(f.state.connections[0].fields,[]);
 assert.equal(f.state.published['publication:tenant:native:collection'].values.title,'Native title');
});

test('revoked authority prevents application before any new observation or authorization receipt',async()=>{
 const f=fixture(),p=f.preview(),before=structuredClone(f.c);f.runtime.allowed=false;
 await assert.rejects(f.service.applyMetadataProposal(f.runtime,f.c,f.state,p,'actor'),e=>e.code==='permission_denied');
 assert.deepEqual(f.c,before);assert.equal(f.runtime.reads,0);assert.equal(f.runtime.actors.size,0);assert.deepEqual(f.state.executions,[]);
});

test('partial source approval preserves opaque content and public values and resumes only remaining fields',async()=>{
 const f=fixture(),p=f.preview();f.state.proposals.push(p);
 const first=await f.service.applyMetadataProposal(f.runtime,f.c,f.state,p,'actor',{fields:['title']});
 assert.equal(first.collection.title,'Remote title');assert.equal(first.collection.description,'Native description');assert.equal(first.collection.publicMetadata.title,'Native title');
 assert.deepEqual(first.collection.workIds,['work']);assert.deepEqual(first.collection.opaque,{retained:true});assert.equal(first.collection.slug,'stable-url');
 assert.equal(p.state,'PARTIAL');assert.ok(f.connection.baseline.title);assert.equal(f.connection.baseline.description,undefined);
 const second=await f.service.applyMetadataProposal(f.runtime,first.collection,f.state,p,'actor',{fields:['description']});
 assert.equal(second.collection.title,'Remote title');assert.equal(second.collection.description,'Remote description');assert.equal(p.state,'APPLIED');assert.equal(p.attempts,2);
 assert.equal(f.state.executions.length,2);assert.deepEqual([...f.runtime.actors],['actor']);
});

test('Automatic configuration saves no initial source values without explicit application and activation',async()=>{
 for(const applyInitial of [false,true]){
  const f=fixture();f.connection.role='RELATED';f.connection.activated=false;
  const p=await f.service.previewMetadataConfiguration(f.runtime,f.c,f.state,f.connection,{role:'SOURCE',fields:['title'],policy:'AUTOMATIC'},'actor');
  assert.equal(f.runtime.graph.revision,0,'preview does not acquire the host graph');
  const result=await f.service.applyMetadataProposal(f.runtime,f.c,f.state,p,'actor',{applyInitial,activate:applyInitial});
  assert.equal(f.connection.activated,applyInitial);assert.equal(result.collection?.title,applyInitial?'Remote title':undefined);
  assert.equal(f.c.title,'Native title');assert.equal(result.graph.revision,1);assert.equal(result.expectedGraphRevision,0);
 }
});

test('an offline source can return to Managed here without remote reads or changes to native values',async()=>{
 const f=fixture();f.runtime.unreadable=true;
 f.runtime.graph=metadata.reserveMetadataRoute(f.runtime.graph,f.c.collectionId,f.connection,'tenant');
 const before=structuredClone(f.c),p=await f.service.previewMetadataConfiguration(f.runtime,f.c,f.state,f.connection,{role:'RELATED'},'actor');
 const result=await f.service.applyMetadataProposal(f.runtime,f.c,f.state,p,'actor');
 assert.equal(f.connection.role,'RELATED');assert.equal(f.connection.activated,false);assert.deepEqual(result.graph.routes,[]);
 assert.equal(result.expectedGraphRevision,1);assert.equal(f.runtime.reads,0);assert.deepEqual(f.c,before);
});

test('fresh observation and capability revisions must still match the exact reviewed proposal',async()=>{
 for(const changed of ['remote','capability']){
  const f=fixture(),p=f.preview(),before=structuredClone(f.c);
  if(changed==='remote')f.runtime.remote.title='A later remote title';else f.runtime.capabilityRevision='adapter-v2';
  await assert.rejects(f.service.applyMetadataProposal(f.runtime,f.c,f.state,p,'actor'),e=>e.code==='stale_revision');
  assert.deepEqual(f.c,before);assert.deepEqual(f.state.executions,[]);assert.equal(p.attempts,0);
 }
});

function destination(f,id='destination'){
 const r={...structuredClone(f.connection),id,role:'DESTINATION',endpoint:{...f.endpoint,kind:'native-publication',identity:'publication:tenant:native:collection',platform:'native'},baseline:{title:{snapshotId:'old',value:f.c.title,hash:f.domain.fieldHash('title',f.c.title)},description:{snapshotId:'old',value:f.c.description,hash:f.domain.fieldHash('description',f.c.description)}}};
 f.state.connections=[r];f.service.initializeMetadata(f.state,f.c,'tenant',[{destination:'native'}]);return r;
}

test('destination admission is required and private asset cover references cannot become public metadata',async()=>{
 for(const reason of ['held','private-cover']){
  const f=fixture(),r=destination(f);let updated=f.domain.applyNativeMetadata(f.c,{title:'Accepted new title'});
  if(reason==='held')f.runtime.admission=false;
  else{updated={...updated,coverAssetId:'private-original'};r.fields=['cover'];r.baseline.cover={snapshotId:'old',value:null,hash:f.domain.fieldHash('cover',null)};}
  const before=structuredClone(f.state.published),snapshot=f.domain.metadataSnapshot(r.endpoint.identity,metadata.cellsFromValues(f.state.published[r.endpoint.identity].values));
  const p=f.domain.planMetadata(updated,r,snapshot,f.capabilities(),'actor');
  await assert.rejects(f.service.applyMetadataProposal(f.runtime,updated,f.state,p,'actor'),e=>e.code===(reason==='held'?'permission_denied':'unsupported_field'));
  assert.equal(f.runtime.admissionChecks,1);assert.deepEqual(f.state.published,before);assert.deepEqual(f.state.executions,[]);
 }
});

test('automatic fanout isolates an unavailable destination while publishing only accepted native values',async()=>{
 const f=fixture(),good=destination(f);good.policy='AUTOMATIC';const bad={...structuredClone(good),id:'bad',endpoint:{...good.endpoint,identity:'bad-destination'}};f.state.connections.unshift(bad);
 const updated=f.domain.applyNativeMetadata(f.c,{title:'Accepted native title'});f.state.published[bad.endpoint.identity]={values:metadata.nativeMetadata(f.c),nativeRevision:1,updatedAt:at};
 f.runtime.unreadableEndpoint=bad.endpoint.identity;
 await f.service.planAcceptedNativeMetadata(f.runtime,updated,f.state,'actor');
 assert.equal(f.state.published[good.endpoint.identity].values.title,'Accepted native title');assert.equal(f.state.published[bad.endpoint.identity].values.title,'Native title');
 assert.match(bad.attention,/Offline/);assert.ok(f.state.audit.some(a=>a.connectionId==='bad'&&a.event==='metadata.destination.blocked'));
 assert.equal(f.c.title,'Native title');
});
