import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {collectionMetadata as metadata} from '../dist/index.js';

const at='2026-10-30T12:00:00.000Z';
function fixture(){let id=0;return metadata.createMetadataDomain({sha256Hex:value=>createHash('sha256').update(value).digest('hex'),createId:()=>`id-${++id}`,now:()=>at});}
const collection=()=>({tenantId:'instance',creatorId:'creator',collectionId:'collection',title:'Native title',description:'Native description',slug:'stable-url',slugHistory:['first-url'],type:'collection',status:'draft',visibility:'private',revision:3,metadataRevision:2,createdAt:at,updatedAt:at});
const values=(title='Remote title',description='Remote description')=>({title,description,cover:null});
const connection=(role='SOURCE',id='connection')=>({id,role,endpoint:{kind:'platform',identity:'platform:provider:account:gallery',platform:'provider',accountId:'saved-connection',remoteAccountId:'remote-account',remoteCollectionId:'gallery',title:'Remote gallery'},revision:1,lifecycle:'ACTIVE',fields:['title','description','cover'],policy:'APPROVAL_REQUIRED',overrides:{},baseline:{},actorId:'actor',createdAt:at,activated:false,rejected:{}});
const capabilities=()=>({revision:'capability-1',fields:Object.fromEntries(metadata.metadataFields.map(field=>[field,{readable:true,writable:true,clearable:true}])),automatic:true,freshnessMs:60000,conditionalWrite:true,emptyCreation:true});
const code=expected=>error=>error instanceof metadata.CollectionMetadataError&&error.code===expected;

