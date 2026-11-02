import {AsyncLocalStorage} from 'node:async_hooks';
import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {GetCommand,PutCommand,DeleteCommand,QueryCommand,UpdateCommand,TransactWriteCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {CommerceError,type CommerceRecords,type CommerceTransaction,type RecordBase} from '@ubeeq/commerce';
import {PayPalError,type PayPalConnection,type PayPalConnectionAudit,type PayPalScope,type PayPalConnectionStore} from '@ubeeq/integrations';

type State={records:Record<string,Record<string,unknown>>;uniques:Record<string,string>;connections:Record<string,PayPalConnection>;audits:Array<PayPalConnectionAudit&{connectionId:string}>};
const empty=():State=>({records:{},uniques:{},connections:{},audits:[]});
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Atomic encrypted snapshots, chunked below DynamoDB's item limit. No aggregate commerce size quota.
 * The revision pointer is the commit point; staged chunks are never visible before CAS.
 * A synchronous domain transaction currently loads one deployment's state. Hosts with
 * higher transaction volume can provide an indexed CommerceStore using the same contract.
 */
export class DynamoCommerceStore implements PayPalConnectionStore {
 private readonly context=new AsyncLocalStorage<{key:string;token:string;valid:boolean}>();
 private readonly encryptionKey:Buffer;
 private readonly pk:string;private readonly p:string;private readonly s:string;
 constructor(readonly deploymentId:string,private readonly client:Pick<DynamoDBDocumentClient,'send'>,private readonly tableName:string,key:string,keys:{partition?:string;sort?:string}={}){
  if(!deploymentId||!tableName||key.length<32)throw new CommerceError('commerce_storage_configuration_required');
  this.encryptionKey=createHash('sha256').update('commerce-state:'+key).digest();this.pk='COMMERCE#'+deploymentId;this.p=keys.partition??'pk';this.s=keys.sort??'sk';
 }
 close(){}
 private key(sk:string){return {[this.p]:this.pk,[this.s]:sk};}
 private async head(){const r=await this.client.send(new GetCommand({TableName:this.tableName,Key:this.key('HEAD'),ConsistentRead:true}));return r.Item as {revision:number;prefix:string;parts:number;checksum:string}|undefined;}
 private seal(state:State){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.encryptionKey,iv);const bytes=Buffer.concat([cipher.update(JSON.stringify(state)),cipher.final()]);return JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:bytes.toString('base64')});}
 private open(value:string):State{const v=JSON.parse(value),d=createDecipheriv('aes-256-gcm',this.encryptionKey,Buffer.from(v.iv,'base64'));d.setAuthTag(Buffer.from(v.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(v.data,'base64')),d.final()]).toString());}
 private async rows(prefix:string){const rows:Record<string,any>[]=[];let cursor:Record<string,any>|undefined;do{const r=await this.client.send(new QueryCommand({TableName:this.tableName,KeyConditionExpression:'#p=:p AND begins_with(#s,:s)',ExpressionAttributeNames:{'#p':this.p,'#s':this.s},ExpressionAttributeValues:{':p':this.pk,':s':prefix},ConsistentRead:true,ExclusiveStartKey:cursor}));rows.push(...r.Items??[]);cursor=r.LastEvaluatedKey;}while(cursor);return rows;}
 private async load(){
  for(let attempt=0;attempt<4;attempt++){
   const head=await this.head();if(!head)return {revision:0,state:empty()};
   const rows=await this.rows(head.prefix),parts=rows.sort((a,b)=>a.part-b.part),value=parts.map(r=>r.value).join('');
   if(parts.length===head.parts&&digest(value)===head.checksum)return {revision:head.revision,state:this.open(value)};
   // Another commit may have collected the old snapshot during this read.
   if((await this.head())?.revision===head.revision)throw new CommerceError('commerce_storage_unavailable',503);
  }throw new CommerceError('commerce_busy',409);
 }
 private async mutate<T>(operation:(state:State)=>T):Promise<T>{
  for(let attempt=0;attempt<8;attempt++){
   const {revision,state}=await this.load(),before=JSON.stringify(state),result=operation(state);
   if(result&&typeof (result as any).then==='function')throw new CommerceError('async_commerce_transaction_forbidden');
   if(JSON.stringify(state)===before){await this.assertFence();return result;}
   const value=this.seal(state),prefix=`DATA#${String(revision+1).padStart(16,'0')}#${randomUUID()}#`,parts=Math.ceil(value.length/180000);
   const staged:string[]=[];
   try{
    for(let part=0;part<parts;part++){const sk=prefix+String(part).padStart(8,'0');await this.client.send(new PutCommand({TableName:this.tableName,Item:{...this.key(sk),part,value:value.slice(part*180000,(part+1)*180000)},ConditionExpression:'attribute_not_exists(#p)',ExpressionAttributeNames:{'#p':this.p}}));staged.push(sk);}
    const context=this.context.getStore();if(context&&!context.valid)throw new PayPalError('connection_lock_lost');
    await this.client.send(new TransactWriteCommand({TransactItems:[{Put:{TableName:this.tableName,Item:{...this.key('HEAD'),revision:revision+1,prefix,parts,checksum:digest(value)},ConditionExpression:revision?'#r=:r':'attribute_not_exists(#r)',ExpressionAttributeNames:{'#r':'revision'},...(revision?{ExpressionAttributeValues:{':r':revision}}:{})}},...(context?[{ConditionCheck:{TableName:this.tableName,Key:this.key(context.key),ConditionExpression:'#t=:t AND #e>=:now',ExpressionAttributeNames:{'#t':'token','#e':'expires'},ExpressionAttributeValues:{':t':context.token,':now':Date.now()}}}]:[])]}));
    // Retention removals erase previous encrypted snapshots as well as logical data.
    // Only older revisions are collected, never a concurrent writer's staging area.
    await this.collect(revision+1).catch(()=>{});return result;
   }catch(error){
    const name=(error as {name?:string}).name;
    if(name!=='TransactionCanceledException'&&name!=='ConditionalCheckFailedException')throw error;
    await Promise.all(staged.map(sk=>this.client.send(new DeleteCommand({TableName:this.tableName,Key:this.key(sk)})).catch(()=>{})));
    await this.assertFence();
   }
  }throw new CommerceError('commerce_busy',409);
 }
 private async collect(_revision:number){const head=await this.head();if(!head)return;for(const row of await this.rows('DATA#')){const sk=String(row[this.s]),revision=Number(sk.split('#')[1]);if(revision<=head.revision&&!sk.startsWith(head.prefix))await this.client.send(new DeleteCommand({TableName:this.tableName,Key:this.key(sk)}));}}
 async transaction<T>(operation:(tx:CommerceTransaction)=>T):Promise<T>{return this.mutate(state=>{
  let active=true;const check=()=>{if(!active)throw new CommerceError('commerce_transaction_ended');};
  const get:CommerceTransaction['get']=(kind,id)=>{check();return structuredClone(state.records[kind]?.[id]) as any;};
  const validate=(record:RecordBase)=>{check();if(record.deploymentId!==this.deploymentId||!record.id||!record.ownerId||!['sandbox','live'].includes(record.environment))throw new CommerceError('foreign_commerce_scope',403);};
  const tx:CommerceTransaction={get,list:kind=>{check();return Object.values(state.records[kind]??{}).sort((a:any,b:any)=>a.id.localeCompare(b.id)).map(r=>structuredClone(r)) as any;},insert:(kind,record,uniques=[])=>{validate(record);if(get(kind,record.id)||uniques.some(k=>state.uniques[kind+':'+k]))throw new CommerceError('commerce_unique_conflict',409);(state.records[kind]??={})[record.id]=structuredClone(record);for(const k of uniques)state.uniques[kind+':'+k]=record.id;},put:(kind,record)=>{validate(record);const previous=get(kind,record.id);if(previous&&(previous.ownerId!==record.ownerId||previous.environment!==record.environment))throw new CommerceError('foreign_commerce_scope',403);(state.records[kind]??={})[record.id]=structuredClone(record);},remove:(kind,id)=>{check();delete state.records[kind]?.[id];for(const k of Object.keys(state.uniques))if(k.startsWith(kind+':')&&state.uniques[k]===id)delete state.uniques[k];}};
  try{return operation(tx);}finally{active=false;}
 });}
 private scope(scope:PayPalScope){if(scope.deploymentId!==this.deploymentId)throw new PayPalError('foreign_deployment');return JSON.stringify([scope.deploymentId,scope.ownerId,scope.environment]);}
 private async assertFence(){const c=this.context.getStore();if(!c)return;const r=await this.client.send(new GetCommand({TableName:this.tableName,Key:this.key(c.key),ConsistentRead:true}));if(!c.valid||r.Item?.token!==c.token||r.Item.expires<Date.now())throw new PayPalError('connection_lock_lost');}
 async withLock<T>(scope:PayPalScope,operation:()=>Promise<T>):Promise<T>{
  const key='LOCK#'+digest(this.scope(scope)),existing=this.context.getStore();if(existing?.key===key){await this.assertFence();return operation();}
  const token=randomUUID();try{await this.client.send(new PutCommand({TableName:this.tableName,Item:{...this.key(key),token,expires:Date.now()+60000},ConditionExpression:'attribute_not_exists(#t) OR #e<:now',ExpressionAttributeNames:{'#t':'token','#e':'expires'},ExpressionAttributeValues:{':now':Date.now()}}));}catch(error){if((error as Error).name==='ConditionalCheckFailedException')throw new PayPalError('connection_busy');throw error;}
  const context={key,token,valid:true};let renewal:Promise<void>=Promise.resolve();
  const timer=setInterval(()=>{renewal=renewal.then(async()=>{await this.client.send(new UpdateCommand({TableName:this.tableName,Key:this.key(key),UpdateExpression:'SET #e=:e',ConditionExpression:'#t=:t AND #e>=:now',ExpressionAttributeNames:{'#e':'expires','#t':'token'},ExpressionAttributeValues:{':e':Date.now()+60000,':now':Date.now(),':t':token}}));}).catch(()=>{context.valid=false;});},15000);timer.unref?.();
  try{return await this.context.run(context,operation);}finally{clearInterval(timer);await renewal;await this.client.send(new DeleteCommand({TableName:this.tableName,Key:this.key(key),ConditionExpression:'#t=:t',ExpressionAttributeNames:{'#t':'token'},ExpressionAttributeValues:{':t':token}})).catch(()=>{});}
 }
 async find(scope:PayPalScope){this.scope(scope);const matches=Object.values((await this.load()).state.connections).filter(c=>c.ownerId===scope.ownerId&&c.environment===scope.environment&&!c.drainingUntil);return matches.length===1?matches[0]:undefined;}
 async get(deploymentId:string,id:string){if(deploymentId!==this.deploymentId)return undefined;return (await this.load()).state.connections[id];}
 async listConnections(ownerId?:string){return Object.values((await this.load()).state.connections).filter(c=>!ownerId||c.ownerId===ownerId);}
 async connectionAudits(ownerId:string){const {state}=await this.load();return state.audits.filter(a=>state.connections[a.connectionId]?.ownerId===ownerId).map(({connectionId,...a})=>a);}
 async purgeConnectionAudits(before:string){await this.mutate(state=>{state.audits=state.audits.filter(a=>a.at>=before);});}
 private requireLock(record:PayPalConnection){if(this.context.getStore()?.key!=='LOCK#'+digest(this.scope(record)))throw new PayPalError('connection_lock_required');}
 async save(record:PayPalConnection,expectedRevision:number,audit:PayPalConnectionAudit){this.requireLock(record);await this.mutate(state=>{const previous=state.connections[record.id];if(previous&&(previous.ownerId!==record.ownerId||previous.environment!==record.environment))throw new PayPalError('connection_revision_conflict');if(record.revision!==expectedRevision+1||(previous?.revision??0)!==expectedRevision)throw new PayPalError('connection_revision_conflict');if(Object.values(state.connections).some(c=>c.id!==record.id&&c.ownerId===record.ownerId&&c.environment===record.environment&&!c.drainingUntil&&c.clientId===record.clientId))throw new PayPalError('connection_revision_conflict');state.connections[record.id]=structuredClone(record);state.audits.push({...audit,connectionId:record.id});});}
 async archive(record:PayPalConnection,deadline:string,audit:PayPalConnectionAudit){this.requireLock(record);await this.mutate(state=>{const old=state.connections[record.id];if(old?.revision!==record.revision)throw new PayPalError('connection_revision_conflict');state.connections[record.id]={...record,drainingUntil:deadline,acceptsCheckouts:false,revision:record.revision+1};state.audits.push({...audit,connectionId:record.id});});}
 async countUnconfirmedOrders(connection:PayPalConnection){return this.transaction(tx=>tx.list('checkout').filter(o=>o.connectionId===connection.id&&(!['completed','failed'].includes(o.state)||(o.billing&&!['CANCELLED','EXPIRED'].includes(o.subscriptionState??'')))).length);}
 async acceptEvent(input:Parameters<PayPalConnectionStore['acceptEvent']>[0]):Promise<'accepted'|'duplicate'>{if(input.connection.deploymentId!==this.deploymentId)throw new PayPalError('foreign_deployment');return this.transaction(tx=>{const id=digest(JSON.stringify([input.connection.id,input.connection.environment,input.eventId]));if(tx.get('event',id))return 'duplicate';const base={deploymentId:this.deploymentId,ownerId:input.connection.ownerId,environment:input.connection.environment,id,createdAt:input.receivedAt,updatedAt:input.receivedAt};tx.insert('event',{...base,connectionId:input.connection.id,eventId:input.eventId,eventType:input.eventType,verification:'verified',attempts:0,payload:Buffer.from(input.rawBody).toString(),payloadExpiresAt:new Date(Date.parse(input.receivedAt)+30*86400000).toISOString(),state:'pending'},[id]);tx.insert('job',{...base,kind:'event',referenceId:id,state:'pending',attempts:0,dueAt:input.receivedAt});return 'accepted';});}
}
