import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { CommerceError } from '@ubeeq/commerce';
import { createReferenceCommerce } from '../dist/commerce.js';
import { commerceJavaScript, commerceHtml } from '../dist/commerce-page.js';

async function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'ubeeq-commerce-http-')),key='explicit-test-encryption-key-of-at-least-32-characters';
 const local=createLocalAdapterSet({databasePath:join(dir,'main.sqlite'),dataDirectory:dir,cellId:'cell',publicBaseUrl:'https://shop.example.test',credentialEncryptionKey:key});
 const state={hooks:[],orders:new Map(),captures:new Map(),refunds:new Map(),signature:'SUCCESS',mail:[],deleteFailure:false};
 const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
 const fetch=async(url,init)=>{const path=new URL(url).pathname;
  if(path==='/v1/oauth2/token')return json({access_token:'PRIVATE-token',token_type:'Bearer',expires_in:300});
  if(path==='/v1/notifications/verify-webhook-signature')return json({verification_status:state.signature});
  if(path==='/v1/notifications/webhooks'&&init.method==='GET')return json({webhooks:state.hooks});
  if(path==='/v1/notifications/webhooks'&&init.method==='POST'){const h={...JSON.parse(init.body),id:'HOOK-'+(state.hooks.length+1)};state.hooks.push(h);return json(h,201);}
  if(path.startsWith('/v1/notifications/webhooks/')&&init.method==='DELETE'){if(state.deleteFailure)return json({},503);state.hooks=state.hooks.filter(h=>h.id!==path.split('/').at(-1));return new Response(null,{status:204});}
  if(path==='/v2/checkout/orders'&&init.method==='POST'){const b=JSON.parse(init.body),id='ORDER-'+(state.orders.size+1);b.purchase_units[0].payee={merchant_id:'MERCHANT'};const order={...b,id,status:'CREATED',links:[{rel:'payer-action',href:'https://www.sandbox.paypal.com/checkoutnow?token='+id}]};state.orders.set(id,order);return json(order,201);}
  const orderId=path.split('/')[4],order=state.orders.get(orderId);
  if(path.startsWith('/v2/checkout/orders/')&&init.method==='GET')return json(order);
  if(path.endsWith('/capture')&&init.method==='POST'){assert.equal(order.status,'APPROVED');const capture={id:'CAPTURE-'+orderId,status:'COMPLETED',amount:order.purchase_units[0].amount,update_time:new Date().toISOString(),supplementary_data:{related_ids:{order_id:orderId}}};order.purchase_units[0].payments={captures:[capture]};order.payer={email_address:'buyer@example.test'};order.status='COMPLETED';state.captures.set(capture.id,capture);return json(order,201);}
  if(path.startsWith('/v2/payments/captures/'))return json(state.captures.get(path.split('/').at(-1)));
  if(path.startsWith('/v2/payments/refunds/'))return json(state.refunds.get(path.split('/').at(-1)));
  throw Error('Unexpected mocked path '+path);
 };
 const runtime=createReferenceCommerce({tokenKey:key,environments:['sandbox'],financialRetentionDays:2555,publicBaseUrl:'https://shop.example.test',mail:{send:async m=>state.mail.push(m)},fetch},
  {deploymentId:'deployment',cellId:'cell',publicBaseUrl:'https://shop.example.test',dataDirectory:dir,vault:local.credentials,storage:local.storage,
   subject:async req=>{if(req.headers.authorization==='Bearer creator-session')return 'creator-subject';throw new CommerceError('authentication_required',401);},
   creator:async subject=>{if(subject!=='creator-subject')throw new CommerceError('creator_not_found',404);return {id:'creator',homeCellId:'cell'};},contentAvailable:async()=>true});
 t.after(()=>{runtime.close();rmSync(dir,{recursive:true,force:true});});
 const request=async(path,{method='GET',body,token,headers={}}={})=>{const req=new PassThrough();req.method=method;req.url=path;req.headers={...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers};req.socket={remoteAddress:'127.0.0.1'};
  let data;const response={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(value){data=Buffer.from(value??'');}};
  const pending=runtime.handle(req,response,new URL(path,'https://shop.example.test'));req.end(body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body));assert.equal(await pending,true);
  let parsed;try{parsed=JSON.parse(data.toString());}catch{parsed=data.toString();}return {status:response.statusCode,body:parsed,bytes:data,headers:response.headers};};
 const drain=async()=>{for(let i=0;i<100;i++)if(!await runtime.runNextJob('worker'))return;throw Error('job loop');};
 const creator=(path,method='GET',body)=>request(path,{method,body,token:'creator-session'});
 const connect=async()=>{const result=await creator('/api/connections/paypal','POST',{environment:'sandbox',clientId:'client-app',clientSecret:'PRIVATE-secret'});assert.equal(result.status,200);return result.body.connection;};
 const login=async()=>{await request('/api/auth/email',{method:'POST',body:{email:'buyer@example.test'}});await drain();const link=new URL(state.mail.at(-1).text);const result=await request('/api/auth/email/redeem',{method:'POST',body:{id:link.searchParams.get('id'),token:link.searchParams.get('token')}});assert.equal(result.status,200);return result.body.token;};
 const upload=async()=>{const result=await creator('/api/commerce/assets','POST',{environment:'sandbox',label:'private.png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='});assert.equal(result.status,201);return result.body.asset;};
 const offer=async asset=>{const result=await creator('/api/offers','POST',{environment:'sandbox',slug:'gallery',title:'Purchased gallery',description:'Private photos',amountMinor:1000,currency:'USD',files:[asset.id],previews:[],benefits:[{type:'gallery',resourceId:'gallery'},{type:'download',resourceId:asset.id}],terms:'One-time access. Contact support for refunds.',supportEmail:'creator@example.test'});assert.equal(result.status,201);return result.body.offer;};
 const webhook=async(connection,event)=>request('/api/webhooks/paypal/'+connection.id,{method:'POST',body:event,headers:{'paypal-cert-url':'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123','paypal-auth-algo':'SHA256withRSA','paypal-transmission-id':'transmission','paypal-transmission-sig':'signature','paypal-transmission-time':new Date().toISOString()}});
 return {runtime,request,creator,connect,login,upload,offer,webhook,drain,state};
}