test('metadata hashing requires explicit trusted cryptography and matches retained persisted golden vectors',()=>{
 assert.throws(()=>metadata.createMetadataDomain(),/ports are required/);
 assert.throws(()=>metadata.createMetadataDomain({sha256Hex:v=>v,createId:()=>''}),/ports are required/);
 const domain=fixture(),vectors=JSON.parse(readFileSync(new URL('./fixtures/collection-metadata-hashes.json',import.meta.url),'utf8'));
 // Captured from the retained native implementation, not calculated by this
 // implementation. Approval/baseline hashes must survive extraction unchanged.
 for(const vector of vectors)assert.equal(vector.field?domain.fieldHash(vector.field,vector.value):domain.metadataHash(vector.value),vector.hash,vector.name);
 assert.equal(domain.fieldHash('description',null),domain.fieldHash('description',''));
 assert.equal(domain.fieldHash('description','Café\nLine 2'),vectors.find(v=>v.name==='unicode_description').hash);
 const cover=vectors.find(v=>v.name==='saved_cover');assert.equal(domain.fieldHash('cover',{...cover.value,image:{...cover.value.image,updatedAt:at}}),cover.hash);
 assert.equal(Object.isFrozen(domain),true);
});
test('snapshots preserve explicit availability and unknown values never become clearing instructions',()=>{
 const domain=fixture(),c=collection(),cells={title:{available:false,reason:'Unavailable'},description:{available:false,reason:'Unavailable'},cover:{available:true,value:null}};
 const snapshot=domain.metadataSnapshot('endpoint',cells,'remote-etag');assert.equal(snapshot.observedAt,at);assert.equal(snapshot.remoteVersion,'remote-etag');assert.deepEqual(Object.keys(snapshot.hashes),['cover']);
 cells.cover.value={kind:'asset',assetId:'changed-after-observation'};assert.equal(snapshot.fields.cover.value,null);
 const proposal=domain.planMetadata(c,connection(),snapshot,capabilities(),'actor');assert.deepEqual(proposal.changes,[]);assert.equal(proposal.state,'PENDING');assert.equal(proposal.createdAt,at);
 assert.notEqual(snapshot.id,proposal.id);assert.equal(proposal.nativeRevision,c.metadataRevision);assert.equal(proposal.nativeHash,domain.metadataHash(metadata.nativeMetadata(c)));
});
test('platform description projection is independent of native rich text and metadata patches cannot change membership or access',()=>{
 const c=collection();c.description='<p>Hello</p><p>World &amp; friends</p>';
 // Retain the native paragraph terminator; trimming changes observed hashes.
 const projected=metadata.projectCollectionMetadataValue('description',c.description,connection().endpoint);assert.equal(projected,'Hello\nWorld & friends\n');
 assert.equal(metadata.projectCollectionMetadataValue('description',c.description,{...connection().endpoint,kind:'website'}),c.description);
 assert.equal(metadata.plainCollectionDescriptionToRichText('One & two\n<literal>'),'One &amp; two<br>&lt;literal&gt;');
 for(const patch of [{workIds:['work']},{visibility:'public'},{slug:'changed'},{creatorId:'other'}])assert.throws(()=>metadata.assertMetadataPatch(patch),code('unsupported_field'));
 assert.throws(()=>metadata.assertMetadataPatch({title:' '}),code('invalid_request'));
 assert.throws(()=>metadata.assertMetadataPatch({cover:{kind:'remote',identity:'endpoint',url:'http://unsafe.example.test/image'}}),code('invalid_request'));
});
test('native edits retain URL/order/history/opaque fields and keep the published projection independent',()=>{
 const domain=fixture(),c={...collection(),workIds:['second','first'],workPublicationHistoryAt:at,organizationSettings:{preserve:true}};
 Object.freeze(c.workIds);Object.freeze(c.organizationSettings);Object.freeze(c);
 const changed=domain.applyNativeMetadata(c,{title:'Revised',description:'<script>bad()</script><strong>Safe</strong>',cover:{kind:'asset',assetId:'owned-image'}});
 assert.equal(changed.title,'Revised');assert.equal(changed.slug,c.slug);assert.deepEqual(changed.slugHistory,c.slugHistory);assert.equal(changed.visibility,'private');assert.deepEqual(changed.workIds,c.workIds);assert.deepEqual(changed.organizationSettings,c.organizationSettings);assert.equal(changed.workPublicationHistoryAt,at);
 assert.equal(changed.revision,4);assert.equal(changed.metadataRevision,3);assert.equal(changed.updatedAt,at);assert.equal(changed.coverAssetId,'owned-image');assert.ok(!changed.description.includes('<script>'));
 assert.deepEqual(changed.publicMetadata,metadata.nativeMetadata(c));assert.equal(changed.publicMetadata.title,'Native title');assert.equal(c.title,'Native title');
 assert.throws(()=>domain.applyNativeMetadata(c,{cover:{kind:'remote',identity:'endpoint',url:'https://provider.example.test/image'}}),code('unsupported_field'));
});
test('a retained SOURCE protects its fields even while paused; detaching releases only that field authority',()=>{
 const c=collection(),source={...connection(),fields:['title'],lifecycle:'PAUSED'},state={...metadata.emptyMetadataState(),connections:[source]};
 assert.throws(()=>metadata.assertEditableMetadata(c,state,['title']),code('invalid_request'));
 assert.doesNotThrow(()=>metadata.assertEditableMetadata(c,state,['description']));
 assert.doesNotThrow(()=>metadata.assertEditableMetadata(c,{...state,connections:[{...source,lifecycle:'DETACHED'}]},['title']));
});
test('proposal planning preserves conflict baselines, explicit clearing capabilities and initial automatic review',()=>{
 const domain=fixture(),c=collection(),destination={...connection('DESTINATION'),fields:['title'],activated:true,policy:'AUTOMATIC'};
 let snapshot=domain.metadataSnapshot(destination.endpoint.identity,metadata.cellsFromValues(values()));
 let proposal=domain.planMetadata(c,destination,snapshot,capabilities(),'actor');assert.equal(proposal.state,'BLOCKED');assert.match(proposal.changes[0].blocked,/initial baseline/);
 destination.baseline.title={snapshotId:'accepted',hash:domain.fieldHash('title','Accepted remote'),value:'Accepted remote'};
 proposal=domain.planMetadata(c,destination,snapshot,capabilities(),'actor');assert.equal(proposal.state,'BLOCKED');assert.match(proposal.changes[0].blocked,/edited directly/);
 destination.baseline.title={snapshotId:'accepted',hash:snapshot.hashes.title,value:snapshot.fields.title.value};
 proposal=domain.planMetadata(c,destination,snapshot,capabilities(),'actor');assert.equal(proposal.state,'PENDING');assert.equal(proposal.changes[0].proposed,'Native title');
 destination.overrides.title='';const caps=capabilities();caps.fields.title.clearable=false;
 proposal=domain.planMetadata(c,destination,snapshot,caps,'actor');assert.equal(proposal.state,'BLOCKED');assert.match(proposal.changes[0].blocked,/cannot clear/);
 const source={...connection(),fields:['title'],baseline:{title:{snapshotId:'accepted',hash:domain.fieldHash('title','Earlier native'),value:'Earlier native'}}};
 proposal=domain.planMetadata(c,source,snapshot,capabilities(),'actor');assert.equal(proposal.state,'BLOCKED');assert.match(proposal.changes[0].blocked,/Native metadata changed/);
 source.lifecycle='PAUSED';assert.throws(()=>domain.planMetadata(c,source,snapshot,capabilities(),'actor'),code('route_paused'));
});
test('metadata graph reservations retain single destination writers and prevent update cycles without mutating the old graph',()=>{
 const initial=metadata.emptyMetadataGraph(),destination={...connection('DESTINATION'),fields:['title']};
 const graph=metadata.reserveMetadataRoute(initial,'first',destination,'instance');assert.equal(initial.routes.length,0);assert.equal(graph.revision,1);
 assert.throws(()=>metadata.reserveMetadataRoute(graph,'second',{...destination,id:'another'},'instance'),code('destination_writer_exists'));
 const sourceGraph=metadata.reserveMetadataRoute(initial,'first',{...connection('SOURCE'),fields:['title']},'instance');
 assert.throws(()=>metadata.reserveMetadataRoute(sourceGraph,'first',{...destination,id:'loop'},'instance'),code('cycle_detected'));
 const detached=metadata.reserveMetadataRoute(graph,'first',{...destination,lifecycle:'DETACHED'},'instance');assert.deepEqual(detached.routes,[]);assert.equal(graph.routes.length,1);
 const related=metadata.reserveMetadataRoute(initial,'first',connection('RELATED'),'instance');assert.deepEqual(related.routes,[]);
});
test('metadata commit contracts retain independent state, catalogue, graph and ownership revision checks',()=>{
 const c=collection(),input={tenantId:c.tenantId,creatorId:c.creatorId,collectionId:c.collectionId,expectedRevision:0,state:{...metadata.emptyMetadataState(),revision:1},expectedCollectionRevision:c.revision,collection:{...c,revision:c.revision+1},graph:{...metadata.emptyMetadataGraph(),revision:1},expectedGraphRevision:0};
 assert.doesNotThrow(()=>metadata.validateMetadataCommit(input));
 for(const change of [{state:{...input.state,revision:2}},{collection:{...input.collection,creatorId:'other'}},{collection:{...input.collection,revision:c.revision}},{graph:{...input.graph,revision:2}}])assert.throws(()=>metadata.validateMetadataCommit({...input,...change}),code('stale_revision'));
});
