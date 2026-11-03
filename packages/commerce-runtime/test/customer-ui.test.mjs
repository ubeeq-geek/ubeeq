import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {commerceJavaScript} from '../dist/page.js';
function fixture({search='',pathname='/commerce',initialToken,schedule=setTimeout,open=()=>undefined,fetch=async()=>({ok:true,json:async()=>({})})}={}){
 const listeners=new Map(),nodes=new Map(),calls=[],location={search,pathname},values=new Map(initialToken?[['ubeeq.commerce.session',initialToken]]:[]);
 const node=(tag='div')=>({tagName:tag.toUpperCase(),children:[],attributes:{},hidden:false,disabled:false,textContent:'',elements:new Proxy({email:{focus(){this.focused=true;}}},{get:(target,key)=>target[key]??(target[key]={value:''})}),setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];},append(...children){this.children.push(...children);},insertBefore(child,before){this.children.splice(this.children.indexOf(before),0,child);},replaceChildren(...children){this.children=children;},scrollIntoView(){},click(){this.clicked=true;},get lastChild(){return this.children.at(-1);}});
 const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
 vm.runInNewContext(commerceJavaScript,{document:{getElementById:get,createElement:node,querySelectorAll:()=>[]},window:{open,dispatchEvent(){},addEventListener:(type,callback)=>listeners.set(type,callback)},sessionStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},localStorage:{getItem:()=>null},location,history:{replaceState(_state,_title,path){const url=new URL(path,'https://commerce.test');location.pathname=url.pathname;location.search=url.search;}},URLSearchParams,CustomEvent:class{},FormData:class{*[Symbol.iterator](){yield ['email','buyer@example.test'];}},fetch:async(...args)=>{calls.push(args);return fetch(...args);},Intl,BigInt,Date,crypto:{randomUUID:()=> 'checkout-request-123'},setTimeout:schedule,clearTimeout});
 return {get,calls,location,listeners};
}
test('processing buttons expose busy state, reject duplicate submission and recover after completion',async()=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve;});const f=fixture({fetch:async()=>{await pending;return {ok:true,json:async()=>({})};}}),submitter={tagName:'BUTTON',disabled:false,attributes:{},setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];}},event={submitter,preventDefault(){}};
 const first=f.get('emailSignin').onsubmit(event);await f.get('emailSignin').onsubmit(event);assert.equal(f.calls.length,1);assert.equal(submitter.disabled,true);assert.equal(submitter.attributes['aria-busy'],'true');finish();await first;assert.equal(submitter.disabled,false);assert.equal(submitter.attributes['aria-busy'],undefined);
});
test('payment failures announce an accessible error and release the processing button',async()=>{
 const f=fixture({fetch:async()=>({ok:false,json:async()=>({error:{code:'mail_unavailable'}})})}),button={tagName:'BUTTON',disabled:false,setAttribute(){},removeAttribute(){}};
 await f.get('emailSignin').onsubmit({submitter:button,preventDefault(){}});assert.equal(button.disabled,false);assert.equal(f.get('notice').attributes.role,'alert');assert.equal(f.get('notice').textContent,'mail unavailable');
});
test('storefront keeps included files and terms collapsible and guides signed-out buyers to email sign-in',async()=>{
 const offer={id:'offer',title:'Collection',amountMinor:500,currency:'USD',previews:[],files:['file'],includedFiles:[{label:'First image'}],terms:'Purchase terms',benefits:[{type:'gallery'},{type:'download'},{type:'package'}]};
 const f=fixture({search:'?owner=creator&environment=sandbox',fetch:async()=>({ok:true,json:async()=>({creator:{displayName:'Artist'},offers:[offer]})})});await new Promise(setImmediate);
 const card=f.get('offers').children[0];assert.ok(card);const summary=card.children.find(n=>n.className==='commerce-offer-summary');const details=summary.children.filter(n=>n.tagName==='DETAILS');assert.equal(details.length,2);assert.equal(details[0].children[0].textContent,'Included content (1)');assert.equal(details[1].children[0].textContent,'Purchase and refund terms');assert.ok(details.every(n=>!n.open));
 const purchase=summary.children.find(n=>n.tagName==='BUTTON');assert.equal(purchase.textContent,'Purchase with PayPal');await purchase.onclick({currentTarget:purchase,preventDefault(){}});assert.equal(f.get('emailSignin').elements.email.focused,true);assert.equal(f.calls.some(([path])=>path==='/api/checkouts'),false);assert.match(f.get('notice').textContent,/Sign in with your email/);
});

