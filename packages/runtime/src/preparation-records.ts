import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import type {ContentPreparationStore,CreatorRecord,HostRecord,PersistenceTransaction,UbeeqRepositories} from '@ubeeq/persistence';

type Scope={instanceId:string;cellId:string;region:string};
type Home=Pick<CreatorRecord,'homeCellId'|'dataHomeRegion'|'dataHomeAssignedAt'|'routingRevision'>;
type Suffix='draft'|'operation'|'receipt'|'preset'|'preset-version';
const suffixes:Suffix[]=['draft','operation','receipt','preset','preset-version'];
const namespace='runtime-content-preparation';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity=(instance:string,creator:string,suffix:Suffix,category:'node'|'value',key:string)=>'preparation-'+hash([instance,creator,suffix,category,key]);
const home=(creator:CreatorRecord):Home=>({homeCellId:creator.homeCellId,dataHomeRegion:creator.dataHomeRegion,dataHomeAssignedAt:creator.dataHomeAssignedAt,routingRevision:creator.routingRevision});
type Directory={schemaVersion:1;suffix:Suffix;type:'leaf';ids:string[]}|{schemaVersion:1;suffix:Suffix;type:'branch';children:string[]};
type Staged={id:string;creatorId:string;suffix:Suffix;key:string;category:'node'|'value';home:Home;before?:HostRecord;after?:Record<string,unknown>};
type Context={transaction:PersistenceTransaction;phase:'open'|'closing'|'closed';rollbackOnly:boolean;rows:Map<string,Staged>;roots:Set<string>;creators:Map<string,CreatorRecord>};

export class PreparationRecordError extends Error {
 constructor(readonly code:'preparation_migration_required'|'preparation_state_invalid'|'preparation_too_large'|'access_denied',message:string){super(message);}
}
const invalid=()=>new PreparationRecordError('preparation_state_invalid','Content preparation storage requires reconciliation.');
const serializable=(value:unknown):Record<string,unknown>=>{
 const encoded=JSON.stringify(value);
 if(!encoded||Buffer.byteLength(encoded)>300*1024)throw new PreparationRecordError('preparation_too_large','This preparation record exceeds its safe storage size.');
 const decoded:unknown=JSON.parse(encoded);
 if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw invalid();
 return decoded as Record<string,unknown>;
};

/** Trusted new-Creator preparation, called in the actual creation transaction.
 * Existing/imported Creators need an explicit complete-inventory migration.
 * No API read or absent index can establish an empty preparation history. */
export async function prepareNewCreatorPreparationRecords(repositories:UbeeqRepositories,creator:CreatorRecord,transaction:PersistenceTransaction):Promise<void>{
 if(!repositories.hostRecords?.checkRevision||!repositories.creators.checkRevision)throw Error('Preparation storage requires conditional repository guards.');
 const current=await repositories.creators.get(creator.id,{transaction});
 if(!current||current.instanceId!==creator.instanceId||current.revision!==creator.revision||current.subjectId!==creator.subjectId
   ||current.homeCellId!==creator.homeCellId||current.dataHomeRegion!==creator.dataHomeRegion
   ||current.routingRevision!==creator.routingRevision||current.dataHomeAssignedAt!==creator.dataHomeAssignedAt)throw invalid();
 for(const suffix of suffixes){
  await repositories.hostRecords.create({id:identity(creator.instanceId,creator.id,suffix,'node',''),instanceId:creator.instanceId,...home(creator),namespace,scopeId:creator.id,key:JSON.stringify([suffix,'node','']),
   value:{schemaVersion:1,suffix,type:'leaf',ids:[]}}, {transaction});
 }
}

/** Coordinator records share canonical repository transactions. Point-read
 * directory tries provide complete inventory without relying on a GSI. Each
 * writer increments its kind root, fencing missing records and pagination.
 * Leaves split at 64 IDs, so receipt history has no single growing ID aggregate.
 *
 * The host still authenticates the actor and guards current permissions inside
 * run(). This adapter enforces instance/cell/Creator custody, not user roles.
 * Only this adapter (or an explicit fenced migration) may write its namespace. */
