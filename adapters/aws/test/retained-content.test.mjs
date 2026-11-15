import test from 'node:test';
import assert from 'node:assert/strict';
import {DynamoRetainedCreatorContent} from '../dist/index.js';

const transport=()=>({get:async()=>({}),query:async()=>({}),put:async()=>({}),delete:async()=>({}),transactWrite:async()=>({})});
const bindings=()=>({getRestore:async()=>null,commitRestore:async()=>{throw Error('Restore is deliberately outside this fixture');},aliasWrites:()=>[],validateAssetAttachment:()=>{},validateDisclosureHistory:()=>{},validatePublicationProjection:()=>{}});
test('retained repositories require every real transport and host binding',()=>{
 for(const key of Object.keys(transport())){const incomplete=transport();delete incomplete[key];assert.throws(()=>new DynamoRetainedCreatorContent(incomplete,'table',bindings()),/actual transport/);}
 for(const key of Object.keys(bindings())){const incomplete=bindings();delete incomplete[key];assert.throws(()=>new DynamoRetainedCreatorContent(transport(),'table',incomplete),/actual host bindings/);}
});
test('the retained writer preserves rich Work values and its separate publication state',async()=>{
 const captured=[],connection=transport(),host=bindings();connection.transactWrite=async input=>{captured.push(structuredClone(input));return{};};
 const aliases=[];host.aliasWrites=(table,row)=>{aliases.push({table,row:structuredClone(row)});return[];};
 const repository=new DynamoRetainedCreatorContent(connection,'table',host);
 const work={tenantId:'tenant',creatorId:'creator',workId:'saved-work',kind:'mixed',title:'Retained',slug:'retained',slugHistory:['first','retained'],tags:['saved'],status:'ready',revision:8,createdAt:'2001-01-01T00:00:00.000Z',updatedAt:'2002-01-01T00:00:00.000Z',contentRating:'general',aiDisclosure:'none',heavyTopics:[],origin:{type:'local'},body:[{blockId:'saved',type:'paragraph',text:'Original writing'}],fieldMetadata:{shared:{noAi:true},overrides:[]},opaqueProductSettings:{retain:['exact',true]}};
 await repository.createWork(work);let saved=captured[0].TransactItems.find(row=>row.Put).Put.Item;
 for(const [key,value] of Object.entries(work))assert.deepEqual(saved[key],value);
 assert.equal(saved.PK,'TENANT#tenant#WORK#saved-work');assert.equal(saved.SK,'PROFILE');assert.equal(saved.status,'ready');
 const revised={...work,revision:9,title:'Updated',updatedAt:'2003-01-01T00:00:00.000Z'};await repository.commitWorkRevision(revised,8);
 saved=captured[1].TransactItems.find(row=>row.Put).Put.Item;for(const [key,value] of Object.entries(revised))assert.deepEqual(saved[key],value);
 assert.equal(captured[1].TransactItems[0].Put.ExpressionAttributeValues[':previous'],8);assert.ok(captured.every(command=>command.TransactItems.some(row=>row.ConditionCheck?.Key.PK==='CREATOR#creator')));
 assert.equal(aliases.length,2);assert.equal(aliases[1].row.status,'ready');
});