test('requesting sign-in from a collection retains that collection and its sandbox environment',async()=>{
 const f=fixture({pathname:'/buy/creator/collection',search:'?environment=sandbox',fetch:async path=>({ok:true,json:async()=>path.startsWith('/api/storefront')?{offers:[]}:{}})});await new Promise(setImmediate);await f.get('emailSignin').onsubmit({preventDefault(){}});
 const body=JSON.parse(f.calls.find(([path])=>path==='/api/auth/email')[1].body);assert.equal(body.returnPath,'/buy/creator/collection?environment=sandbox');
});
test('redeeming sign-in returns to the collection without claiming, purchasing or charging',async()=>{
 const target='/buy/creator/collection?environment=sandbox';const f=fixture({pathname:'/commerce/sign-in',search:'?id=proof&token=login-token',fetch:async path=>({ok:true,json:async()=>path==='/api/auth/email/redeem'?{token:'session',returnPath:target}:path==='/api/me'?{verifiedEmails:['buyer@example.test']}:{offers:[]}})});await new Promise(setImmediate);
 assert.equal(f.get('proofTitle').textContent,'Sign in');assert.match(f.get('proofDescription').textContent,/Signing in does not make a payment/);await f.get('redeemProof').onclick({preventDefault(){}});
 assert.equal(f.location.pathname,'/buy/creator/collection');assert.equal(f.location.search,'?environment=sandbox');assert.match(f.get('notice').textContent,/Signed in/);assert.doesNotMatch(f.get('notice').textContent,/claimed/i);assert.ok(f.calls.some(([path])=>path==='/api/storefront?owner=creator&environment=sandbox'));assert.equal(f.calls.some(([path])=>path==='/api/purchase-claims'||path==='/api/checkouts'),false);
});

for(const [route,endpoint,expected]of [['sign-in','/api/auth/email/redeem','Signed in.'],['claim','/api/purchase-claims','Purchase claimed.'],['verify-email','/api/me/email/verify','Recovery email verified.']])test(`${route} reports only its own successful action`,async()=>{
 const f=fixture({pathname:'/commerce/'+route,search:'?id=proof&token=token',initialToken:route==='sign-in'?undefined:'existing-session',fetch:async path=>({ok:true,json:async()=>path===endpoint?{token:'new-session'}:path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path==='/api/me/purchases'?{purchases:[]}:path==='/api/me/access'?{entitlements:[]}:{}})});await new Promise(setImmediate);await f.get('redeemProof').onclick({preventDefault(){}});
 assert.equal(f.get('notice').textContent,expected);assert.equal(f.location.pathname,'/commerce/purchases');assert.equal(f.calls.filter(([path])=>path===endpoint).length,1);
 if(route!=='claim')assert.equal(f.calls.some(([path])=>path==='/api/purchase-claims'),false);
});


