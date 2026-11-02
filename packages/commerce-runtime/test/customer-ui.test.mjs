import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {commerceJavaScript} from '../dist/page.js';
function fixture({search='',pathname='/commerce',initialToken,fetch=async()=>({ok:true,json:async()=>({})})}={}){
 const listeners=new Map(),nodes=new Map(),calls=[],location={search,pathname},values=new Map(initialToken?[['ubeeq.commerce.session',initialToken]]:[]);
 const node=(tag='div')=>({tagName:tag.toUpperCase(),children:[],attributes:{},hidden:false,disabled:false,textContent:'',elements:new Proxy({email:{focus(){this.focused=true;}}},{get:(target,key)=>target[key]??(target[key]={value:''})}),setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},scrollIntoView(){},get lastChild(){return this.children.at(-1);}});
 const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
 vm.runInNewContext(commerceJavaScript,{document:{getElementById:get,createElement:node,querySelectorAll:()=>[]},window:{dispatchEvent(){},addEventListener:(type,callback)=>listeners.set(type,callback)},sessionStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},localStorage:{getItem:()=>null},location,history:{replaceState(_state,_title,path){const url=new URL(path,'https://commerce.test');location.pathname=url.pathname;location.search=url.search;}},URLSearchParams,CustomEvent:class{},FormData:class{*[Symbol.iterator](){yield ['email','buyer@example.test'];}},fetch:async(...args)=>{calls.push(args);return fetch(...args);},Intl,BigInt,Date,setTimeout,clearTimeout});
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
 const card=f.get('offers').children[0];assert.ok(card);const details=card.children.filter(n=>n.tagName==='DETAILS');assert.equal(details.length,2);assert.equal(details[0].children[0].textContent,'Included content (1)');assert.equal(details[1].children[0].textContent,'Purchase and refund terms');assert.ok(details.every(n=>!n.open));
 const purchase=card.children.find(n=>n.tagName==='BUTTON');assert.equal(purchase.textContent,'Purchase with PayPal');await purchase.onclick({currentTarget:purchase,preventDefault(){}});assert.equal(f.get('emailSignin').elements.email.focused,true);assert.equal(f.calls.some(([path])=>path==='/api/checkouts'),false);assert.match(f.get('notice').textContent,/Sign in with your email/);
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
