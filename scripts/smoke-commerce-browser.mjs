/** Optional real-Chromium UI smoke using a loopback-only, fictitious API fixture.
 * No provider credentials, provider calls or real customer data are used.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commerceHtml, commerceJavaScript } from '../apps/reference-api/dist/commerce-page.js';
import { renderWebsiteGalleryGroup, websiteGalleryViewerScript } from '@ubeeq/ui';

const output=process.env.UBEEQ_COMMERCE_SCREENSHOTS??'/tmp/ubeeq-commerce-browser';mkdirSync(output,{recursive:true});
const profile=mkdtempSync(join(tmpdir(),'commerce-chromium-'));
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const offer={id:'offer-1',offerId:'offer',version:1,ownerId:'creator',environment:'sandbox',slug:'gallery',title:'Autumn collection',description:'An independent creator’s private gallery and download collection.',amountMinor:1200,currency:'USD',files:['file-1'],previews:['preview-1'],terms:'One-time gallery and download access. Contact the creator for refund support.',supportEmail:'creator@example.test',published:true,benefits:[{type:'gallery',resourceId:'gallery'},{type:'download',resourceId:'file-1'}]};
const grant={id:'grant',source:'payment',state:'active',startsAt:'2026-01-01T00:00:00.000Z',assetIds:['file-1'],benefit:{type:'gallery',resourceId:'gallery'}};
const purchase={id:'purchase-1',ownerId:'creator',environment:'sandbox',state:'active',offer,payment:{id:'payment-1',state:'completed'},entitlements:[grant],packages:[],discord:[],discordInvites:[],discordJobs:[]};
let submitted=0;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 res.setHeader('cache-control','private, no-store');
 if(url.pathname==='/commerce/client.js'){res.setHeader('content-type','text/javascript');res.end(commerceJavaScript);return;}
 if(url.pathname==='/commerce/gallery.js'){res.setHeader('content-type','text/javascript');res.end(websiteGalleryViewerScript);return;}
 if(url.pathname.startsWith('/commerce')){res.setHeader('content-type','text/html');res.setHeader('content-security-policy',"default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");res.end(commerceHtml);return;}
 if(url.pathname==='/fixture.png'||url.pathname.startsWith('/api/previews/')){res.setHeader('content-type','image/png');res.end(pixel);return;}
 for await(const _chunk of req){} // Requests remain loopback fixtures; bodies are never logged.
 let data={};
 if(url.pathname==='/api/me')data={id:'customer',verifiedEmails:['buyer@example.test']};
 else if(url.pathname==='/api/storefront')data={offers:[offer]};
 else if(url.pathname==='/api/me/purchases')data={purchases:[purchase]};
 else if(url.pathname==='/api/me/access')data={entitlements:[grant],assets:[]};
 else if(url.pathname==='/api/me/gallery')data={html:renderWebsiteGalleryGroup([{id:'purchase-1',title:offer.title,href:'/commerce/purchases',photos:[{src:'/fixture.png',thumbnail:'/fixture.png',alt:'Purchased image',title:'Autumn'}]}],'purchase-1')};
 else if(url.pathname==='/api/commerce/history')data={offers:[offer],assets:[{id:'file-1',label:'Autumn.png',environment:'sandbox',state:'available',publicPreview:false}],payments:[{id:'payment-1',state:'completed',environment:'sandbox'}],purchases:[{id:'purchase-1',paymentId:'payment-1',customerId:'customer'}],jobs:[],discord:[],guilds:[],checkouts:[],connections:[]};
 else if(url.pathname==='/api/connections/paypal'){if(req.method==='POST')submitted++;data={connection:{id:'connection',state:'configured',maskedClientId:'••••-app',environment:'sandbox',webhookUrl:'https://merchant.example.test/api/webhooks/paypal/00000000-0000-0000-0000-000000000001',webhookId:'HOOK-1'}};}
 else if(url.pathname==='/api/downloads/file-1/authorize')data={url:'/fixture.png',expiresAt:new Date(Date.now()+300000).toISOString()};
 else {res.statusCode=404;data={error:{code:'fixture_route_missing'}};}
 res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const browser=spawn(process.env.CHROMIUM_PATH??'/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{let stderr='';const timeout=setTimeout(()=>reject(Error('Chromium debugging endpoint timed out')),15000);browser.stderr.on('data',chunk=>{stderr+=chunk;const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});browser.on('error',reject);browser.on('exit',code=>{if(code)reject(Error('Chromium exited '+code));});});
 socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let sequence=0;const waiting=new Map(),exceptions=[];
 socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const pending=waiting.get(message.id);if(!pending)return;waiting.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(Error(JSON.stringify(message.error))):pending.resolve(message.result);}else if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails.text+': '+(message.params.exceptionDetails.exception?.description??''));};
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{waiting.delete(id);reject(Error('CDP timeout: '+method));},15000);waiting.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 const target=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
 const call=(method,params={})=>send(method,params,sessionId);
 await call('Page.enable');await call('Runtime.enable');await call('Page.addScriptToEvaluateOnNewDocument',{source:"try{sessionStorage.setItem('ubeeq.commerce.session','fixture-session')}catch{}"});
 const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text+': '+result.exceptionDetails.exception?.description);return result.result.value;};
 const wait=async expression=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('DOM condition timed out: '+expression);};
 const screenshot=async name=>writeFileSync(join(output,name),(await call('Page.captureScreenshot',{format:'png'})).data,'base64');
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:base+'/commerce?owner=creator&environment=sandbox'});await wait("document.querySelector('#offers h3')?.textContent==='Autumn collection'");await evaluate("document.querySelector('#store').scrollIntoView()");await screenshot('desktop-storefront.png');
 await call('Page.navigate',{url:base+'/commerce/purchases'});await wait("document.querySelector('#purchaseList h3')?.textContent==='Autumn collection'");
 assert.equal(await evaluate("Array.from(document.querySelectorAll('#purchaseList button')).some(b=>b.textContent==='Download file')"),false,'gallery-only entitlements must not display download controls');
 await evaluate("Array.from(document.querySelectorAll('#purchaseList button')).find(b=>b.textContent==='Open gallery').click()");await wait("!!document.querySelector('[data-gallery-root] [aria-haspopup=dialog]')");await evaluate("document.querySelector('[data-gallery-open]').click()");await wait("document.querySelector('[data-gallery-dialog]').open");await screenshot('desktop-gallery.png');
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await call('Page.navigate',{url:base+'/commerce/creator'});await wait("!!document.querySelector('#history h3')");await evaluate("document.querySelector('#creator').scrollIntoView()");
 assert.ok(await evaluate('Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)<=innerWidth'),'mobile creator layout overflows');await screenshot('mobile-creator.png');
 await evaluate("document.querySelector('#paypal [name=clientId]').value='test-app';document.querySelector('#paypal [name=clientSecret]').value='test-paypal-secret';document.querySelector('#paypal').requestSubmit()");
 await wait("document.querySelector('#notice').textContent.includes('connection configured') && document.querySelector('#paypal [name=clientSecret]').value===''");assert.equal(submitted,1);
 assert.equal(await evaluate("JSON.stringify({...sessionStorage,...localStorage}).includes('test-paypal-secret')"),false);
 await call('Page.navigate',{url:base+'/commerce/purchases'});await wait("!!document.querySelector('#purchaseList h3')");await evaluate("document.querySelector('#purchases').scrollIntoView()");
 assert.ok(await evaluate('Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)<=innerWidth'),'mobile purchases layout overflows');await screenshot('mobile-purchases.png');
 assert.deepEqual(exceptions,[]);console.log('Chromium smoke passed: storefront, shared gallery viewer, creator credential submission, mobile layout, purchases; screenshots: '+output);
}finally{socket?.close();browser.kill('SIGKILL');await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>setTimeout(resolve,100));rmSync(profile,{recursive:true,force:true});}