test('an account signed in from another tab refreshes the buyer identity without submitting a purchase',async()=>{
 const f=fixture({pathname:'/buy/creator/gallery',fetch:async path=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:{offers:[]}})});await new Promise(setImmediate);
 assert.equal(f.get('emailSignin').hidden,false);
 f.listeners.get('ubeeq:commerce-session-changed')({detail:{token:'new-account-session'}});await new Promise(setImmediate);
 assert.equal(f.get('emailSignin').hidden,true);assert.equal(f.get('signin').hidden,true);
 const request=f.calls.find(([path])=>path==='/api/me');assert.equal(request[1].headers.authorization,'Bearer new-account-session');
 assert.equal(f.calls.some(([path])=>path.includes('/capture')||path==='/api/checkouts'),false);
 f.listeners.get('ubeeq:commerce-session-changed')({detail:{token:''}});await new Promise(setImmediate);
 assert.equal(f.get('emailSignin').hidden,false);
});
test('an expired account session does not prevent viewing the public collection',async()=>{
 const f=fixture({initialToken:'expired-session',pathname:'/buy/creator/gallery',fetch:async path=>({ok:path!=='/api/me',json:async()=>path==='/api/me'?{error:{code:'authentication_required'}}:{offers:[]}})});await new Promise(setImmediate);
 assert.equal(f.get('emailSignin').hidden,false);assert.ok(f.calls.some(([path])=>path.startsWith('/api/storefront')));
});


test('prepares a PayPal link on the collection page and polls without navigation or capture',async()=>{
 const timers=[],offer={id:'offer',slug:'collection',title:'Collection',amountMinor:500,currency:'USD',previews:[],files:[],terms:'Terms',benefits:[]};let ready=false;
 const f=fixture({pathname:'/buy/creator/collection',initialToken:'buyer-session',schedule:fn=>{timers.push(fn);return timers.length;},fetch:async(path,options)=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path.startsWith('/api/storefront')?{offers:[offer]}:path==='/api/checkouts'?{order:{id:'order'}}:{order:{state:'pending',...(ready?{approvalUrl:'https://www.sandbox.paypal.com/checkoutnow?token=order'}:{})}}})});await new Promise(setImmediate);
 const summary=f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary'),purchase=summary.children.find(n=>n.tagName==='BUTTON');
 await purchase.onclick({currentTarget:purchase,preventDefault(){}});
 const preparation=summary.children.find(n=>n.className==='commerce-payment-preparation');
 assert.match(preparation.textContent,/PayPal link will appear below/);assert.equal(purchase.hidden,true);assert.equal(f.location.pathname,'/buy/creator/collection');assert.equal(f.location.href,undefined);
 ready=true;timers.shift()();await new Promise(setImmediate);
 const link=preparation.children.find(n=>n.tagName==='A');assert.equal(link.textContent,'Continue to PayPal');assert.match(link.href,/sandbox.paypal.com/);
 assert.equal(f.calls.filter(([path])=>path==='/api/checkouts').length,1);assert.equal(f.calls.some(([path])=>path.includes('/capture')),false);assert.equal(timers.length,0);
});

test('the PayPal return page reuses the compact collection media and payment summary layout',async()=>{
 const f=fixture({pathname:'/commerce/checkout/order',initialToken:'buyer-session',schedule:()=>1,fetch:async path=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path.endsWith('/capture')?{}:{order:{ownerId:'creator',state:'completed',amountMinor:500,currency:'USD'},purchases:[{id:'purchase',state:'active'}],collectionPurchaseId:'purchase',collection:{title:'Collection',description:'Collection contents.',coverUrl:'/cover',coverAlt:'Cover'}}})});await new Promise(setImmediate);
 const card=f.get('checkoutState');assert.equal(card.className,'panel commerce-offer');
 const media=card.children.find(n=>n.className==='commerce-offer-media'),summary=card.children.find(n=>n.className==='commerce-offer-summary');
 assert.equal(media.children.find(n=>n.tagName==='IMG').src,'/cover');assert.ok(summary.children.some(n=>n.textContent==='Payment'));
 assert.equal(summary.children.find(n=>n.tagName==='A').href,'/commerce/purchases');
});


