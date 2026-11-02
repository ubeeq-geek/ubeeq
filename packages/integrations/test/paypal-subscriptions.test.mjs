import test from 'node:test';
import assert from 'node:assert/strict';
import {PayPalCommerceProvider} from '../dist/index.js';
const scope={deploymentId:'deployment',ownerId:'creator',environment:'sandbox'};
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
function fixture(knownSeller=true){
 const state={calls:[],wrongPlan:false,override:false,incomplete:false,status:'ACTIVE',transactions:[]};
 const order={...scope,id:'checkout',connectionId:'connection',reference:'reviewed',currency:'USD',amountMinor:1000,merchantId:'merchant',billing:'month',providerOrderId:'I-SUB',providerPlanId:'P-PLAN'};
 const fetch=async(url,init)=>{state.calls.push({url,init});const path=new URL(url).pathname,body=init.body?JSON.parse(init.body.startsWith('{')?init.body:'{}'):{};
  if(path==='/v1/oauth2/token')return json({access_token:'token',token_type:'Bearer',expires_in:300});
  if(path==='/v2/checkout/orders'&&init.method==='POST')return json({id:'VERIFY'});
  if(path==='/v2/checkout/orders/VERIFY')return json({id:'VERIFY',purchase_units:[{custom_id:'reviewed',amount:{currency_code:'USD',value:'10.00'},payee:{merchant_id:'merchant'}}]});
  if(path==='/v1/catalogs/products')return json({id:'PROD-PRODUCT'});
  if(path==='/v1/billing/plans'&&init.method==='POST'){assert.equal(body.billing_cycles[0].frequency.interval_unit,'MONTH');assert.equal(body.billing_cycles[0].pricing_scheme.fixed_price.value,'10.00');assert.equal(body.payment_preferences.auto_bill_outstanding,false);return json({id:'P-PLAN'});}
  if(path==='/v1/billing/plans/P-PLAN')return json({id:'P-PLAN',taxes:{percentage:'0',inclusive:false},billing_cycles:[{frequency:{interval_unit:state.wrongPlan?'DAY':'MONTH',interval_count:1},tenure_type:'REGULAR',total_cycles:0,pricing_scheme:{fixed_price:{currency_code:'USD',value:'10.00'}}}]});
  if(path==='/v1/billing/subscriptions'&&init.method==='POST'){assert.equal(body.custom_id,'reviewed');assert.equal(body.plan_id,'P-PLAN');return json({id:'I-SUB',links:[{rel:'approve',href:'https://www.sandbox.paypal.com/approve'}]});}
  if(path==='/v1/billing/subscriptions/I-SUB')return json({id:'I-SUB',custom_id:'reviewed',plan_id:'P-PLAN',plan_overridden:state.override,quantity:'1',create_time:new Date(Date.now()-86400000).toISOString(),status:state.status});
  if(path.endsWith('/transactions'))return json({transactions:state.transactions,total_pages:state.incomplete?2:1});
  if(path.endsWith('/cancel')){state.status='CANCELLED';return new Response(null,{status:204});}
  throw Error('Unexpected '+path);
 };
 const provider=new PayPalCommerceProvider({publicBaseUrl:'https://shop.example.test',fetch,credentials:async()=>({clientId:'app',clientSecret:'secret',merchantId:knownSeller?'merchant':undefined})});return {state,order,provider};
}
test('subscription checkout creates reviewed monthly billing with stable idempotency and no order capture',async()=>{
 const f=fixture();assert.deepEqual(await f.provider.createOrder(f.order,{title:'Art membership',billing:'month'}),{orderId:'I-SUB',planId:'P-PLAN',merchantId:'merchant',approvalUrl:'https://www.sandbox.paypal.com/approve'});
 await f.provider.capture(f.order);assert.equal(f.state.calls.some(c=>c.url.includes('/capture')),false);
 const writes=f.state.calls.filter(c=>c.init.method==='POST'&&!c.url.endsWith('/token'));assert.equal(new Set(writes.map(c=>c.init.headers['PayPal-Request-Id'])).size,3);assert.ok(writes.every(c=>c.init.redirect==='error'));
 await f.provider.cancelSubscription(f.order);assert.equal(await f.provider.subscriptionStatus(f.order),'CANCELLED');await f.provider.cancelSubscription(f.order);assert.equal(f.state.calls.filter(c=>c.url.endsWith('/cancel')).length,1);
});
test('subscription approval grants nothing; independent completed transactions carry paid-period evidence',async()=>{
 const f=fixture();assert.deepEqual(await f.provider.reconcile(scope,'connection',{orderId:'I-SUB'}),[]);
 const time=new Date(Date.now()-3600000).toISOString();f.state.transactions=[{id:'SALE',status:'COMPLETED',time,amount_with_breakdown:{gross_amount:{currency_code:'USD',value:'10.00'}}}];
 const evidence=await f.provider.reconcile(scope,'connection',{orderId:'I-SUB'});assert.equal(evidence[0].paidAt,time);assert.equal(evidence[0].subscriptionPlanId,'P-PLAN');assert.equal(evidence[0].subscriptionInterval,'month');assert.equal(evidence[0].reference,'reviewed');assert.equal(evidence[0].paidMinor,1000);
 f.state.incomplete=true;await assert.rejects(f.provider.reconcile(scope,'connection',{orderId:'I-SUB'}),{code:'subscription_transactions_incomplete'});
 f.state.incomplete=false;f.state.override=true;await assert.rejects(f.provider.reconcile(scope,'connection',{orderId:'I-SUB'}),{code:'subscription_identity_mismatch'});
 f.state.override=false;f.state.wrongPlan=true;await assert.rejects(f.provider.reconcile(scope,'connection',{orderId:'I-SUB'}),{code:'unsupported_subscription_plan'});
});

test('a new seller is identified with an uncaptured verification order before recurring checkout',async()=>{const f=fixture(false);const created=await f.provider.createOrder(f.order,{title:'Membership',billing:'month'});assert.equal(created.merchantId,'merchant');assert.equal(f.state.calls.filter(c=>c.url.endsWith('/v2/checkout/orders')).length,1);assert.equal(f.state.calls.some(c=>c.url.includes('/capture')),false);});
