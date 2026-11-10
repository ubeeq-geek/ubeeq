import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsiteSourceReader,mapWebsiteSources} from '../dist/website-sources.js';
import {handleWebsiteRequest} from '../dist/websites.js';

test('1000-image source checks scan each repository once and invalidate on authoritative changes',async()=>{
 let revision=1;const calls={};
 const rows={works:[{id:'work',creatorId:'owner',status:'published',revision:1}],assets:Array.from({length:1000},(_,index)=>({id:'asset-'+index,creatorId:'owner',workId:'work',status:'ready',revision:1,checksum:'source-'+index})),publications:[{id:'publication',workId:'work',status:'live',destination:'local',revision:1}],moderationHolds:[]};
 const repositories=Object.fromEntries(Object.entries(rows).map(([name,values])=>[name,{list:async()=>{calls[name]=(calls[name]??0)+1;return {items:values.map(value=>({...value}))};}}]));
 const read=createWebsiteSourceReader(repositories,()=>String(revision)),first=await read('owner');
 const dependencies=[{kind:'catalogue',id:'work',revision:first.revision('work')},...rows.assets.map(asset=>({kind:'asset',id:asset.id,revision:'1:rendition-checksum'}))];
 assert.equal(first.eligible(dependencies,true),true);
 for(let index=0;index<1000;index++)assert.equal(first.current('work').assets.length,1000);
 assert.equal(await read('owner'),first);assert.deepEqual(calls,{works:1,assets:1,publications:1,moderationHolds:1});
 // Adding an image must invalidate a cached preview even when the Work revision stays unchanged.
 rows.assets.push({...rows.assets[0],id:'new-image'});revision++;
 const second=await read('owner');assert.equal(second.eligible(dependencies),true);assert.equal(second.eligible(dependencies,true),false);
 rows.moderationHolds.push({subjectId:'asset-0',state:'active'});revision++;
 assert.equal((await read('owner')).eligible(dependencies),false);
 rows.moderationHolds[0].state='released';rows.publications[0].status='removed';revision++;
 assert.equal((await read('owner')).eligible(dependencies),false);
 assert.equal((await read('foreign-owner')).eligible(dependencies),false);
});

test('bounded rendition resolution waits for in-flight work after a failure',async()=>{
 let active=0,peak=0;const settled=[];
 await assert.rejects(mapWebsiteSources([0,1,2,3],async value=>{peak=Math.max(peak,++active);try{await new Promise(resolve=>setImmediate(resolve));if(value===0)throw Error('decode failed');return value;}finally{active--;settled.push(value);}}),/decode failed/);
 assert.equal(peak,2);assert.equal(active,0);assert.deepEqual(settled.sort(),[0,1]);
});

test('preview revision filtering reaches the service and invalid revisions are not silently omitted',async()=>{
 const calls=[],service={builds:async(...args)=>{calls.push(args);return [];}};
 for(const query of ['?previewRevision=7','?previewRevision=bad',''])await handleWebsiteRequest({service,actor:{workspaceId:'owner',actorId:'actor'},request:{method:'GET'},response:{setHeader(){}},url:new URL('http://local/v1/websites/site/builds'+query),body:async()=>({})});
 assert.equal(calls[0][2],7);assert.ok(Number.isNaN(calls[1][2]));assert.equal(calls[2][2],undefined);
});
