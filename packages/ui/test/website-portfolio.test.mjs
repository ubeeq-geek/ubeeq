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

test('every purpose renders with every visual style without rewriting its content',async()=>{
 const{WEBSITE_INTENTS,WEBSITE_THEMES,websiteIntentBlocks}=await import('@ubeeq/core');
 assert.equal(WEBSITE_INTENTS.length,12);assert.equal(WEBSITE_THEMES.length,14);
 for(const intent of WEBSITE_INTENTS){const blocks=websiteIntentBlocks(intent.id,'home',()=>crypto.randomUUID()),before=JSON.stringify(blocks);for(const style of WEBSITE_THEMES){const input=fixture(style.id);input.website.intent=intent.id;input.documents.set('doc',{blocks});websiteRoutes(input.website);const html=renderStaticWebsite(input).files.get('index.html');assert.match(html,new RegExp('theme-'+style.id));assert.doesNotMatch(html,/<script|<form|482913/);assert.equal(JSON.stringify(blocks),before);}}
});
test('purpose controls booking or release actions independently of visual style',()=>{
 const input=fixture('nocturne');input.website.intent='photography';input.website.theme.settings.bookingUrl='https://platform.example/photography/artist';assert.match(renderStaticWebsite(input).files.get('index.html').split('</header>')[0],/>Book a session<\/a>/);
 input.website.theme.id='organic';input.website.intent='music';input.website.theme.settings.releaseUrl='https://platform.example/releases/latest';assert.match(renderStaticWebsite(input).files.get('index.html').split('</header>')[0],/>Buy the release<\/a>/);
});
test('podcast feeds and collective creator sections use explicitly approved data',async()=>{
 const{websiteIntentBlocks}=await import('@ubeeq/core'),input=fixture('minimal');input.website.intent='podcast';input.website.theme.settings.podcastFeedUrl='https://podcast.example/feed.xml';input.documents.set('doc',{blocks:websiteIntentBlocks('podcast','home',()=>crypto.randomUUID())});let html=renderStaticWebsite(input).files.get('index.html');assert.match(html,/rel="alternate" type="application\/rss\+xml"/);assert.match(html,/section-episodes/);assert.doesNotMatch(html,/private feed|Ads are gone/);
 input.website.intent='collective';input.creatorIdentities=[{id:'one',title:'First artist'},{id:'two',title:'Second & artist'}];input.documents.set('doc',{blocks:websiteIntentBlocks('collective','team',()=>crypto.randomUUID())});html=renderStaticWebsite(input).files.get('index.html');assert.match(html,/First artist/);assert.match(html,/Second &amp; artist/);
});

test('configured platform mailing signup renders a native opt-in form with public offers',()=>{
 const input=fixture();input.website.basePath='/artist/';input.routes=new Map([['home','/']]);input.website.theme.settings.mailingListUrl='https://platform.example/mailing/creator';input.mailingList={signupUrl:input.website.theme.settings.mailingListUrl,submitUrl:'https://api.example/api/public/mailing-list/creator/subscribe-form',consentText:'Receive letters from the artist. Unsubscribe any time.',offers:[{id:'print',title:'Free <print>'}]};
 const html=renderStaticWebsite(input).files.get('index.html');assert.match(html,/<form class="website-mailing-form"/);assert.match(html,/method="post" action="https:\/\/api.example\/api\/public\/mailing-list\/creator\/subscribe-form"/);assert.match(html,/type="email" name="email"/);assert.match(html,/type="checkbox" name="consent" value="true" required/);assert.doesNotMatch(html,/name="consent"[^>]*checked/);assert.match(html,/Free &lt;print&gt;/);assert.match(html,/href="\/artist\//);
 input.website.theme.settings.mailingListUrl='https://other.example/signup';assert.doesNotMatch(renderStaticWebsite(input).files.get('index.html'),/<form/);
});

test('embedding validates exact origins and generates escaped subdirectory iframe code',async()=>{
 const {websiteEmbeddingOrigins,websiteEmbedCode,websiteFrameAncestors}=await import('@ubeeq/core');const input=fixture();input.website.embedding={mode:'selected',origins:['https://parent.example'],pageId:'home',presentation:'content',height:700};input.website.title='Art "and" <more>';
 assert.deepEqual(websiteEmbeddingOrigins(['https://parent.example/','https://parent.example']),['https://parent.example']);
 for(const value of ['https://*.example','https://%2a.example','https://%27self%27.example','https://parent.example/path','https://user@parent.example','https://parent.example?x=1',"https://parent.example; frame-src *",'javascript:alert(1)'])assert.throws(()=>websiteEmbeddingOrigins([value]));
 const code=websiteEmbedCode(input.website,'https://site.example/portfolio/');assert.match(code,/src="https:\/\/site.example\/portfolio\/embed\/"/);assert.match(code,/height="700"/);assert.match(code,/&quot;and&quot; &lt;more&gt;/);assert.doesNotMatch(code,/srcdoc|<script/);
 assert.equal(websiteFrameAncestors({mode:'disabled',origins:[]}),"'none'");assert.equal(websiteFrameAncestors({mode:'any',origins:[]}),'*');assert.throws(()=>websiteFrameAncestors({mode:'selected',origins:[]}));
 input.website.embedding.height=199;assert.throws(()=>websiteEmbedCode(input.website,'https://site.example/'));
});
test('embed views preserve subpath routing, omit selected chrome and open platform flows separately',()=>{
 const input=fixture();input.website.basePath='/portfolio/';input.website.pages.push({id:'about',websiteId:'site',workspaceId:'creator',revision:1,slug:'about',documentId:'about-doc',kind:'page',title:'About',template:'standard',state:'ready',navigation:true,order:1});input.routes=new Map([['home','/'],['about','/about/']]);input.documents.set('about-doc',{blocks:[{id:'return',type:'page_link',data:{pageId:'home'}}]});input.website.embedding={mode:'selected',origins:['https://parent.example'],pageId:'about',presentation:'content',height:800};input.website.theme.settings.membershipUrl='https://platform.example/checkout';
 const files=renderStaticWebsite(input).files,html=files.get('embed/index.html');assert.ok(html);assert.match(files.get('index.html'),/<header/);assert.doesNotMatch(html,/<header|<footer/);assert.match(html,/noindex,nofollow/);assert.match(html,/href="\/portfolio\/assets\/theme.css"/);assert.match(html,/href="https:\/\/platform.example\/checkout"[^>]*target="_blank"/);assert.match(files.get('embed/about/index.html'),/href="\/portfolio\/embed\/"/);assert.match(files.get('_headers'),/\/portfolio\/\*\n  Content-Security-Policy: frame-ancestors https:\/\/parent.example/);
 input.website.embedding.presentation='full';assert.match(renderStaticWebsite(input).files.get('embed/index.html'),/<header/);
 input.website.embedding.mode='disabled';assert.equal(renderStaticWebsite(input).files.has('embed/index.html'),false);
});
