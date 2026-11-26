/** Transaction port shared by preparation drafts, canonical changes and durable intents.
 * Reads inside run must be serialized locally or guarded by compare-and-swap at
 * hosted commit. Implementations must roll back all joined writes on failure.
 * Never implement this port as an unguarded read followed by an unconditional put.
 */
export interface ContentPreparationStore {
  readonly supportsConditionalTransactions?: boolean;
  run<T>(operation:(transaction:{id:string})=>Promise<T>):Promise<T>;
  get(kind:string,id:string):Promise<any>;
  list(kind:string):Promise<any[]>;
  put(kind:string,id:string,value:unknown):Promise<void>;
}
export function requireContentPreparationStore(store:ContentPreparationStore|undefined):ContentPreparationStore {
  if(!store?.supportsConditionalTransactions)throw Error('Conditional preparation transactions are unavailable.');
  return store;
}
