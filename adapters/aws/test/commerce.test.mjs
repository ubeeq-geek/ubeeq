import test from 'node:test';
import assert from 'node:assert/strict';
import {DynamoCommerceStore} from '../dist/commerce.js';
function fixture(){const items=new Map(),key=k=>JSON.stringify([k.pk,k.sk]);let fail=false;
 const condition=(i)=>{const old=items.get(key(i.Key??i.Item)),v=i.ExpressionAttributeValues??{};if(!i.ConditionExpression)return;if(i.ConditionExpression.includes('#r')){if(v[':r']!==undefined?old?.revision!==v[':r']:old?.revision!==undefined)throw Object.assign(Error('CAS'),{name:'ConditionalCheckFailedException'});}else if(i.ConditionExpression.includes('OR')){if(old&&old.expires>=v[':now'])throw Object.assign(Error('lease'),{name:'ConditionalCheckFailedException'});}else if(i.ConditionExpression.includes('#t=:t')){if(old?.token!==v[':t']||(v[':now']!==undefined&&old?.expires<v[':now']))throw Object.assign(Error('fence'),{name:'ConditionalCheckFailedException'});}};
 const client={send:async command=>{const i=command.input,name=command.constructor.name;if(name==='GetCommand')return {Item:structuredClone(items.get(key(i.Key)))};if(name==='QueryCommand')return {Items:[...items.values()].filter(r=>r.pk===i.ExpressionAttributeValues[':p']&&r.sk.startsWith(i.ExpressionAttributeValues[':s'])).map(r=>structuredClone(r))};if(name==='TransactWriteCommand'){if(fail){fail=false;throw Object.assign(Error('failed write'),{name:'TransportError'});}for(const op of i.TransactItems)condition(op.Put??op.ConditionCheck);for(const op of i.TransactItems)if(op.Put)items.set(key(op.Put.Item),structuredClone(op.Put.Item));return {};}
 condition(i);if(name==='PutCommand')items.set(key(i.Item),structuredClone(i.Item));else if(name==='DeleteCommand')items.delete(key(i.Key));else if(name==='UpdateCommand'){const old=items.get(key(i.Key));old.expires=i.ExpressionAttributeValues[':e'];}else throw Error(name);return {};}};
 return {items,client,failCommit:()=>fail=true,store:()=>new DynamoCommerceStore('deployment',client,'table','x'.repeat(32))};}
const record=(id,extra={})=>({id,deploymentId:'deployment',ownerId:'creator',environment:'sandbox',createdAt:'now',updatedAt:'now',...extra});
test('hosted transactions survive restart, encrypt and chunk large state, and roll back failures',async()=>{
 const f=fixture(),s=f.store(),secret='private customer information';await s.transaction(tx=>tx.insert('audit',record('a',{actorId:'owner',action:secret,resourceId:'a',reason:'z'.repeat(700000)})));
 assert.ok(f.items.size>3);assert.ok(!JSON.stringify([...f.items.values()]).includes(secret));assert.equal((await f.store().transaction(tx=>tx.get('audit','a'))).action,secret);
 f.failCommit();await assert.rejects(s.transaction(tx=>tx.put('audit',record('a',{actorId:'owner',action:'changed',resourceId:'a'}))));assert.equal((await s.transaction(tx=>tx.get('audit','a'))).action,secret);
 await assert.rejects(s.transaction(tx=>{tx.remove('audit','a');throw Error('rollback');}));assert.ok(await s.transaction(tx=>tx.get('audit','a')));
 await s.transaction(tx=>tx.remove('audit','a'));assert.equal(await f.store().transaction(tx=>tx.get('audit','a')),undefined);assert.ok(![...f.items.values()].some(r=>r.sk.startsWith('DATA#0000000000000001')));
});
test('concurrent instances preserve both writes and enforce uniqueness inside the commit',async()=>{
 const f=fixture();await Promise.all([f.store().transaction(tx=>tx.insert('audit',record('a'),['unique-a'])),f.store().transaction(tx=>tx.insert('audit',record('b'),['unique-b']))]);assert.equal((await f.store().transaction(tx=>tx.list('audit'))).length,2);
 await assert.rejects(f.store().transaction(tx=>tx.insert('audit',record('c'),['unique-a'])));assert.equal((await f.store().transaction(tx=>tx.list('audit'))).length,2);
});
test('connection writes require a current lease and stale workers cannot commit or delete its successor',async()=>{
 const f=fixture(),s=f.store(),scope={deploymentId:'deployment',ownerId:'creator',environment:'sandbox'},connection={...scope,id:'connection',revision:1,retiredCredentialReferences:[],state:'configured',acceptsCheckouts:true};
 await assert.rejects(s.save(connection,0,{actorId:'owner',action:'connect',at:'now'}));
 await s.withLock(scope,()=>s.save(connection,0,{actorId:'owner',action:'connect',at:'now'}));assert.equal((await f.store().find(scope)).id,'connection');
 await s.withLock(scope,async()=>{const lock=[...f.items.values()].find(r=>r.sk.startsWith('LOCK#'));lock.token='successor';await assert.rejects(s.transaction(tx=>tx.insert('audit',record('stale'))));});assert.ok([...f.items.values()].some(r=>r.token==='successor'));
});

test('hosted storage keeps multiple apps per environment and rejects duplicate app bindings',async()=>{const f=fixture(),s=f.store(),scope={deploymentId:'deployment',ownerId:'creator',environment:'sandbox'},a={...scope,id:'a',clientId:'client-a',revision:1,retiredCredentialReferences:[],state:'configured',acceptsCheckouts:true},b={...a,id:'b',clientId:'client-b'};await s.withLock(scope,async()=>{await s.save(a,0,{actorId:'owner',action:'connect',at:'now'});await s.save(b,0,{actorId:'owner',action:'connect',at:'now'});await assert.rejects(s.save({...a,id:'duplicate'},0,{actorId:'owner',action:'connect',at:'now'}));});assert.equal(await f.store().find(scope),undefined);assert.equal((await f.store().listConnections('creator')).length,2);assert.equal((await f.store().get('deployment','a')).clientId,'client-a');});
