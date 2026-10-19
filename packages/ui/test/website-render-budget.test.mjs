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
