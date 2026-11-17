import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {OptimisticConcurrencyError,type RetainedContentAtomic} from '@ubeeq/persistence';
import {PublicationImageError} from '@ubeeq/core';
import type {RetainedContentTransport} from './retained-creator-content.js';
import type {UpdateCommandInput,UpdateCommandOutput,ScanCommandInput,ScanCommandOutput} from '@aws-sdk/lib-dynamodb';

export interface RetainedDynamoAtomicTransport extends RetainedContentTransport {
 update(input:UpdateCommandInput):Promise<UpdateCommandOutput>;
 scan(input:ScanCommandInput):Promise<ScanCommandOutput>;
}
export interface RetainedDynamoAtomicClient extends RetainedDynamoAtomicTransport {
 /** Forward other host commands only outside every accepting transaction scope. */
 unmanaged<T>(operation:()=>Promise<T>):Promise<T>;
}
export interface DynamoRetainedContentBindings<P> { publicationItem(value:P):Record<string,unknown>; }
const clone=<T>(value:T):T=>structuredClone(value);

type Item=Record<string,any>;
type Entry={table:string;key:Item;before:Item|undefined;after?:Item;written?:boolean;checks:any[]};
type Context={id:string;phase:'open'|'closing'|'closed';rollbackOnly:boolean;pending:number;items:Map<string,Entry>};
const assertOpen=(state:Context|undefined)=>{if(state&&state.phase!=='open')throw Error('This Publication transaction has ended. Start a new operation outside its callback.');};
const identity=(table:string,key:Item)=>JSON.stringify([table,Object.entries(key).sort(([a],[b])=>a.localeCompare(b))]);

/** Shares the product's actual client and tables. Strong reads become commit-time
 * guards; existing repository transactions join the same bounded DynamoDB commit.
 * Network/provider work belongs outside run().
 */
