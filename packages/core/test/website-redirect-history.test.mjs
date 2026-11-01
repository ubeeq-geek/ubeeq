import test from 'node:test';
import assert from 'node:assert/strict';
import {websiteHistoricalRedirects,websiteRoutes} from '../dist/index.js';
const fixture=()=>({id:'site',workspaceId:'creator',creatorIdentityId:'creator',revision:1,title:'Portfolio',locale:'en',homePageId:'home',theme:{id:'neutral',version:'1',settings:{}},mediaMode:'bundled',basePath:'/',galleryDefault:{destination:{mode:'local'}},galleryPublicationIds:[],redirects:[],pages:[{id:'home',websiteId:'site',workspaceId:'creator',revision:1,documentId:'home-doc',kind:'home',title:'Home',slug:'',order:0,state:'ready',navigation:true},{id:'about',websiteId:'site',workspaceId:'creator',revision:1,documentId:'about-doc',kind:'page',title:'About',slug:'about',order:1,state:'ready',navigation:true}],namedGalleries:[{id:'parent',title:'Main',slug:'main',kind:'galleries',access:'free',publicationIds:[]},{id:'child',parentId:'parent',title:'Collection',slug:'collection',kind:'works',access:'free',publicationIds:[]}]});
const save=(next,old,published)=>{next.redirects=websiteHistoricalRedirects(next,old,published);websiteRoutes(next);return next;};

test('gallery parent and page renames retain published routes by identity, including older aliases',()=>{
 const published=fixture();published.redirects=[{from:'/biography/',to:'/about/',status:301}];const next=structuredClone(published);
 next.pages[1].slug='artist';next.namedGalleries[0].slug='portfolio';
 save(next,published,[published]);
 assert.deepEqual(next.redirects,[{from:'/biography/',to:'/artist/',status:301},{from:'/about/',to:'/artist/',status:301},{from:'/galleries/collections/main/',to:'/galleries/collections/portfolio/',status:301},{from:'/galleries/collections/main/collection/',to:'/galleries/collections/portfolio/collection/',status:301}]);
});

test('successive published renames go directly to the latest path; draft-only intermediate paths do not persist',()=>{
 const a=fixture(),b=structuredClone(a);b.namedGalleries[1].slug='second';save(b,a,[a]);
 const draft=structuredClone(b);draft.namedGalleries[1].slug='temporary';save(draft,b,[b,a]);
 const c=structuredClone(draft);c.namedGalleries[1].slug='latest';save(c,draft,[b,a]);
 assert.deepEqual(c.redirects.map(r=>[r.from,r.to]),[['/galleries/collections/main/collection/','/galleries/collections/main/latest/'],['/galleries/collections/main/second/','/galleries/collections/main/latest/']]);
});

test('returning to a published path restores the resource without a self redirect',()=>{
 const a=fixture(),b=structuredClone(a);b.pages[1].slug='artist';save(b,a,[a]);const again=structuredClone(b);again.pages[1].slug='about';save(again,b,[b,a]);
 assert.deepEqual(again.redirects,[{from:'/artist/',to:'/about/',status:301}]);
});

test('title-only changes, unrelated history and draft-only paths generate no redirect',()=>{
 const a=fixture(),b=structuredClone(a);b.title='Renamed';b.namedGalleries[1].title='New title';save(b,a,[a]);assert.deepEqual(b.redirects,[]);
 b.pages[1].slug='new';save(b,a,[{...a,id:'other'},{...a,workspaceId:'other'}]);assert.deepEqual(b.redirects,[]);
});

test('live paths win over historical aliases and removed resources do not gain redirects',()=>{
 const a=fixture(),b=structuredClone(a);b.pages[1].slug='artist';b.pages.push({...a.pages[1],id:'replacement',documentId:'replacement-doc'});b.namedGalleries=[];save(b,a,[a]);assert.deepEqual(b.redirects,[]);
});

test('most recent published owner wins when a historical path was reused',()=>{
 const a=fixture(),b=fixture();b.pages[1]={...b.pages[1],id:'replacement'};
 const c=fixture();c.pages[1].slug='artist';c.pages.push({...b.pages[1],slug:'replacement'});save(c,b,[b,a]);assert.equal(c.redirects.find(r=>r.from==='/about/').to,'/replacement/');
});

test('gallery redirects cannot target unknown routes, chains, private drafts, or reserved assets',()=>{
 for(const redirect of [{from:'/old/',to:'/missing/',status:301},{from:'/assets/old/',to:'/about/',status:301},{from:'/galleries/work/',to:'/about/',status:301},{from:'/old/',to:'/old/',status:301}]){const s=fixture();s.redirects=[redirect];assert.throws(()=>websiteRoutes(s));}
 const s=fixture();s.pages[1].state='draft';s.redirects=[{from:'/old/',to:'/about/',status:301}];assert.throws(()=>websiteRoutes(s));
});


test('removing a previously renamed gallery also removes its now-invalid aliases',()=>{
 const a=fixture(),b=structuredClone(a);b.namedGalleries[1].slug='new';save(b,a,[a]);
 const removed=structuredClone(b);removed.namedGalleries=[];save(removed,b,[b,a]);assert.deepEqual(removed.redirects,[]);
});
