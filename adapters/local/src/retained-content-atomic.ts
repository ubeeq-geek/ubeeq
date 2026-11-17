import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {OptimisticConcurrencyError,type RetainedContentAtomic} from '@ubeeq/persistence';

export interface SqliteRetainedContentBindings<P> {
 /** Actual host arrays; existing SQLite names and JSON records are preserved. */
 fields:readonly string[];
 /** Joins run() using the same watched authority, never an external side effect. */
 savePublication(value:P):Promise<void>;
 recover?():void;
}
const clone=<T>(value:T):T=>structuredClone(value);

export function installSqliteRetainedContentAtomic<P>(store:object,path:string,bindings:SqliteRetainedContentBindings<P>):RetainedContentAtomic<P> {
 if(!bindings?.fields?.length||bindings.fields.some(field=>typeof field!=='string'||!field)||new Set(bindings.fields).size!==bindings.fields.length||typeof bindings.savePublication!=='function')throw Error('Retained SQLite transactions require explicit state fields and a publication writer.');
 const recover=bindings.recover;
 type Transaction={id:string;active:boolean;readOnly:boolean;rollbackOnly:boolean;pending:number;before:Map<string,string>;mutated:Set<string>};
 const target=store as any,db=new DatabaseSync(path),context=new AsyncLocalStorage<Transaction>();
 db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS publication_product_state(name TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS publication_command_records(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));');
 const names=bindings.fields;
 const save=db.prepare('INSERT INTO publication_product_state(name,payload) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload');
 const version=db.prepare('PRAGMA data_version'),persisted=new Map<string,string>();
 let dataVersion=-1,hydrating=false;
 const refresh=()=>{const next=Number((version.get() as {data_version:number}).data_version);if(next===dataVersion)return;
  hydrating=true;try{for(const row of db.prepare('SELECT name,payload FROM publication_product_state').all() as {name:string;payload:string}[]){target[row.name]=JSON.parse(row.payload);persisted.set(row.name,row.payload);}dataVersion=next;}finally{hydrating=false;}
 };
 db.exec('BEGIN IMMEDIATE');try{for(const name of names)if(Array.isArray(target[name])&&!db.prepare('SELECT 1 FROM publication_product_state WHERE name=?').get(name))save.run(name,JSON.stringify(target[name]));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');db.close();throw e;}
 refresh();
 if(recover){db.exec('BEGIN IMMEDIATE');try{recover();for(const name of names)if(Array.isArray(target[name])){const payload=JSON.stringify(target[name]);save.run(name,payload);persisted.set(name,payload);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');db.close();throw e;}}
 // Cache the hydrated authority until another SQLite connection changes it.
 // Capture only arrays touched by a write, before their first access/mutation.
 const values=new Map<string,any[]>(),arrays=new WeakMap<any[],Set<string>>();
 const capture=(name:string,mutated=false)=>{if(hydrating)return;const state=context.getStore();if(!state?.active)throw Error('Durable local state mutations require a store command or publicationAtomic.run().');
  if(mutated)state.mutated.add(name);
  state.readOnly=false;if(!state.before.has(name))state.before.set(name,persisted.get(name)??'[]');
 };
 const watch=(value:any[],name:string)=>{let owners=arrays.get(value);if(!owners){owners=new Set();arrays.set(value,owners);const fields=owners;
   for(const method of ['push','pop','shift','unshift','splice','sort','reverse','copyWithin','fill'] as const)Object.defineProperty(value,method,{configurable:true,writable:true,enumerable:false,value:function(this:any[],...args:any[]){if(this===value)for(const field of fields)if(values.get(field)===value)capture(field,true);return Reflect.apply(Array.prototype[method],this,args);}});
  }owners.add(name);return value;
 };
 for(const name of names)if(Array.isArray(target[name])){const value=target[name];values.set(name,watch(value,name));Object.defineProperty(target,name,{configurable:true,enumerable:true,
  get:()=>{const state=context.getStore();if(!hydrating&&state?.active&&!state.readOnly)capture(name);return values.get(name);},
  set:value=>{capture(name,true);values.set(name,Array.isArray(value)?watch(value,name):value);}});
 }
 let tail=Promise.resolve();
 const run=async<T>(fn:(tx:{id:string})=>Promise<T>,readOnly=false):Promise<T>=>{
  const inherited=context.getStore();if(inherited){
   if(!inherited.active)throw Error('This Publication transaction has ended. Start a new operation outside its callback.');
   if(!readOnly)inherited.readOnly=false;inherited.pending++;
   try{return await fn(inherited);}catch(error){inherited.rollbackOnly=true;throw error;}finally{inherited.pending--;}
  }
  const previous=tail;let release!:()=>void;tail=new Promise<void>(resolve=>{release=resolve;});await previous;
  // A busy queue of already-resolved store promises must still let HTTP/timers run.
  await new Promise<void>(resolve=>setImmediate(resolve));
  let began=false;const state:Transaction={id:randomUUID(),active:true,readOnly,rollbackOnly:false,pending:0,before:new Map(),mutated:new Set()};
  try{
   db.exec(readOnly?'BEGIN':'BEGIN IMMEDIATE');began=true;refresh();
   const value=await context.run(state,()=>fn(state)),changed=new Map<string,string>(),detached=new Map<string,any[]>();
   if(state.rollbackOnly)throw Error('Publication transaction failed; all changes must roll back.');
   if(state.pending)throw Error('Await every Publication transaction operation before completing its callback.');
   state.active=false;
   for(const [name,before] of state.before){
    const payload=JSON.stringify(values.get(name));
    if(payload!==before){
     if(readOnly&&(db.prepare('SELECT payload FROM publication_product_state WHERE name=?').get(name) as {payload:string}|undefined)?.payload!==before)throw new OptimisticConcurrencyError(`local-state:${name}`,0);
     save.run(name,payload);changed.set(name,payload);
    }
    // Caller-owned write arguments must not become mutable aliases of the cache.
    if(payload!==before||state.mutated.has(name))detached.set(name,JSON.parse(payload));
   }
   db.exec('COMMIT');began=false;
   for(const [name,payload] of changed)persisted.set(name,payload);
   for(const [name,value] of detached)values.set(name,watch(value,name));
   return value;
  }
  catch(e){if(began){db.exec('ROLLBACK');hydrating=true;try{for(const [name,payload] of state.before)target[name]=JSON.parse(payload);}finally{hydrating=false;}}throw e;}finally{state.active=false;release();}
 };
 // Keep existing public store methods authoritative, including legacy observers and
 // migration writers. No command depends on a later state.json checkpoint.
 const methods=new Map<string,Function>();let prototype=target;
 while(prototype&&prototype!==Object.prototype){for(const name of Object.getOwnPropertyNames(prototype)){if(name==='constructor'||methods.has(name))continue;const descriptor=Object.getOwnPropertyDescriptor(prototype,name);if(typeof descriptor?.value==='function')methods.set(name,descriptor.value);}prototype=Object.getPrototypeOf(prototype);}
 for(const [name,method] of methods)if(method.constructor.name==='AsyncFunction'){const readOnly=/^(get|list|has|find|count|page|is|can)[A-Z]/.test(name)&&!/^getOrCreate/.test(name);target[name]=(...args:any[])=>{const detached=!context.getStore()?.active;return run(async()=>{const value=await Reflect.apply(method,target,args);return detached?clone(value):value;},readOnly);};}
 const atomic:RetainedContentAtomic<P>={supportsConditionalTransactions:true,run,active:()=>context.getStore()?.active===true,
  get:async(kind,id)=>run(async()=>{const row=db.prepare('SELECT payload FROM publication_command_records WHERE kind=? AND id=?').get(kind,id) as {payload:string}|undefined;return row?JSON.parse(row.payload):undefined;},true),
  list:async kind=>run(async()=>(db.prepare('SELECT payload FROM publication_command_records WHERE kind=? ORDER BY id').all(kind) as {payload:string}[]).map(r=>JSON.parse(r.payload)),true),
  put:async(kind,id,value)=>run(async()=>{db.prepare('INSERT INTO publication_command_records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(kind,id,JSON.stringify(value));}),
  savePublication:async value=>run(()=>bindings.savePublication(clone(value))),
  close:()=>db.close()};
 target.publicationAtomic=atomic;return atomic;
}