test('PayPal return polls verified completion before offering the purchased collection, with no second PayPal approval link',async()=>{
 const timers=[];let paid=false;
 const f=fixture({pathname:'/commerce/checkout/order',search:'?token=paypal-token&PayerID=payer',initialToken:'buyer',schedule:fn=>{timers.push(fn);return timers.length;},fetch:async path=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path.endsWith('/capture')?{}:{order:{state:paid?'completed':'pending',amountMinor:500,currency:'USD',approvalUrl:'https://www.sandbox.paypal.com/approve'},purchases:paid?[{id:'paid-purchase',state:'active'}]:[],...(paid?{collectionPurchaseId:'paid-purchase'}:{})}})});await new Promise(setImmediate);
 let summary=f.get('checkoutState').children.find(n=>n.className==='commerce-offer-summary');
 assert.ok(summary.children.some(n=>/confirming your payment/.test(n.textContent)));assert.equal(summary.children.some(n=>n.tagName==='A'),false);
 paid=true;timers.shift()();await new Promise(setImmediate);
 summary=f.get('checkoutState').children.find(n=>n.className==='commerce-offer-summary');const link=summary.children.find(n=>n.tagName==='A');assert.equal(link.textContent,'Continue to My Purchases');assert.equal(link.href,'/commerce/purchases');
 assert.equal(f.calls.filter(([path])=>path.endsWith('/capture')).length,1);assert.equal(timers.length,0);
});
test('the purchased collection link opens only the requested active collection owned by the signed-in buyer',async()=>{
 const purchase={id:'paid-purchase',ownerId:'creator',state:'active',offer:{title:'Collection',supportEmail:'help@example.test'},payment:{state:'completed'},entitlements:[{state:'active',benefit:{type:'gallery'},assetIds:[]}],packages:[],discord:[]};
 const f=fixture({pathname:'/commerce/purchases',search:'?purchase=paid-purchase',initialToken:'buyer',fetch:async path=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path==='/api/me/purchases'?{purchases:[purchase]}:path.startsWith('/api/me/gallery')?{html:'<div>Purchased collection viewer</div>'}:{entitlements:[]}})});await new Promise(setImmediate);
 assert.ok(f.calls.some(([path])=>path==='/api/me/gallery?purchase=paid-purchase'));assert.match(f.get('gallery').innerHTML,/Purchased collection viewer/);
 const other=fixture({pathname:'/commerce/purchases',search:'?purchase=someone-else',initialToken:'buyer',fetch:async path=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path==='/api/me/purchases'?{purchases:[purchase]}:{entitlements:[]}})});await new Promise(setImmediate);
 assert.equal(other.calls.some(([path])=>path.startsWith('/api/me/gallery')),false);assert.match(other.get('notice').textContent,/not available from this account/);
});


test('purchases are collection teasers rather than a wall of file buttons',async()=>{
 const purchase={id:'paid-purchase',ownerId:'creator',createdAt:'2026-11-01T12:00:00Z',state:'active',offer:{title:'Collection',files:Array.from({length:50},(_,i)=>'image-'+i),supportEmail:'help@example.test'},collection:{coverUrl:'/collection-cover',coverAlt:'Collection cover'},payment:{state:'completed'},entitlements:[{state:'active',benefit:{type:'gallery'},assetIds:[]},...Array.from({length:50},(_,i)=>({state:'active',benefit:{type:'download'},assetIds:['image-'+i]}))],packages:[],discord:[]};
 const f=fixture({pathname:'/commerce/purchases',initialToken:'buyer',fetch:async path=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path==='/api/me/purchases'?{purchases:[purchase]}:{entitlements:[]}})});await new Promise(setImmediate);
 const list=f.get('purchaseList'),card=list.children[0];assert.equal(list.className,'commerce-purchase-grid');assert.match(card.className,/website-gallery-teaser/);
 const descendants=node=>[node,...node.children.flatMap(descendants)],all=descendants(card);
 assert.equal(all.find(n=>n.tagName==='IMG').src,'/collection-cover');assert.equal(all.some(n=>n.textContent==='Download file'),false);assert.ok(all.some(n=>n.textContent==='View gallery'));assert.ok(all.some(n=>n.textContent==='Purchase details'));
});