export class RepositoryPreparationRecords implements ContentPreparationStore {
 readonly supportsConditionalTransactions=true;
 private readonly context=new AsyncLocalStorage<Context>();
 constructor(private readonly repositories:UbeeqRepositories,private readonly scope:Scope){
  if((['instanceId','cellId','region'] as const).some(key=>typeof scope?.[key]!=='string'||!scope[key].trim()))throw Error('Preparation storage requires an explicit instance, cell and region.');
  if(!repositories.hostRecords?.checkRevision||!repositories.creators.checkRevision)throw Error('Preparation storage requires conditional repository guards.');
 }
 async run<T>(operation:(transaction:{id:string})=>Promise<T>):Promise<T>{
  const inherited=this.context.getStore();
  if(inherited){
   if(inherited.phase!=='open')throw Error('Preparation transaction context has ended.');
   try{return await operation(inherited.transaction);}catch(error){inherited.rollbackOnly=true;throw error;}
  }
  let owned:Context|undefined;
  try{return await this.repositories.transaction(transaction=>{
   const state:Context={transaction,phase:'open',rollbackOnly:false,rows:new Map(),roots:new Set(),creators:new Map()};owned=state;
   return this.context.run(state,async()=>{
    const value=await operation(transaction);
    if(state.rollbackOnly)throw Error('Preparation transaction cannot commit after a failed nested operation.');
    state.phase='closing';await this.flush();return value;
   });
  });}finally{if(owned)owned.phase='closed';}
 }
 /** Used by the canonical-content bridge and trusted host checks to join writes. */
 transaction():PersistenceTransaction|undefined{const state=this.context.getStore();return state?.phase==='open'?state.transaction:undefined;}
 private active():Context{const context=this.context.getStore();if(!context||context.phase==='closed')throw Error('An active preparation transaction is required.');return context;}
 private parse(kind:string):{creatorId:string;suffix:Suffix}{
  const prefix=`content-workflow:${this.scope.instanceId}:`;
  if(typeof kind!=='string'||!kind.startsWith(prefix))throw new PreparationRecordError('access_denied','Preparation instance access denied.');
  const [creatorId,suffix,...extra]=kind.slice(prefix.length).split(':');
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(creatorId)||extra.length||!suffixes.includes(suffix as Suffix))throw invalid();
  return {creatorId,suffix:suffix as Suffix};
 }
 private async creator(creatorId:string):Promise<CreatorRecord>{
  const state=this.active(),cached=state.creators.get(creatorId);if(cached)return cached;
  const creator=await this.repositories.creators.get(creatorId,{transaction:state.transaction});
  if(!creator||creator.instanceId!==this.scope.instanceId||creator.homeCellId!==this.scope.cellId||creator.dataHomeRegion!==this.scope.region
    ||'deletion' in creator&&creator.deletion||'status' in creator&&creator.status!==undefined&&creator.status!=='active')throw new PreparationRecordError('access_denied','Preparation Creator access denied.');
  state.creators.set(creatorId,creator);return creator;
 }
 private async row(creatorId:string,suffix:Suffix,category:'node'|'value',key:string):Promise<Staged>{
  const state=this.active(),id=identity(this.scope.instanceId,creatorId,suffix,category,key),cached=state.rows.get(id);if(cached)return cached;
  const creator=await this.creator(creatorId),before=await this.repositories.hostRecords!.get(id,{transaction:state.transaction});
  const storageKey=JSON.stringify([suffix,category,key]);
  if(before&&(before.instanceId!==this.scope.instanceId||before.homeCellId!==this.scope.cellId||before.dataHomeRegion!==this.scope.region
    ||before.routingRevision!==creator.routingRevision||before.dataHomeAssignedAt!==creator.dataHomeAssignedAt
    ||before.namespace!==namespace||before.scopeId!==creatorId||before.key!==storageKey))throw invalid();
  const row:Staged={id,creatorId,suffix,key:storageKey,category,home:home(creator),before};state.rows.set(id,row);return row;
 }
 private value(row:Staged):Record<string,unknown>|undefined{return row.after??row.before?.value;}
 private directory(row:Staged):Directory{
  const value=this.value(row);
  if(!value||value.schemaVersion!==1||value.suffix!==row.suffix)throw invalid();
  if(value.type==='leaf'){
   const path=JSON.parse(row.key)[2] as string;
   if(!Array.isArray(value.ids)||value.ids.length>64||value.ids.some(id=>typeof id!=='string'||!id||!hash(id).startsWith(path))||new Set(value.ids).size!==value.ids.length)throw invalid();
  }else if(value.type==='branch'){
   if(!Array.isArray(value.children)||!value.children.length||value.children.some(key=>typeof key!=='string'||!/^[0-9a-f]$/.test(key))||new Set(value.children).size!==value.children.length)throw invalid();
  }else throw invalid();
  return structuredClone(value) as Directory;
 }
 private async root(creatorId:string,suffix:Suffix):Promise<Staged>{
  const root=await this.row(creatorId,suffix,'node','');
  if(!root.before&&!root.after)throw new PreparationRecordError('preparation_migration_required','Review this Creator’s preparation storage migration before enabling the shared workflow.');
  this.directory(root);this.active().roots.add(root.id);return root;
 }
 private async insert(creatorId:string,suffix:Suffix,path:string,id:string,digest:string):Promise<void>{
  const row=await this.row(creatorId,suffix,'node',path),directory=this.directory(row);
  if(directory.type==='branch'){
   const key=digest[path.length];if(!key)throw invalid();
   if(!directory.children.includes(key)){
    const child=await this.row(creatorId,suffix,'node',path+key);if(child.before||child.after)throw invalid();
    child.after={schemaVersion:1,suffix,type:'leaf',ids:[]};directory.children.push(key);directory.children.sort();row.after=serializable(directory);
   }
   return this.insert(creatorId,suffix,path+key,id,digest);
  }
  if(directory.ids.includes(id))return;
  directory.ids.push(id);
  if(directory.ids.length<=64){row.after=serializable(directory);return;}
  if(path.length>=64)throw invalid();
  const groups=new Map<string,string[]>();
  for(const member of directory.ids){const key=hash(member)[path.length],ids=groups.get(key)??[];ids.push(member);groups.set(key,ids);}
  row.after={schemaVersion:1,suffix,type:'branch',children:[...groups.keys()].sort()};
  for(const [key,ids] of groups){
   const child=await this.row(creatorId,suffix,'node',path+key);if(child.before||child.after)throw invalid();
   child.after={schemaVersion:1,suffix,type:'leaf',ids:[]};
   for(const member of ids)await this.insert(creatorId,suffix,path+key,member,hash(member));
  }
 }
 private async ids(creatorId:string,suffix:Suffix,path:string,seen:Set<string>):Promise<string[]>{
  if(path.length>64||seen.has(path))throw invalid();seen.add(path);
  const directory=this.directory(await this.row(creatorId,suffix,'node',path));
  if(directory.type==='leaf')return directory.ids;
  const nested=await Promise.all(directory.children.map(key=>this.ids(creatorId,suffix,path+key,seen)));
  return nested.flat();
 }
 private async contains(creatorId:string,suffix:Suffix,id:string):Promise<boolean>{
  const digest=hash(id);let path='';
  for(;;){
   const directory=this.directory(await this.row(creatorId,suffix,'node',path));
   if(directory.type==='leaf')return directory.ids.includes(id);
   const key=digest[path.length];if(!key)throw invalid();
   if(!directory.children.includes(key))return false;path+=key;
  }
 }
 async get(kind:string,id:string):Promise<any>{
  return this.run(async()=>{const {creatorId,suffix}=this.parse(kind);await this.root(creatorId,suffix);const included=await this.contains(creatorId,suffix,id),value=this.value(await this.row(creatorId,suffix,'value',id));if(included!==Boolean(value)||value&&!Object.hasOwn(value,'payload'))throw invalid();return value?structuredClone(value.payload):undefined;});
 }
 async list(kind:string):Promise<any[]>{
  return this.run(async()=>{
   const {creatorId,suffix}=this.parse(kind);await this.root(creatorId,suffix);const ids=await this.ids(creatorId,suffix,'',new Set());
   if(new Set(ids).size!==ids.length)throw invalid();
   const result=[];
   for(const id of ids.sort()){
    const value=this.value(await this.row(creatorId,suffix,'value',id));if(!value||!Object.hasOwn(value,'payload'))throw invalid();result.push(structuredClone(value.payload));
   }
   return result;
  });
 }
 async put(kind:string,id:string,value:unknown):Promise<void>{
  await this.run(async()=>{
   if(typeof id!=='string'||!id||id.length>400)throw invalid();
   const {creatorId,suffix}=this.parse(kind),root=await this.root(creatorId,suffix);
   const row=await this.row(creatorId,suffix,'value',id),included=await this.contains(creatorId,suffix,id);
   if(included!==Boolean(this.value(row)))throw invalid();
   // The outer transaction flushes each row once, retaining read-your-writes.
   root.after=serializable(this.value(root));
   await this.insert(creatorId,suffix,'',id,hash(id));
   row.after=serializable({payload:value});if(!Object.hasOwn(row.after,'payload'))throw invalid();
  });
 }
 private async flush():Promise<void>{
  // Canonical writes can depend on read-only preparation state. Retain its
  // custody and kind-root conditions even when this adapter stages no writes.
  const state=this.active();
  for(const creator of state.creators.values())await this.repositories.creators.checkRevision!(creator.id,creator.revision,{transaction:state.transaction});
  for(const id of state.roots){
   const root=state.rows.get(id)!;
   if(!root.after)await this.repositories.hostRecords!.checkRevision!(root.id,root.before!.revision,{transaction:state.transaction});
  }
  for(const row of state.rows.values())if(row.after){
   const value=serializable(row.after);
   if(row.before)await this.repositories.hostRecords!.update(row.id,row.before.revision,{value},{transaction:state.transaction});
   else await this.repositories.hostRecords!.create({id:row.id,instanceId:this.scope.instanceId,...row.home,namespace,scopeId:row.creatorId,key:row.key,value},{transaction:state.transaction});
  }
 }
}
