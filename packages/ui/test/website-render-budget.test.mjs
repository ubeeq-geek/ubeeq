import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStaticWebsite } from '../dist/index.js';
const fixture=()=>{
 const page={id:'home',documentId:'doc',kind:'home',title:'Home',state:'ready',navigation:true,order:0};
 return {apiVersion:'1',website:{title:'Website',locale:'en',basePath:'/',theme:{settings:{}},pages:[page],redirects:[]},routes:new Map([['home','/']]),documents:new Map([['doc',{blocks:[]}]]),media:new Map(),galleries:[]};
};
test('pagination reserves its generated pages before allocating them',()=>{
 const input=fixture();let titleReads=0;
 input.galleries=Array.from({length:1000},(_,i)=>({publicationId:'p'+i,href:'https://example.com/',local:false,get title(){titleReads++;return 'Gallery';},tags:[],collectionIds:[],date:'2026-10-19',previewAssetIds:[]}));
 input.documents.set('doc',{blocks:Array.from({length:10},()=>({type:'gallery_list',data:{pageSize:100}}))});
 input.limits={maxPages:2,maxBytes:50*1024*1024};
 assert.throws(()=>renderStaticWebsite(input),{code:'quota_exceeded'});
 assert.ok(titleReads<=1000,'generation must stop on the first over-budget list');
});
test('render output has an incremental byte budget including theme files',()=>{
 const input=fixture();input.limits={maxPages:2,maxBytes:100};
 assert.throws(()=>renderStaticWebsite(input),{code:'quota_exceeded'});
 input.limits.maxBytes=100000;
 const result=renderStaticWebsite(input);assert.ok(result.files.has('index.html'));assert.ok(result.files.has('assets/theme.css'));
});
test('mixed galleries expose static creator filters and independently paginated results',()=>{
 const input=fixture();input.website.creatorIdentityId='one';input.website.contributingCreatorIds=['two'];
 input.galleries=Array.from({length:5},(_,i)=>({publicationId:'p'+i,creatorIdentityId:i<3?'one':'two',creatorName:i<3?'First artist':'Second artist',title:'Work '+i,href:'https://example.com/work/'+i,local:false,tags:[],collectionIds:[],date:'2026-10-19',previewAssetIds:[]}));
 input.documents.set('doc',{blocks:[{type:'gallery_list',data:{pageSize:2}}]});
 const files=renderStaticWebsite(input).files,html=path=>Buffer.from(files.get(path)).toString();
 assert.match(html('index.html'),/Filter gallery by creator/);assert.match(html('index.html'),/All creators/);
 assert.match(html('creator/1/one/index.html'),/First artist/);assert.doesNotMatch(html('creator/1/one/index.html'),/Work 3/);
 assert.match(html('creator/1/one/page/1/2/index.html'),/Work 2/);assert.doesNotMatch(html('creator/1/one/page/1/2/index.html'),/Work 0/);
 input.documents.set('doc',{blocks:[{type:'gallery_list',data:{creatorIdentityIds:['two']}}]});
 const single=Buffer.from(renderStaticWebsite(input).files.get('index.html')).toString();assert.doesNotMatch(single,/Filter gallery by creator/);assert.doesNotMatch(single,/Work 0/);assert.match(single,/Work 3/);
 input.limits={maxPages:2,maxBytes:50*1024*1024};input.documents.set('doc',{blocks:[{type:'gallery_list',data:{pageSize:10}}]});assert.throws(()=>renderStaticWebsite(input),{code:'quota_exceeded'});
});

test('connected creators remain filterable even when their gallery is empty',()=>{const input=fixture();input.website.creatorIdentityId='one';input.creatorIdentities=[{id:'one',title:'First artist'},{id:'two',title:'Second artist'}];input.documents.set('doc',{blocks:[{type:'gallery_list'}]});const files=renderStaticWebsite(input).files;assert.match(Buffer.from(files.get('index.html')).toString(),/Second artist/);assert.match(Buffer.from(files.get('creator/1/two/index.html')).toString(),/No entries yet/);});
