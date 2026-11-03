import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalCommerceProvider, PayPalClient, DiscordCommerceClient } from '../dist/index.js';

const scope={deploymentId:'deployment',ownerId:'creator',environment:'sandbox'};
const json=(value,status=200,headers)=>new Response(JSON.stringify(value),{status,headers});
function paypal(){
 const state={calls:[],captureStatus:'COMPLETED',merchant:'merchant',refundCurrency:'USD',certificate:false};
 const order={id:'ORDER',status:'COMPLETED',purchase_units:[{custom_id:'reference',amount:{currency_code:'USD',value:'10.00'},payee:{merchant_id:'merchant'},items:[{sku:'SKU',quantity:'1'}],payments:{captures:[{id:'CAPTURE'}]}}],payer:{email_address:'buyer@example.test'}};
 const fetch=async(url,init)=>{state.calls.push({url,init});assert.equal(init.redirect,'error');const path=new URL(url).pathname;
  if(path==='/v1/oauth2/token')return json({access_token:'SECRET',token_type:'Bearer',expires_in:300});
  if(path==='/v2/checkout/orders'&&init.method==='POST'){assert.equal(init.headers['PayPal-Request-Id'],'reference');assert.equal(JSON.parse(init.body).purchase_units[0].amount.value,'10.00');return json({id:'ORDER',links:[{rel:'payer-action',href:'https://www.sandbox.paypal.com/checkoutnow?token=ORDER'}]});}
  if(path==='/v2/checkout/orders/ORDER')return json({...order,purchase_units:order.purchase_units.map(u=>({...u,payee:{merchant_id:state.merchant}}))});
  if(path==='/v2/payments/captures/CAPTURE')return json({id:'CAPTURE',status:state.captureStatus,amount:{currency_code:'USD',value:'10.00'},update_time:'2026-11-01T12:00:00Z',supplementary_data:{related_ids:{order_id:'ORDER'}}});
  if(path==='/v2/payments/refunds/REFUND')return json({id:'REFUND',status:'COMPLETED',amount:{currency_code:state.refundCurrency,value:'4.00'},links:[{rel:'up',href:'https://api.sandbox.paypal.com/v2/payments/captures/CAPTURE'}]});
  throw Error('Unexpected '+path);
 };
 return {state,order,provider:new PayPalCommerceProvider({publicBaseUrl:'https://shop.example.test',fetch,credentials:async()=>({clientId:'app',clientSecret:'SECRET',merchantId:'merchant'})})};
}
test('PayPal checkout pins server amount, local correlation, provider payee and a stable idempotency key',async()=>{
 const f=paypal(),order={...scope,id:'local',connectionId:'connection',reference:'reference',currency:'USD',amountMinor:1000,merchantId:'merchant',providerOrderId:'ORDER'};
 const created=await f.provider.createOrder(order,{});assert.equal(created.merchantId,'merchant');
 await f.provider.capture(order);assert.equal(f.state.calls.some(c=>c.url.endsWith('/capture')&&c.init.method==='POST'),false,'already captured orders are reconciled without another capture');
 f.state.merchant='other';await assert.rejects(f.provider.reconcile(scope,'connection',{captureId:'CAPTURE'}),{code:'provider_merchant_mismatch'});
});
test('PayPal evidence comes from fetched order/capture/refund resources, never webhook amounts or buyer text',async()=>{
 const f=paypal(),[e]=await f.provider.reconcile(scope,'connection',{eventId:'EVENT',eventType:'PAYMENT.CAPTURE.COMPLETED',payload:JSON.stringify({id:'EVENT',resource:{id:'CAPTURE',amount:{value:'0.01'},payer:{email_address:'forged@example.test'}}})});
 assert.equal(e.paidMinor,1000);assert.equal(e.buyerEmail,'buyer@example.test');assert.equal(e.mappingId,'SKU');assert.equal(e.reference,'reference');
 const refund={eventId:'REFUND-EVENT',eventType:'PAYMENT.CAPTURE.REFUNDED',payload:JSON.stringify({id:'REFUND-EVENT',resource:{id:'REFUND'}})};
 const [r]=await f.provider.reconcile(scope,'connection',refund);assert.equal(r.refunds[0].amountMinor,400);
 f.state.refundCurrency='CAD';await assert.rejects(f.provider.reconcile(scope,'connection',refund),{code:'refund_currency_mismatch'});
});
test('unsupported tax, quantity and multiple captures are not eligible for automatic fulfillment',async()=>{
 const f=paypal();f.order.purchase_units[0].amount.breakdown={tax_total:{currency_code:'USD',value:'1.00'}};
 assert.equal((await f.provider.reconcile(scope,'connection',{captureId:'CAPTURE'}))[0].unsupported,true);
 f.order.purchase_units[0].amount.breakdown={};f.order.purchase_units[0].items[0].quantity='2';assert.equal((await f.provider.reconcile(scope,'connection',{captureId:'CAPTURE'}))[0].unsupported,true);
});
test('webhook allocation errors are actionable without exposing provider response text',async()=>{
 const client=new PayPalClient('sandbox',{clientId:'app',clientSecret:'secret'},async()=>json({name:'WEBHOOK_NUMBER_LIMIT_EXCEEDED',message:'PRIVATE response detail'},422));
 await assert.rejects(client.listWebhooks(),error=>error.code==='webhook_limit_reached'&&!error.message.includes('PRIVATE'));
});
function discord(){
 const state={calls:[],permissions:'32',botPermissions:'268435456',missing:false,rateLimited:false};
 const roles=[{id:'300',name:'everyone',position:0,permissions:'0'},{id:'400',name:'Bot',position:5,permissions:'268435456',managed:true},{id:'500',name:'Member',position:2,permissions:'0'},{id:'600',name:'Above bot',position:10,permissions:'0'},{id:'700',name:'Managed',position:1,permissions:'0',managed:true}];
 const client=new DiscordCommerceClient({clientId:'100',clientSecret:'SECRET-client',botToken:'SECRET-bot',botUserId:'200',redirectUri:'https://shop.example.test/commerce/discord-callback',fetch:async(url,init)=>{
  state.calls.push({url,init});assert.equal(init.redirect,'error');const path=new URL(url).pathname;
  if(state.rateLimited)return json({message:'PRIVATE provider message'},429,{'retry-after':'45'});
  if(path.endsWith('/oauth2/token'))return json({access_token:'SECRET-user',token_type:'Bearer'});
  if(path.endsWith('/users/@me'))return json({id:'123'});
  if(path.endsWith('/users/@me/guilds'))return json([{id:'300',name:'Creator server',permissions:state.permissions}]);
  if(path.endsWith('/roles'))return json(roles.map(r=>r.id==='400'?{...r,permissions:state.botPermissions}:r));
  if(path.endsWith('/members/200'))return json({roles:['400']});
  if(path.endsWith('/members/123'))return state.missing?json({},404):json({roles:['500','999']});
  if(path.includes('/members/123/roles/500'))return new Response(null,{status:204});
  if(path.endsWith('/invites/code'))return json({guild:{id:'300'}});
  throw Error('Unexpected '+path);
 }});
 return {state,client};
}
test('Discord requests identify/guild management without automatic joining or Administrator permissions',async()=>{
 const f=discord();assert.equal(new URL(f.client.authorizationUrl('state',false)).searchParams.get('scope'),'identify');
 assert.equal(new URL(f.client.authorizationUrl('state',true)).searchParams.get('scope'),'identify guilds');
 assert.equal(new URL(f.client.installUrl()).searchParams.get('permissions'),'268435456');
 assert.equal((await f.client.exchange('oauth-code')).userId,'123');
 await f.client.validateGuild('SECRET-user','300',['500']);await f.client.validateInvite('300','https://discord.gg/code');
 assert.deepEqual(await f.client.roles('300'),[{id:'500',name:'Member'}]);
});
test('Discord enforces creator management, bot permissions, role hierarchy and role provenance',async()=>{
 const f=discord();for(const role of ['300','400','600','700'])await assert.rejects(f.client.validateRoles('300',[role]),{code:'discord_role_hierarchy_conflict'});
 f.state.permissions='0';await assert.rejects(f.client.validateGuild('SECRET-user','300',['500']),{code:'discord_server_management_required'});
 f.state.permissions='32';f.state.botPermissions='0';await assert.rejects(f.client.validateRoles('300',['500']),{code:'discord_manage_roles_required'});
});
test('Discord membership and rate limits remain visible, retryable and redacted',async()=>{
 const f=discord();f.state.missing=true;assert.equal(await f.client.member('300','123'),undefined);f.state.rateLimited=true;
 await assert.rejects(f.client.addRole('300','123','500'),error=>error.code==='discord_rate_limited'&&error.retryAfterSeconds===45&&!error.message.includes('PRIVATE'));
});
