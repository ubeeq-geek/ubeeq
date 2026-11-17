import {AsyncLocalStorage} from 'node:async_hooks';
import type {CellOwnedRecord,HostRecord,UbeeqRepositories} from '@ubeeq/persistence';
import type {StoredObject,UploadAdapter} from '@ubeeq/storage';

/** Internal correlation only. Neither an observation token nor retired output
 * evidence grants Source access, quota, physical work, or a completed result. */
interface Attempt {active:boolean}
interface Binding {
  repositories:UbeeqRepositories;uploads:UploadAdapter;
  journal:HostRecord;object:StoredObject;actorId:string;
}
interface Preparation {attempt:Attempt;binding:Binding;active:boolean;retiredError?:object}
const preparations=new AsyncLocalStorage<Preparation>();
const attempts=new WeakSet<Attempt>();
const retired=new WeakMap<object,Preparation>();
const object=(value:unknown):value is object=>value!==null&&(typeof value==='object'||typeof value==='function');
const sameHome=(a:CellOwnedRecord,b:CellOwnedRecord)=>a.homeCellId===b.homeCellId&&a.dataHomeRegion===b.dataHomeRegion&&a.dataHomeAssignedAt===b.dataHomeAssignedAt&&a.routingRevision===b.routingRevision;

export function sourceCompletionAttempt():Attempt {const attempt={active:true};attempts.add(attempt);return attempt;}
export function endSourceCompletionAttempt(attempt:Attempt):void {attempt.active=false;}
export async function sourceCompletionPreparation<T>(attempt:Attempt,binding:Binding,operation:()=>Promise<T>):Promise<T>{
  if(!attempts.has(attempt)||!attempt.active)throw Error('The actual Source completion attempt ended.');
  const frame:Preparation={attempt,binding:{...binding,journal:structuredClone(binding.journal),object:structuredClone(binding.object)},active:true};
  return preparations.run(frame,async()=>{
    try{return await operation();}
    catch(error){if(object(error)&&frame.retiredError===error)retired.set(error,frame);throw error;}
    finally{frame.active=false;}
  });
}
/** Capture at the real Owned.write entry. Detached calls cannot join a later
 * preparation, and adapters/repositories/home cannot be substituted. */
export function captureSourceCompletionPreparation(repositories:UbeeqRepositories,uploads:UploadAdapter,creatorId:string,home:CellOwnedRecord):Preparation|undefined{
  const frame=preparations.getStore(),binding=frame?.binding;
  if(!frame||!frame.active||!frame.attempt.active||!binding||binding.repositories!==repositories||binding.uploads!==uploads||binding.journal.scopeId!==creatorId||!sameHome(binding.journal,home))return;
  return frame;
}
/** Called only after the Owned journal's actual retired-generation proof. */
export function recordRetiredOwnedError(frame:Preparation|undefined,error:unknown):void{
  if(frame&&frame===preparations.getStore()&&frame.active&&frame.attempt.active&&object(error))frame.retiredError=error;
}
export function hasRetiredOwnedError(attempt:Attempt,error:unknown):boolean{
  if(!object(error)||!attempts.has(attempt)||!attempt.active)return false;
  const frame=retired.get(error);
  return !!frame&&frame.attempt===attempt&&!frame.active&&frame.retiredError===error;
}
export function consumeRetiredOwnedError(attempt:Attempt,error:unknown):boolean{
  if(!hasRetiredOwnedError(attempt,error)||!object(error))return false;
  const frame=retired.get(error)!;
  retired.delete(error);frame.retiredError=undefined;return true;
}