test('viewer downloads request fresh authorization for the selected asset and release the busy control',async()=>{
 const f=fixture({initialToken:'buyer',fetch:async path=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:{url:'https://commerce.test/api/private-assets/second?token=short-lived'}})});await new Promise(setImmediate);
 const control={disabled:false,attrs:{},setAttribute(key,value){this.attrs[key]=value;},removeAttribute(key){delete this.attrs[key];}};
 f.listeners.get('website-gallery-download')({detail:{assetId:'second-image',button:control}});assert.equal(control.disabled,true);await new Promise(setImmediate);
 const request=f.calls.find(([path])=>path==='/api/downloads/second-image/authorize');assert.equal(request[1].method,'POST');assert.equal(request[1].headers.authorization,'Bearer buyer');assert.equal(control.disabled,false);assert.equal(control.attrs['aria-busy'],undefined);
});

test('View original authorizes the full file only after an explicit original-view action',async()=>{
 const navigations=[],tab={opener:{},location:{replace:url=>navigations.push(url)},close(){}};
 const f=fixture({initialToken:'buyer',open:()=>tab,fetch:async path=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:{url:'https://commerce.test/api/private-assets/original?token=fresh'}})});await new Promise(setImmediate);
 assert.equal(f.calls.some(([path])=>path.includes('/authorize')),false);
 f.listeners.get('website-gallery-original')({detail:{assetId:'original'}});await new Promise(setImmediate);
 assert.equal(tab.opener,null);assert.equal(f.calls.find(([path])=>path==='/api/downloads/original/authorize')[1].method,'POST');assert.equal(navigations[0],'https://commerce.test/api/private-assets/original?token=fresh');assert.doesNotMatch(navigations[0],/rendition=/);
});