test('customer magic links create scoped sessions without creator authority and cannot be reused',async t=>{
 const f=await fixture(t),token=await f.login();assert.equal((await f.request('/api/me',{token})).body.verifiedEmails[0],'buyer@example.test');
 assert.equal((await f.request('/api/connections/paypal',{token})).status,401);
 const link=new URL(f.state.mail[0].text);assert.equal((await f.request('/api/auth/email/redeem',{method:'POST',body:{id:link.searchParams.get('id'),token:link.searchParams.get('token')}})).status,403);
 assert.equal((await f.request('/api/me')).status,401);
});

test('HTTP checkout, verified webhook, capture, gallery, download and full refund form a durable flow',async t=>{
 const f=await fixture(t),connection=await f.connect(),asset=await f.upload(),offer=await f.offer(asset),token=await f.login();
 const created=await f.request('/api/checkouts',{method:'POST',token,headers:{'idempotency-key':'browser-purchase-123'},body:{offerVersionId:offer.id,amountMinor:1}});assert.equal(created.status,202);
 await f.drain();let order=(await f.request('/api/checkouts/'+created.body.order.id,{token})).body.order;assert.equal(order.amountMinor,1000);assert.equal(order.state,'pending');
 assert.equal((await f.request('/api/downloads/'+asset.id+'/authorize',{method:'POST',token,body:{}})).status,403);
 f.state.signature='FAILURE';assert.equal((await f.webhook(connection,{id:'FORGED',event_type:'CHECKOUT.ORDER.APPROVED',resource:{id:order.providerOrderId}})).status,400);assert.equal((await f.request('/api/me/purchases',{token})).body.purchases.length,0);
 f.state.signature='SUCCESS';f.state.orders.get(order.providerOrderId).status='APPROVED';
 const event={id:'APPROVED',event_type:'CHECKOUT.ORDER.APPROVED',resource:{id:order.providerOrderId}};assert.equal((await f.webhook(connection,event)).body.status,'accepted');assert.equal((await f.webhook(connection,event)).body.status,'duplicate');
 await f.drain();const purchases=(await f.request('/api/me/purchases',{token})).body.purchases;assert.equal(purchases.length,1);assert.equal(purchases[0].entitlements.length,2);
 const gallery=await f.request('/api/me/gallery?purchase='+purchases[0].id,{token});assert.equal(gallery.status,200);assert.ok(gallery.body.html.includes('data-gallery-root'));
 const signed=await f.request('/api/downloads/'+asset.id+'/authorize',{method:'POST',token,body:{}}),download=await f.request(new URL(signed.body.url).pathname+new URL(signed.body.url).search);assert.equal(download.status,200);assert.equal(download.headers['cache-control'],'private, no-store');assert.ok(download.bytes.length>0);
 const capture=f.state.captures.get('CAPTURE-'+order.providerOrderId);capture.status='REFUNDED';f.state.refunds.set('REFUND-1',{id:'REFUND-1',status:'COMPLETED',amount:capture.amount,links:[{rel:'up',href:'https://api.sandbox.paypal.com/v2/payments/captures/'+capture.id}]});
 await f.webhook(connection,{id:'REFUNDED',event_type:'PAYMENT.CAPTURE.REFUNDED',resource:{id:'REFUND-1'}});await f.drain();
 assert.equal((await f.request('/api/me/purchases',{token})).body.purchases[0].state,'revoked');assert.equal((await f.request(new URL(signed.body.url).pathname+new URL(signed.body.url).search)).status,403);
 assert.equal((await f.creator('/api/connections/paypal?environment=sandbox')).body.connection.state,'verified');
});