export function createDynamoRetainedContentAtomic<P>(base:RetainedDynamoAtomicTransport,table:string,tenant:string,bindings:DynamoRetainedContentBindings<P>):{atomic:RetainedContentAtomic<P>;client:RetainedDynamoAtomicClient} {
 for(const kind of ['get','put','delete','update','query','scan','transactWrite'] as const)if(typeof base?.[kind]!=='function')throw Error('Retained DynamoDB transactions require their actual transport.');
 if(!table?.trim()||!tenant?.trim()||typeof bindings?.publicationItem!=='function')throw Error('Retained DynamoDB transactions require a table, tenant and publication mapping.');
 const context=new AsyncLocalStorage<Context>();
 const epochKey={PK:`TENANT#${tenant}#PUBLICATION_POLICY`,SK:'EPOCH'};
 const dependency=(write:any)=>{const input=write.Put??write.Delete??write.Update,item=input?.Item,key=item??input?.Key;if(!key||key.PK===epochKey.PK)return false;return /(?:WORK|ASSET|CREATOR|PUBLICATION|EXTERNAL_ACCOUNT|EXTERNAL_COLLECTION|INTEGRATION_REVIEW|USER_PROFILE|PLATFORM_ROLE|COLLECTION|GROUPING)/.test(item?.entityType??`${key.PK}#${key.SK}`)&&!/LEASE|REFRESH_LOCK|SYNC_JOB|SYNC_LOG|PUBLICATION_COMMAND/.test(`${key.PK}#${key.SK}`);};
 const epochWrite={Update:{TableName:table,Key:epochKey,UpdateExpression:'ADD #epoch :one',ExpressionAttributeNames:{'#epoch':'version'},ExpressionAttributeValues:{':one':1}}};
 const read=async(tableName:string,key:Item)=>{const state=context.getStore(),id=identity(tableName,key);assertOpen(state);if(state?.items.has(id))return state.items.get(id)!;
  const response=await base.get({TableName:tableName,Key:key,ConsistentRead:true});assertOpen(state);const entry:Entry={table:tableName,key,before:response.Item,checks:[]};state?.items.set(id,entry);return entry;};
 const stage=async(write:any)=>{const type=write.Put?'Put':write.Delete?'Delete':write.ConditionCheck?'ConditionCheck':undefined;if(!type)throw Error('Publication commands require full conditional records, not partial updates.');const input=write[type],key=input.Key??{PK:input.Item.PK,SK:input.Item.SK},entry=await read(input.TableName,key);
  assertOpen(context.getStore());
  // Conditions on the original record join its CAS. Subsequent staged rewrites
  // have already read and validated the transaction overlay in product code.
  if(input.ConditionExpression&&(!entry.written||type==='ConditionCheck'))entry.checks.push(input);
  if(type!=='ConditionCheck'){entry.after=type==='Put'?clone(input.Item):undefined;entry.written=true;}
  if(dependency(write)){const epoch=await read(table,epochKey);epoch.after={...epochKey,version:(epoch.before?.version??0)+1};epoch.written=true;}
 };
 const send=async(command:{kind:keyof RetainedDynamoAtomicTransport|'unmanaged';input:any;unmanaged?:()=>Promise<any>})=>{
  const state=context.getStore();if(!state){
   const writes=command.kind==='transactWrite'?command.input.TransactItems:command.kind==='put'?[{Put:command.input}]:command.kind==='delete'?[{Delete:command.input}]:command.kind==='update'?[{Update:command.input}]:undefined;
   if(writes?.some(dependency)){
    if(writes.length>=100)throw Error('Reserve one transaction slot for the Publication policy fence.');
    const prepared=writes.map((entry:any)=>{const kind=entry.Put?'Put':entry.Delete?'Delete':entry.Update?'Update':undefined;if(!kind)return entry;const {ReturnValues,ReturnConsumedCapacity,ReturnItemCollectionMetrics,...input}=entry[kind];return {[kind]:input};});
    const result=await base.transactWrite({...command.kind==='transactWrite'?command.input:{},TransactItems:[...prepared,epochWrite]});
    if(command.kind==='update'&&command.input.ReturnValues&&command.input.ReturnValues!=='NONE'){const readback=await base.get({TableName:command.input.TableName,Key:command.input.Key,ConsistentRead:true});return {Attributes:readback.Item};}return result;
   }return command.kind==='unmanaged'?command.unmanaged!():base[command.kind](command.input);
  }
  assertOpen(state);state.pending++;
  try{
  if(command.kind==='get'){const entry=await read(command.input.TableName!,command.input.Key!);return {Item:clone(entry.written?entry.after:entry.before)};}
  if(command.kind==='query'){
   // Secondary indexes can omit a newly added membership even before this
   // transaction begins. During command acceptance use the primary table,
   // with the tenant policy epoch guarding changes across scan pages. This is
   // deliberately conservative until a strongly consistent reverse index exists.
   const response=command.input.IndexName?await base.scan({TableName:command.input.TableName,ConsistentRead:true,FilterExpression:command.input.KeyConditionExpression,ExpressionAttributeNames:command.input.ExpressionAttributeNames,ExpressionAttributeValues:command.input.ExpressionAttributeValues,ExclusiveStartKey:command.input.ExclusiveStartKey,Limit:command.input.Limit}):await base.query({...command.input,ConsistentRead:true});const rows:Item[]=[];
   for(const item of response.Items??[]){const entry=await read(command.input.TableName!,{PK:item.PK,SK:item.SK});const row=entry.written?entry.after:entry.before;if(row)rows.push(clone(row));}
   // Include newly staged records in the exact primary-partition queries used
   // by compatibility preparation and the outbox; indexes remain discovery only.
   if(!command.input.IndexName){const pk=command.input.ExpressionAttributeValues?.[':pk'],prefix=command.input.ExpressionAttributeValues?.[':prefix']??command.input.ExpressionAttributeValues?.[':sk'];for(const entry of state.items.values()){const after=entry.after;if(entry.table===command.input.TableName&&entry.written&&after&&after.PK===pk&&(prefix===undefined||typeof prefix==='string'&&after.SK.startsWith(prefix))&&!rows.some(r=>r.PK===after.PK&&r.SK===after.SK))rows.push(clone(after));}}
   return {...response,Items:rows};}
  if(command.kind==='put'){await stage({Put:command.input});return {};}
  if(command.kind==='delete'){await stage({Delete:command.input});return {};}
  if(command.kind==='transactWrite'){for(const write of command.input.TransactItems??[])await stage(write);return {};}
  throw Error('Unsupported database operation inside a Publication transaction.');
  }catch(error){state.rollbackOnly=true;throw error;}finally{state.pending--;}
 };
 const client:RetainedDynamoAtomicClient={
  get:input=>send({kind:'get',input}),put:input=>send({kind:'put',input}),delete:input=>send({kind:'delete',input}),
  update:input=>send({kind:'update',input}),query:input=>send({kind:'query',input}),scan:input=>send({kind:'scan',input}),
  transactWrite:input=>send({kind:'transactWrite',input}),unmanaged:operation=>send({kind:'unmanaged',input:undefined,unmanaged:operation})
 };
 const run=async<T>(fn:(tx:{id:string})=>Promise<T>):Promise<T>=>{const inherited=context.getStore();if(inherited){
  assertOpen(inherited);inherited.pending++;
  try{return await fn(inherited);}catch(error){inherited.rollbackOnly=true;throw error;}finally{inherited.pending--;}
 }
  const state:Context={id:randomUUID(),phase:'open',rollbackOnly:false,pending:0,items:new Map()};
  return context.run(state,async()=>{try{await read(table,epochKey);const value=await fn(state);
   if(state.rollbackOnly)throw Error('Publication transaction failed; all changes must roll back.');
   if(state.pending)throw Error('Await every Publication transaction operation before completing its callback.');
   state.phase='closing';
   if(![...state.items.values()].some(e=>e.written))return value;
   if(state.items.size>100)throw Error('Publication transaction exceeds 100 guarded records. Split the batch.');
   const TransactItems=[...state.items.values()].map(entry=>{
    const names:Item={},values:Item={},conditions:string[]=[];let index=0;
    if(!entry.before){if(entry.key.PK!==undefined)conditions.push('attribute_not_exists(PK)');else for(const field of Object.keys(entry.key)){const name=`#r${index++}`;names[name]=field;conditions.push(`attribute_not_exists(${name})`);}}else for(const field of new Set([...Object.keys(entry.before),...Object.keys(entry.after??{}),'imageSelection','configurationRevision','unresolvedImageContext','activeOperationId','command','lastConfirmedImage','status','deletion','deletedAt','archivedAt','restricted','uploadState','replacedByAssetId','connectionStatus','externalUserId','creatorIdentityId','primaryCreatorIdentityId','revision'])){const name=`#r${index}`,val=`:r${index++}`;names[name]=field;if(entry.before[field]===undefined)conditions.push(`attribute_not_exists(${name})`);else{values[val]=entry.before[field];conditions.push(`${name} = ${val}`);}}
    entry.checks.forEach((check,c)=>{const rename=(text:string)=>text.replace(/#[A-Za-z0-9_]+|:[A-Za-z0-9_]+/g,key=>`${key[0]}c${c}_${key.slice(1)}`);conditions.push(`(${rename(check.ConditionExpression)})`);for(const [k,v] of Object.entries(check.ExpressionAttributeNames??{}))names[rename(k)]=v;for(const [k,v] of Object.entries(check.ExpressionAttributeValues??{}))values[rename(k)]=v;});
    const guard={TableName:entry.table,ConditionExpression:conditions.join(' AND '),...(Object.keys(names).length?{ExpressionAttributeNames:names}:{}),...(Object.keys(values).length?{ExpressionAttributeValues:values}:{})};
    return entry.written?entry.after?{Put:{...guard,Item:entry.after}}:{Delete:{...guard,Key:entry.key}}:{ConditionCheck:{...guard,Key:entry.key}};
   });
   if(Buffer.byteLength(JSON.stringify(TransactItems))>4*1024*1024||TransactItems.some(entry=>Buffer.byteLength((entry.Put??entry.Delete??entry.ConditionCheck)!.ConditionExpression??'')>4096))throw new PublicationImageError('publication_reconciliation_required','This Publication bundle exceeds a hosted transaction limit. Reduce its dependencies before approval.');
   try{await base.transactWrite({TransactItems});}catch(e){if((e as Error).name==='TransactionCanceledException'&&(!(e as any).CancellationReasons||(e as any).CancellationReasons.some((r:any)=>r.Code==='ConditionalCheckFailed')))throw new OptimisticConcurrencyError('publication-bundle',0);throw e;}return value;
  }finally{state.phase='closed';}
  });
 };
 const key=(kind:string,id:string)=>({PK:`TENANT#${tenant}#PUBLICATION_COMMAND#${kind}`,SK:id});
 const atomic:RetainedContentAtomic<P>={supportsConditionalTransactions:true,run,active:()=>context.getStore()?.phase==='open',
  get:async(kind,id)=>{const r=await client.get({TableName:table,Key:key(kind,id),ConsistentRead:true});return r.Item?.value;},
  list:async kind=>{const items:any[]=[];let cursor:Item|undefined;do{const response=await client.query({TableName:table,KeyConditionExpression:'PK = :pk',ExpressionAttributeValues:{':pk':key(kind,'').PK},ConsistentRead:true,ExclusiveStartKey:cursor});items.push(...(response.Items??[]).map((r:any)=>r.value));cursor=response.LastEvaluatedKey;}while(cursor);return items;},
  put:async(kind,id,value)=>{await client.put({TableName:table,Item:{...key(kind,id),value}});},
  savePublication:async p=>{await client.put({TableName:table,Item:bindings.publicationItem(p)});}};
 return {atomic,client};
}