const ownedOffer={id:'offer-new',slug:'collection',offerId:'offer-family',ownerId:'creator',environment:'sandbox',collectionRoots:['collection'],title:'Collection',amountMinor:500,currency:'USD',previews:[],files:['file'],terms:'Terms',benefits:[{type:'gallery',resourceId:'collection'}]};
function ownedRecord(overrides={}){return {id:'purchase-owned',ownerId:'creator',environment:'sandbox',state:'active',offer:{...ownedOffer,id:'offer-old'},entitlements:[{state:'active',startsAt:'2020-01-01T00:00:00Z',benefit:{type:'gallery',resourceId:'collection'}}],...overrides};}
async function ownershipFixture({records={purchases:[ownedRecord()]},offer=ownedOffer,failAccess=false,initialToken='buyer'}={}){
 const f=fixture({pathname:'/buy/creator/collection',search:'?environment=sandbox',initialToken,fetch:async path=>{if(failAccess&&path==='/api/me/purchases')throw Error('offline');return {ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path==='/api/me/purchases'?records:{offers:[offer]}};}});await new Promise(setImmediate);return f;
}
test('a signed-in owner sees current collection access across offer versions instead of another checkout',async()=>{
 const f=await ownershipFixture(),summary=f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary');
 assert.equal(summary.children.some(n=>n.textContent==='Purchase with PayPal'),false);
 assert.ok(summary.children.some(n=>n.textContent==='You own this collection.'));
 const link=summary.children.find(n=>n.textContent==='View collection');assert.equal(link.href,'/commerce/purchases?purchase=purchase-owned');
 assert.equal(f.calls.some(([path])=>path==='/api/checkouts'),false);
});
for(const [kind,record,message,query] of [
 ['subscription',ownedRecord({offer:{...ownedOffer,billing:'month'}}),'Access included with your subscription','purchase'],
 ['gift',ownedRecord({id:'gift-owned',state:'claimed'}),'Gift access active','gift']
])test(`active ${kind} access opens the existing collection`,async()=>{
 const f=await ownershipFixture({records:kind==='gift'?{purchases:[],gifts:[record]}:{purchases:[record]}}),summary=f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary');
 assert.ok(summary.children.some(n=>n.textContent===message));assert.equal(summary.children.find(n=>n.textContent==='View collection').href,'/commerce/purchases?'+query+'='+record.id);
});
test('refunded, expired, future, foreign creator/environment and incomplete Volume access do not count as ownership',async()=>{
 for(const record of [ownedRecord({state:'revoked'}),ownedRecord({ownerId:'other'}),ownedRecord({environment:'live'}),ownedRecord({entitlements:[{state:'revoked',benefit:{type:'gallery',resourceId:'collection'}}]}),ownedRecord({entitlements:[{state:'active',endsAt:'2020-01-01T00:00:00Z',benefit:{type:'gallery',resourceId:'collection'}}]}),ownedRecord({entitlements:[{state:'active',startsAt:'2999-01-01T00:00:00Z',benefit:{type:'gallery',resourceId:'collection'}}]})]){
  const f=await ownershipFixture({records:{purchases:[record]}}),summary=f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary');assert.ok(summary.children.some(n=>n.textContent==='Purchase with PayPal'));assert.equal(summary.children.some(n=>n.textContent==='View collection'),false);
 }
 const f=await ownershipFixture({offer:{...ownedOffer,collectionRoots:['volume'],benefits:[{type:'gallery',resourceId:'volume'},{type:'gallery',resourceId:'collection'}]}}),summary=f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary');assert.ok(summary.children.some(n=>n.textContent==='Purchase with PayPal'));
});
test('an unavailable ownership lookup blocks another payment and offers retry',async()=>{
 const f=await ownershipFixture({failAccess:true}),summary=f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary');assert.equal(summary.children.find(n=>n.textContent==='Purchase with PayPal').disabled,true);assert.equal(f.calls.some(([path])=>path==='/api/checkouts'),false);assert.ok(summary.children.find(n=>n.className==='commerce-payment-preparation').children.some(n=>n.textContent==='Retry access check'));
});
test('anonymous storefronts do not request private purchase history',async()=>{
 const f=await ownershipFixture({initialToken:''});assert.equal(f.calls.some(([path])=>path==='/api/me/purchases'),false);
});
test('account changes refresh storefront ownership and discard the previous account result',async()=>{
 const f=await ownershipFixture();f.listeners.get('ubeeq:commerce-session-changed')({detail:{token:''}});await new Promise(setImmediate);
 const summary=f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary');assert.ok(summary.children.some(n=>n.textContent==='Purchase with PayPal'));assert.equal(summary.children.some(n=>n.textContent==='View collection'),false);
});
test('a delayed ownership response cannot restore a previous account after sign-out',async()=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve;});
 const f=fixture({pathname:'/buy/creator/collection',search:'?environment=sandbox',initialToken:'buyer',fetch:async path=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path==='/api/me/purchases'?pending:{offers:[ownedOffer]}})});await new Promise(setImmediate);
 f.listeners.get('ubeeq:commerce-session-changed')({detail:{token:''}});await new Promise(setImmediate);finish({purchases:[ownedRecord()]});await new Promise(setImmediate);
 const summary=f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary');assert.ok(summary.children.some(n=>n.textContent==='Purchase with PayPal'));assert.equal(summary.children.some(n=>n.textContent==='View collection'),false);
});
test('the same signed-in account refreshes ownership after access changes in another tab',async()=>{
 let owns=false;const f=fixture({pathname:'/buy/creator/collection',search:'?environment=sandbox',initialToken:'buyer',fetch:async path=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path==='/api/me/purchases'?{purchases:owns?[ownedRecord()]:[]}:{offers:[ownedOffer]}})});await new Promise(setImmediate);
 owns=true;f.listeners.get('ubeeq:commerce-session-changed')({detail:{token:'buyer'}});await new Promise(setImmediate);
 assert.ok(f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary').children.some(n=>n.textContent==='View collection'));
});

