import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {commerceJavaScript} from '../dist/page.js';
function fixture({search='',fetch=async()=>({ok:true,json:async()=>({})})}={}){
 const nodes=new Map(),calls=[];
 const node=(tag='div')=>({tagName:tag.toUpperCase(),children:[],attributes:{},hidden:false,disabled:false,textContent:'',elements:new Proxy({email:{focus(){this.focused=true;}}},{get:(target,key)=>target[key]??(target[key]={value:''})}),setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},scrollIntoView(){},get lastChild(){return this.children.at(-1);}});
 const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
 vm.runInNewContext(commerceJavaScript,{document:{getElementById:get,createElement:node,querySelectorAll:()=>[]},window:{dispatchEvent(){}},sessionStorage:{getItem:()=>null},localStorage:{getItem:()=>null},location:{search,pathname:'/commerce'},URLSearchParams,CustomEvent:class{},FormData:class{*[Symbol.iterator](){yield ['email','buyer@example.test'];}},fetch:async(...args)=>{calls.push(args);return fetch(...args);},Intl,BigInt,Date,setTimeout,clearTimeout});
 return {get,calls};
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
