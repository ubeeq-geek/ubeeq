import test from 'node:test';
import assert from 'node:assert/strict';
import {websitePresetBlocks,WEBSITE_THEMES,websiteRoutes} from '@ubeeq/core';
import {renderStaticWebsite} from '../dist/index.js';
const fixture=(preset='nocturne')=>{
 let id=0;const page={id:'home',websiteId:'site',workspaceId:'creator',revision:1,slug:'',documentId:'doc',kind:'home',title:'Artist portfolio',template:'portfolio',coverAssetId:'cover',state:'ready',navigation:true,order:0};
 return {apiVersion:'1',website:{id:'site',workspaceId:'creator',creatorIdentityId:'creator',revision:1,homePageId:'home',galleryDefault:{destination:{mode:'local'}},mediaMode:'bundled',galleryPublicationIds:[],title:'My work',locale:'en',basePath:'/',theme:{id:preset,version:'1',settings:{}},pages:[page],redirects:[]},routes:new Map([['home','/']]),documents:new Map([['doc',{blocks:websitePresetBlocks(preset,'home',()=>String(++id))}]]),media:new Map([['cover',{src:'/assets/cover.jpg',mimeType:'image/jpeg',alt:'My cover'}]]),galleries:[]};
};
test('both portfolio presets use editable blocks, distinct palettes and responsive hero styling',()=>{
 for(const preset of ['modernist','nocturne']){const input=fixture(preset);websiteRoutes(input.website);const files=renderStaticWebsite(input).files;const html=files.get('index.html');assert.match(html,new RegExp('theme-'+preset));assert.match(html,/template-portfolio/);assert.match(html,/section-intro/);assert.match(files.get('assets/theme.css'),/grid-row:3/);assert.match(html,/My cover/);assert.doesNotMatch(html,/<form|<script|type="email"|Pay \$/);}
 assert.notEqual(WEBSITE_THEMES.find(t=>t.id==='modernist').dark.canvas,WEBSITE_THEMES.find(t=>t.id==='nocturne').dark.canvas);
});
test('platform actions resolve current settings and unconfigured actions do not pretend to work',()=>{
 const input=fixture();let html=renderStaticWebsite(input).files.get('index.html');assert.doesNotMatch(html,/>Join the mailing list<\/a>|>Explore membership<\/a>/);
 input.website.theme.settings={mailingListUrl:'https://platform.example/offers/artist',membershipUrl:'https://platform.example/membership/artist',memberAccountUrl:'https://platform.example/account'};
 html=renderStaticWebsite(input).files.get('index.html');assert.match(html,/href="https:\/\/platform.example\/offers\/artist">Join the mailing list/);assert.match(html,/Member account/);
 input.website.theme.settings.mailingListUrl='https://platform.example/offers/new';assert.match(renderStaticWebsite(input).files.get('index.html'),/offers\/new/);
 input.website.theme.settings.mailingListUrl='javascript:alert(1)';assert.throws(()=>websiteRoutes(input.website));assert.throws(()=>renderStaticWebsite(input));
});
test('membership page has editable plans and accessible questions without fabricated prices',()=>{
 const input=fixture();input.documents.set('doc',{blocks:websitePresetBlocks('modernist','membership',()=>crypto.randomUUID())});const html=renderStaticWebsite(input).files.get('index.html');assert.match(html,/section-pricing/);assert.match(html,/<details class="website-faq"><summary>/);assert.doesNotMatch(html,/\$\d|<form|<script/);
});
test('premium cards link approved previews to the access destination',()=>{
 const input=fixture();input.media.set('preview',{src:'/assets/public.jpg',mimeType:'image/jpeg',alt:'Approved public preview'});input.galleries=[{publicationId:'premium',title:'Members gallery',href:'https://platform.example/gallery/1',local:false,premium:true,previewAssetIds:['preview'],publicAssetIds:[],tags:[],collectionIds:[],date:'2026-10-20'}];const html=renderStaticWebsite(input).files.get('index.html');assert.match(html,/href="https:\/\/platform.example\/gallery\/1"><img/);assert.match(html,/Public preview · membership access/);assert.doesNotMatch(html,/Download|unlocked|8K/);
});

test('photography, cinema and literary starters stay editable and use configured action URLs',()=>{
 for(const [preset,variant]of[['organic','intro'],['cinema','screening'],['literary','excerpt'],['broadsheet','release']]){const input=fixture(preset);input.documents.set('doc',{blocks:websitePresetBlocks(preset,'home',()=>crypto.randomUUID())});input.website.theme.settings={bookingUrl:'https://platform.example/photography/artist',clientGalleryUrl:'https://platform.example/photography/artist/clients',trailerUrl:'https://video.example/trailer'};websiteRoutes(input.website);const html=renderStaticWebsite(input).files.get('index.html');assert.match(html,new RegExp('section-'+variant));assert.doesNotMatch(html,/<script|<form|482913|Pay \$|unlocked/);if(preset==='cinema')assert.match(html,/https:\/\/video.example\/trailer/);if(preset==='organic')assert.match(html,/https:\/\/platform.example\/photography\/artist/);}
});