test('Volume storefront displays the server discount and submits the displayed amount for revalidation',async()=>{
 const offer={...ownedOffer,collectionRoots:['volume'],collection:{type:'volume'},amountMinor:2000,benefits:[{type:'gallery',resourceId:'volume'},{type:'gallery',resourceId:'collection'}]},quote={offerVersionId:offer.id,currency:'USD',amountMinor:1600,ownershipDiscount:{percent:20,collectionIds:['collection'],baseAmountMinor:2000,discountMinor:400}};
 const f=fixture({pathname:'/buy/creator/collection',search:'?environment=sandbox',initialToken:'buyer',schedule:()=>1,fetch:async path=>({ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path==='/api/me/purchases'?{purchases:[ownedRecord()]}:path==='/api/checkouts/quote'?quote:path.startsWith('/api/storefront')?{offers:[offer]}:path==='/api/checkouts'?{order:{id:'order'}}:{order:{state:'pending'}}})});await new Promise(setImmediate);
 const summary=f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary');assert.equal(summary.children.find(n=>n.tagName==='DEL').textContent,'$20.00');assert.equal(summary.children.find(n=>n.className==='commerce-price').textContent,'$16.00');assert.match(summary.children.find(n=>n.className==='commerce-discount').textContent,/20%.*1 included collection/);
 const purchase=summary.children.find(n=>n.textContent==='Purchase with PayPal');await purchase.onclick({currentTarget:purchase,preventDefault(){}});const command=f.calls.find(([path])=>path==='/api/checkouts');assert.deepEqual(JSON.parse(command[1].body),{offerVersionId:offer.id,expectedAmountMinor:1600});
 const before=f.calls.filter(([path])=>path.startsWith('/api/storefront')).length;f.listeners.get('ubeeq:commerce-session-changed')({detail:{token:'buyer'}});await new Promise(setImmediate);assert.equal(f.calls.filter(([path])=>path.startsWith('/api/storefront')).length,before);
});
test('failed Volume quote disables payment and gives a price retry',async()=>{
 const offer={...ownedOffer,collectionRoots:['volume'],collection:{type:'volume'}};
 const f=fixture({pathname:'/buy/creator/collection',search:'?environment=sandbox',initialToken:'buyer',fetch:async path=>{if(path==='/api/checkouts/quote')throw Error('offline');return {ok:true,json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path==='/api/me/purchases'?{purchases:[]}:{offers:[offer]}};}});await new Promise(setImmediate);
 const summary=f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary');assert.equal(summary.children.find(n=>n.textContent==='Purchase with PayPal').disabled,true);assert.ok(summary.children.find(n=>n.className==='commerce-payment-preparation').children.some(n=>n.textContent==='Retry price check'));assert.equal(f.calls.some(([path])=>path==='/api/checkouts'),false);
});
test('a changed price requires an explicit refresh before another checkout attempt',async()=>{
 const offer={...ownedOffer,collectionRoots:['volume'],collection:{type:'volume'}};
 const f=fixture({pathname:'/buy/creator/collection',search:'?environment=sandbox',initialToken:'buyer',fetch:async path=>({ok:path!=='/api/checkouts',json:async()=>path==='/api/me'?{verifiedEmails:['buyer@example.test']}:path==='/api/me/purchases'?{purchases:[]}:path==='/api/checkouts/quote'?{offerVersionId:offer.id,currency:'USD',amountMinor:400}:path==='/api/checkouts'?{error:{code:'checkout_price_changed'}}:{offers:[offer]}})});await new Promise(setImmediate);
 const summary=f.get('offers').children[0].children.find(n=>n.className==='commerce-offer-summary'),purchase=summary.children.find(n=>n.textContent==='Purchase with PayPal');await purchase.onclick({currentTarget:purchase,preventDefault(){}});assert.ok(summary.children.find(n=>n.className==='commerce-payment-preparation').children.some(n=>n.textContent==='Refresh price'));assert.equal(f.calls.filter(([path])=>path==='/api/checkouts').length,1);
});
