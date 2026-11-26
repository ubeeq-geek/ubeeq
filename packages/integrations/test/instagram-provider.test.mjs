import test from 'node:test';
import assert from 'node:assert/strict';
import {InstagramProvider,InstagramProviderError} from '../dist/instagram-provider.js';
const configuration={appId:'actual-unit-application',appSecret:'actual-unit-private-secret',redirectUri:'https://actual-api.test/oauth',apiVersion:'v24.0',graphBaseUrl:'https://actual-graph.test',approvedCapabilities:{accountRead:true,imagePublish:true,carouselPublish:true}};
const json=(value,status=200,headers={})=>Response.json(value,{status,headers});
function protocol(replies){const calls=[];return{calls,request:async(input,init)=>{calls.push({url:new URL(String(input)),init});assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).get('user-agent'),'Ubeeq/1.0');assert.ok(replies.length,'No unplanned provider HTTP call.');const next=replies.shift();return typeof next==='function'?next(input,init):json(next);}};}
test('requires a pinned version and preserves original default and explicit authorization scopes',()=>{
 assert.throws(()=>new InstagramProvider({...configuration,apiVersion:'latest'}),/pinned/);
 const provider=new InstagramProvider(configuration),url=new URL(provider.createAuthorizationUrl('actual-nonce'));
 assert.equal(url.searchParams.get('state'),'actual-nonce');assert.ok(url.searchParams.get('scope').split(',').includes('pages_show_list'));
 assert.equal(new URL(provider.createAuthorizationUrl('actual-nonce',['instagram_basic'])).searchParams.get('scope'),'instagram_basic');
});
test('original and existing SDK authorization exchanges keep private credentials in the POST body and preserve expiry contracts',async()=>{
 const p=protocol([{access_token:'actual-reply-token',expires_in:3600},{access_token:'actual-reply-without-expiry'},{access_token:'actual-legacy-reply'}]),provider=new InstagramProvider(configuration,p.request);
 assert.deepEqual(await provider.exchangeAuthorizationCode('actual-code'),{accessToken:'actual-reply-token',expiresIn:3600});
 assert.deepEqual(await provider.exchangeAuthorizationCode('actual-code2'),{accessToken:'actual-reply-without-expiry',expiresIn:undefined});
 assert.deepEqual(await provider.exchangeCodeForToken('actual-code3'),{accessToken:'actual-legacy-reply',expiresIn:5184000});
 for(const {url,init}of p.calls){assert.equal(init.method,'POST');assert.equal(url.searchParams.has('client_secret'),false);assert.equal(url.searchParams.has('code'),false);assert.equal(new URLSearchParams(init.body).get('client_secret'),configuration.appSecret);}
});
test('restores actual professional account discovery and filters unsupported or incomplete accounts',async()=>{
 const p=protocol([{data:[{instagram_business_account:{id:'business',username:'actual-business',account_type:'BUSINESS'}},{instagram_business_account:{id:'creator',username:'actual-creator',account_type:'CREATOR'}},{instagram_business_account:{id:'personal',username:'actual-personal',account_type:'PERSONAL'}},{instagram_business_account:{id:'missing-name',account_type:'CREATOR'}}]}]);
 assert.deepEqual(await new InstagramProvider(configuration,p.request).getProfessionalAccounts('actual-access'),[{id:'business',username:'actual-business',accountType:'BUSINESS'},{id:'creator',username:'actual-creator',accountType:'CREATOR'}]);
 assert.equal(p.calls[0].url.pathname,'/v24.0/me/accounts');assert.equal(new Headers(p.calls[0].init.headers).get('authorization'),'Bearer actual-access');
});
test('connection capabilities intersect current connection state, actual connection flags and deployment approvals',async()=>{
 const provider=new InstagramProvider(configuration),connection={state:'CONNECTED',capabilities:{accountRead:true,imagePublish:true,carouselPublish:true,reelPublish:true,insightsRead:true}};
 const caps=await provider.getCapabilities(connection);assert.equal(caps.imagePublish,true);assert.equal(caps.reelPublish,false);assert.equal(caps.insightsRead,false);
 const disabled=await provider.getCapabilities({...connection,state:'DISCONNECTED'});assert.ok(Object.values(disabled).every(value=>!value));
});
test('publishing limit uses the actual provider endpoint and supports both existing graph base forms',async()=>{
 for(const graphBaseUrl of ['https://actual-graph.test','https://actual-graph.test/v24.0']){
  const p=protocol([{data:[{quota_usage:4}]}]);assert.deepEqual(await new InstagramProvider({...configuration,graphBaseUrl},p.request).getPublishingLimit('actual-access','actual-account'),{data:[{quota_usage:4}]});assert.equal(p.calls[0].url.pathname,'/v24.0/actual-account/content_publishing_limit');assert.equal(p.calls[0].url.searchParams.get('fields'),'config,quota_usage');
 }
});
test('container create, actual status read and publication remain separate explicit provider operations',async()=>{
 const p=protocol([{id:'actual-container'},{status_code:'FINISHED'},{id:'actual-media'}]),provider=new InstagramProvider(configuration,p.request);
 assert.equal(await provider.createContainer('actual-access','actual-account',{placement:'IMAGE',mediaUrl:'https://actual-delivery.test/opaque',accessibilityText:'Actual alt text'}),'actual-container');
 assert.equal(await provider.getContainerStatus('actual-access','actual-container'),'FINISHED');assert.equal(await provider.publishContainer('actual-access','actual-account','actual-container'),'actual-media');assert.equal(p.calls.length,3);
 assert.equal(new URLSearchParams(p.calls[0].init.body).get('alt_text'),'Actual alt text');assert.equal(new URLSearchParams(p.calls[2].init.body).get('creation_id'),'actual-container');
});
test('existing SDK create and publish entry points retain their argument order and result shapes',async()=>{
 const p=protocol([{id:'actual-legacy-container'},{id:'actual-legacy-media'}]),provider=new InstagramProvider(configuration,p.request);
 assert.equal(await provider.createMediaContainer('actual-account','actual-access',{placement:'IMAGE',mediaUrl:'https://actual-delivery.test/opaque'}),'actual-legacy-container');assert.deepEqual(await provider.publishMedia('actual-account','actual-access','actual-legacy-container'),{id:'actual-legacy-media'});
 assert.equal(p.calls[0].url.pathname,'/v24.0/actual-account/media');assert.equal(p.calls[1].url.pathname,'/v24.0/actual-account/media_publish');
});
test('ambiguous, missing and rate-limited provider replies retain distinct reconciliation classifications',async()=>{
 for(const [status,code]of [[503,'UNKNOWN'],[404,'NOT_FOUND'],[401,'AUTHENTICATION_REQUIRED'],[429,'RATE_LIMITED']]){
  const p=protocol([()=>json({error:{message:'actual explicit protocol rejection'}},status,{'retry-after':'90'})]),provider=new InstagramProvider(configuration,p.request);
  await assert.rejects(provider.publishContainer('actual-access','actual-account','actual-container'),error=>error instanceof InstagramProviderError&&error.code===code&&error.retryAfterSeconds===90);
 }
});
test('original disconnect revokes the real server-held authorization without exposing it in the URL',async()=>{
 const p=protocol([{success:true}]);await new InstagramProvider(configuration,p.request).revokeAuthorization('actual-access');assert.equal(p.calls[0].url.pathname,'/v24.0/me/permissions');assert.equal(p.calls[0].init.method,'DELETE');assert.equal(p.calls[0].url.searchParams.has('access_token'),false);
});
test('metadata import is paginated and bounded, preserves actual AI labels and never requests source download URLs',async()=>{
 const p=protocol([{data:[{id:'actual-ai',caption:'Actual reference',is_ai_generated:true},{id:'actual-unknown'}],paging:{cursors:{after:'actual-next'}}},{id:'actual-ai',is_ai_generated:true,media_product_type:'FEED'}]),provider=new InstagramProvider(configuration,p.request),page=await provider.listMedia('actual-access','actual-account','actual-before',500);
 assert.equal(page.items[0].isAiGenerated,true);assert.equal(page.items[1].isAiGenerated,undefined);assert.equal(page.nextCursor,'actual-next');assert.equal(p.calls[0].url.searchParams.get('limit'),'50');assert.equal(p.calls[0].url.searchParams.get('after'),'actual-before');assert.ok(!p.calls[0].url.searchParams.get('fields').split(',').includes('media_url'));
 const media=await provider.getMedia('actual-access','actual-ai');assert.equal(media.isAiGenerated,true);assert.equal(media.placement,'FEED');
});
test('aggregate insight normalizers retain period/value metadata without audience records',async()=>{
 const p=protocol([{data:[{name:'reach',period:'day',values:[{value:42}]},{name:'views',total_value:{value:90}},{name:'invalid',total_value:{value:'nonnumeric'}}]}]),provider=new InstagramProvider(configuration,p.request),result=await provider.getInsights('actual-access','actual-media',['reach','views']);
 assert.deepEqual(result.map(({metric,value})=>({metric,value})),[{metric:'reach',value:42},{metric:'views',value:90}]);assert.equal(result[0].period,'day');assert.equal(p.calls[0].url.searchParams.get('metric'),'reach,views');assert.deepEqual(await provider.getInsights('actual-access','actual-media',[]),[]);assert.equal(p.calls.length,1);
});
test('video Story uses the actual video placement and top-level AI assertions preserve unavailable/false values',async()=>{
 const p=protocol([{id:'actual-story'},{id:'actual-ai'},{id:'actual-no-assertion'}]),provider=new InstagramProvider(configuration,p.request);
 await provider.createContainer('actual-access','actual-account',{placement:'STORY',mediaUrl:'https://actual-delivery.test/video',video:true});const story=new URLSearchParams(p.calls[0].init.body);assert.equal(story.get('media_type'),'STORIES');assert.equal(story.get('video_url'),'https://actual-delivery.test/video');assert.equal(story.has('image_url'),false);
 await provider.createContainer('actual-access','actual-account',{placement:'IMAGE',mediaUrl:'https://actual-delivery.test/image',isAiGenerated:true});assert.equal(new URLSearchParams(p.calls[1].init.body).get('is_ai_generated'),'true');
 await provider.createContainer('actual-access','actual-account',{placement:'IMAGE',mediaUrl:'https://actual-delivery.test/image',isAiGenerated:false});assert.equal(new URLSearchParams(p.calls[2].init.body).has('is_ai_generated'),false);
});
test('carousel AI disclosure remains on the parent, and a child assertion rejects before any HTTP',async()=>{
 const p=protocol([{id:'actual-parent'}]),provider=new InstagramProvider(configuration,p.request);
 await assert.rejects(provider.createMediaContainer('actual-account','actual-access',{placement:'IMAGE',mediaUrl:'https://actual-delivery.test/child',carouselItem:true,isAiGenerated:true}),/carousel child/);assert.equal(p.calls.length,0);
 await provider.createContainer('actual-access','actual-account',{placement:'CAROUSEL',mediaUrl:'https://actual-delivery.test/first',children:['actual-child1','actual-child2'],isAiGenerated:true});const form=new URLSearchParams(p.calls[0].init.body);assert.equal(form.get('media_type'),'CAROUSEL');assert.equal(form.get('children'),'actual-child1,actual-child2');assert.equal(form.get('is_ai_generated'),'true');
});
