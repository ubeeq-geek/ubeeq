import test from 'node:test';
import assert from 'node:assert/strict';
import {websiteRoutes} from '@ubeeq/core';
import {removeWebsitePage} from '../dist/website-page-actions.js';
const fixture=()=>({id:'site',workspaceId:'creator',creatorIdentityId:'creator',revision:1,title:'My website',locale:'en',basePath:'/',homePageId:'home',galleryDefault:{destination:{mode:'local'}},mediaMode:'bundled',galleryPublicationIds:[],theme:{id:'neutral',version:'1',settings:{}},pages:[{id:'home',kind:'home',slug:'',title:'Home'},{id:'about',kind:'page',slug:'about',title:'About'},{id:'child',kind:'page',slug:'team',title:'Team',parentId:'about',navigationParentId:'about',footerNavigationParentId:'about'}].map((page,order)=>({...page,order,revision:1,websiteId:'site',workspaceId:'creator',state:'ready',navigation:true,footerNavigation:true,documentId:'shared-document'})),redirects:[{from:'/old-about/',to:'/about/',status:301},{from:'/old-team/',to:'/about/team/',status:301}],embedding:{mode:'selected',origins:['https://parent.example'],pageId:'about',presentation:'full',height:600}});
test('page deletion promotes child pages, cleans menus/redirects and resets embed entry without mutating source',()=>{
 const site=fixture(),before=structuredClone(site),next=removeWebsitePage(site,'about');
 assert.deepEqual(site,before);assert.equal(next.pages.length,2);assert.equal(next.pages[1].parentId,undefined);assert.equal(next.pages[1].navigationParentId,null);assert.equal(next.pages[1].footerNavigationParentId,null);assert.equal(next.pages[1].documentId,'shared-document');assert.equal(next.embedding.pageId,'home');assert.deepEqual(next.redirects,[{from:'/old-team/',to:'/team/',status:301}]);websiteRoutes(next);
});
test('homepage deletion requires a Ready replacement and preserves valid page hierarchy',()=>{
 const site=fixture();assert.throws(()=>removeWebsitePage(site,'home'),/Choose a Ready page/);site.redirects.push({from:'/start/',to:'/',status:301});const next=removeWebsitePage(site,'home','about');assert.ok(next.redirects.some(redirect=>redirect.from==='/start/'&&redirect.to==='/'));assert.equal(next.homePageId,'about');assert.equal(next.pages[0].kind,'home');assert.equal(next.pages[0].slug,'');assert.equal(next.pages[1].parentId,undefined);websiteRoutes(next);
 assert.throws(()=>removeWebsitePage({...site,pages:[site.pages[0]]},'home'),/only page/);
 assert.throws(()=>removeWebsitePage({...site,pages:site.pages.map(page=>page.id==='about'?{...page,state:'draft'}:page)},'home','about'),/Ready page/);
});