test('callback storage failure is retryable; invalid signatures, oversized requests and unauthorized origins fail safely',async t=>{
 const f=await fixture(t),connection=await f.connect(),original=f.runtime.store.acceptEvent.bind(f.runtime.store);f.runtime.store.acceptEvent=async()=>{throw Error('PRIVATE database detail');};
 const event={id:'EVENT',event_type:'PAYMENT.CAPTURE.PENDING',resource:{id:'capture'}};let result=await f.webhook(connection,event);assert.equal(result.status,503);assert.equal(JSON.stringify(result.body).includes('PRIVATE'),false);
 f.runtime.store.acceptEvent=original;assert.equal((await f.webhook(connection,event)).status,200);
 assert.equal((await f.request('/api/storefront?owner=creator&environment=sandbox',{headers:{origin:'https://evil.example.test'}})).status,403);
 assert.equal((await f.request('/api/webhooks/paypal/'+connection.id,{method:'POST',body:'x'.repeat(1024*1024+1)})).status,413);
});

test('app migration retains the old scoped callback and credentials; disconnect exposes cleanup failure',async t=>{
 const f=await fixture(t),first=await f.connect();
 assert.equal((await f.creator('/api/connections/paypal','POST',{environment:'sandbox',clientId:'new-app',clientSecret:'PRIVATE-new'})).status,400);
 const result=await f.creator('/api/connections/paypal','POST',{environment:'sandbox',clientId:'new-app',clientSecret:'PRIVATE-new',migrationUntil:new Date(Date.now()+86400000).toISOString()});assert.equal(result.status,200);assert.notEqual(result.body.connection.id,first.id);
 const all=await f.runtime.store.listConnections();assert.equal(all.length,2);assert.ok(all.find(c=>c.id===first.id).drainingUntil);assert.equal(f.state.hooks.length,2);
 f.state.deleteFailure=true;const failed=await f.creator('/api/connections/paypal','DELETE',{environment:'sandbox'});assert.equal(failed.body.connection.state,'action_required');assert.equal(failed.body.connection.lastError,'provider_outcome_unknown');
 f.state.deleteFailure=false;assert.equal((await f.creator('/api/connections/paypal','DELETE',{environment:'sandbox'})).body.connection.state,'disconnected');assert.equal(f.state.hooks.length,1);
});

test('responsive pages reuse the gallery viewer and never embed credentials or private asset references',()=>{
 new Function(commerceJavaScript);assert.ok(commerceHtml.includes('width=device-width'));assert.ok(commerceHtml.includes('website-gallery-viewer'));assert.ok(!commerceHtml.includes('PRIVATE-secret'));
 assert.ok(commerceHtml.includes('Preparing')===false); // Dynamic package status is generated after authenticated retrieval.
});
